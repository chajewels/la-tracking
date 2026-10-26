/**
 * Timesheet → Payslips — pure rules, no I/O (owner-confirmed plan 2026-10-26; docs/PAYSLIPS.md).
 *
 * The live preview is built here from timesheetEngine.computeMonth and
 * commissionEngine.computeMonth; nothing is stored until Finalize, and the
 * database (finalize_payslip, migration 20270201100000_staff_payslips.sql)
 * re-checks every figure and keeps known keys only. Lines, totals and the
 * Excel rows of an issued payslip come from its STORED figures.
 */
import * as XLSX from 'xlsx';
import type { MonthComputation, TemplateType, TimesheetProfile } from '@/lib/timesheetEngine';
import type { AgentMonthResult, MonthlyComputation } from '@/lib/commissionEngine';

export const COMPANY_NAME = 'Ｃｈａ　Ｊｅｗｅｌｓ株式会社';
export const PAYSLIP_PROOF_BUCKET = 'payslip-proofs';
/** finalize_payslip refuses months before this one. */
export const FIRST_PAY_MONTH = '2026-06';

export type PayslipStatus = 'finalized' | 'paid' | 'void';

export interface CsrTimesheetFigures {
  days_worked: number;
  total_hours: number;
  daily_pay_sum: number;
  basic_salary: number;
  capped_gross: number;
  monthly_allowance: number;
  forfeited_weeks: number;
  allowance_paid: number;
  net: number;
}

export interface LiveAdminTimesheetFigures {
  days_at_500: number;
  days_at_300: number;
  total_hours: number;
  net: number;
}

export type TimesheetFigures = CsrTimesheetFigures | LiveAdminTimesheetFigures;

export interface CommissionFigures {
  role_won: string | null;
  earnings: number;
  top_sales_tier: 0 | 1 | 2;
  top_sales_bonus: number;
  total: number;
}

export interface PayslipFigures {
  timesheet: TimesheetFigures;
  commission: CommissionFigures;
  timesheet_net_php: number;
  commission_php: number;
  total_php: number;
}

export interface Payslip {
  id: string;
  user_id: string;
  pay_month: string; // YYYY-MM-01
  status: PayslipStatus;
  staff_name: string;
  address: string;
  date_of_birth: string;
  job_title: string | null;
  template_type: TemplateType;
  timesheet: Record<string, unknown>;
  commission: Record<string, unknown>;
  timesheet_net_php: number;
  commission_php: number;
  total_php: number;
  jpy_sent: number | null;
  php_received: number | null;
  php_per_jpy: number | null;
  paid_on: string | null;
  proof_path: string | null;
  finalized_at: string;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

export interface PayrollDetails {
  user_id: string;
  address: string | null;
  date_of_birth: string | null;
}

export interface PayslipBook {
  month: string;
  php_jpy_rate: number | null;
  payslips: Payslip[];
  details: PayrollDetails[];
}

export type PayslipBookState = { available: false } | { available: true; book: PayslipBook };

export const PAYSLIP_BOOK_KEY = ['payslip-book'] as const;

// ── Money ───────────────────────────────────────────────────────────────────

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100 + Number.EPSILON) / 100;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** ₱ with comma separators; drops .00 on whole numbers, keeps 2 decimals otherwise (CLAUDE.md display rules). */
export function formatPeso(n: number): string {
  const r = round2(n);
  const whole = Number.isInteger(r);
  const text = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `${r < 0 ? '-' : ''}₱${text}`;
}

export function formatYen(n: number): string {
  return `¥${Math.round(n).toLocaleString('en-US')}`;
}

/** Yen to send for a peso total: JPY = PHP ÷ rate (CLAUDE.md currency standard — divide, never multiply). */
export function defaultYenSent(totalPhp: number, rate: number | null): number | null {
  if (!rate || rate <= 0 || !(totalPhp > 0)) return null;
  return Math.round(totalPhp / rate);
}

/** The actual remittance rate: pesos received per yen sent (what record_payslip_payment stores). */
export function actualRate(phpReceived: number, jpySent: number): number | null {
  if (!(phpReceived > 0) || !(jpySent > 0)) return null;
  return Math.round((phpReceived / jpySent) * 1e6) / 1e6;
}

// ── Building the figures (live draft) ───────────────────────────────────────

export function buildTimesheetFigures(
  template: TemplateType,
  m: MonthComputation,
  profile: Pick<TimesheetProfile, 'basic_salary' | 'allowance'>,
): TimesheetFigures {
  const total_hours = round2(m.total_hours);
  if (template === 'csr') {
    const capped_gross = round2(m.gross);
    const allowance_paid = round2(m.allowance_paid);
    return {
      days_worked: m.days.filter(d => d.inMonth && d.salary > 0).length,
      total_hours,
      daily_pay_sum: round2(m.days.reduce((s, d) => s + d.salary, 0)),
      basic_salary: round2(profile.basic_salary ?? 0),
      capped_gross,
      monthly_allowance: round2(profile.allowance ?? 0),
      forfeited_weeks: Math.min(m.forfeitedWeeks, 4),
      allowance_paid,
      net: round2(capped_gross + allowance_paid),
    };
  }
  // Every row of the 31-row window counts toward a Live Admin's pay (docs/TIMESHEET-SPEC.md),
  // so the day counts span the window too: 500 × days_at_500 + 300 × days_at_300 = net.
  const days_at_500 = m.days.filter(d => d.salary === 500).length;
  const days_at_300 = m.days.filter(d => d.salary === 300).length;
  return { days_at_500, days_at_300, total_hours, net: 500 * days_at_500 + 300 * days_at_300 };
}

export const NO_COMMISSION: CommissionFigures = {
  role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0,
};

/** The agent row of a staff member, matched by commission_agents.user_id → agent name. */
export function findAgentResult(
  comp: MonthlyComputation | null,
  agentName: string | null,
): AgentMonthResult | null {
  if (!comp || !agentName) return null;
  const key = agentName.trim().toLowerCase();
  return comp.agents.find(a => a.canonicalKey === key) ?? null;
}

export function buildCommissionFigures(
  comp: MonthlyComputation | null,
  agent: AgentMonthResult | null,
): CommissionFigures {
  if (!agent) return { ...NO_COMMISSION };
  const earnings = round2(agent.earn);
  const top_sales_bonus = round2(agent.bonus);
  const tier: 0 | 1 | 2 = agent.isTopSales ? 1 : agent.isTopSales2 ? 2 : 0;
  const roleLabel = agent.wonRole
    ? (comp?.roles.find(r => r.key === agent.wonRole)?.label ?? agent.wonRole)
    : null;
  return {
    role_won: roleLabel,
    earnings,
    top_sales_tier: top_sales_bonus > 0 ? tier : 0,
    top_sales_bonus: tier === 0 ? 0 : top_sales_bonus,
    total: round2(earnings + (tier === 0 ? 0 : top_sales_bonus)),
  };
}

export function buildFigures(timesheet: TimesheetFigures, commission: CommissionFigures): PayslipFigures {
  const timesheet_net_php = round2(timesheet.net);
  const commission_php = round2(commission.total);
  return { timesheet, commission, timesheet_net_php, commission_php, total_php: round2(timesheet_net_php + commission_php) };
}

/** The finalize_payslip payload (the server copies name, details, job title and template itself). */
export function finalizePayload(f: PayslipFigures): Record<string, unknown> {
  return {
    timesheet: f.timesheet,
    commission: f.commission,
    timesheet_net_php: f.timesheet_net_php,
    commission_php: f.commission_php,
    total_php: f.total_php,
  };
}

/** True when the live total no longer matches the stored payslip (more than half a centavo apart). */
export function figuresChanged(storedTotal: number, liveTotal: number): boolean {
  return Math.abs(round2(storedTotal) - round2(liveTotal)) >= 0.005;
}

// ── Lines (display + Excel) ─────────────────────────────────────────────────

export interface Line { label: string; value: string }

function hours(n: number): string {
  return round2(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function timesheetLines(template: TemplateType, t: Record<string, unknown>): Line[] {
  if (template === 'csr') {
    return [
      { label: 'Days worked', value: String(num(t.days_worked)) },
      { label: 'Total hours', value: hours(num(t.total_hours)) },
      { label: 'Sum of daily pay (before cap)', value: formatPeso(num(t.daily_pay_sum)) },
      { label: 'Basic salary cap', value: formatPeso(num(t.basic_salary)) },
      { label: 'Gross pay (capped)', value: formatPeso(num(t.capped_gross)) },
      { label: 'Monthly allowance', value: formatPeso(num(t.monthly_allowance)) },
      { label: 'Weeks forfeited (allowance)', value: String(num(t.forfeited_weeks)) },
      { label: 'Allowance paid', value: formatPeso(num(t.allowance_paid)) },
      { label: 'Timesheet net pay', value: formatPeso(num(t.net)) },
    ];
  }
  return [
    { label: 'Days at ₱500', value: String(num(t.days_at_500)) },
    { label: 'Days at ₱300', value: String(num(t.days_at_300)) },
    { label: 'Total hours', value: hours(num(t.total_hours)) },
    { label: 'Timesheet net pay', value: formatPeso(num(t.net)) },
  ];
}

export function commissionLines(c: Record<string, unknown>): Line[] {
  const total = num(c.total);
  if (total <= 0) return [{ label: 'Commission', value: 'No commission this month' }];
  const tier = num(c.top_sales_tier);
  const lines: Line[] = [
    { label: 'Role won', value: typeof c.role_won === 'string' && c.role_won ? c.role_won : '—' },
    { label: 'Earnings', value: formatPeso(num(c.earnings)) },
  ];
  if (tier > 0) lines.push({ label: `Top Sales ${tier} bonus`, value: formatPeso(num(c.top_sales_bonus)) });
  lines.push({ label: 'Commission total', value: formatPeso(total) });
  return lines;
}

// ── Months and dates ────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

/** 'YYYY-MM' (or 'YYYY-MM-DD') → 'September 2026'. */
export function longMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

export function payslipTitle(monthKey: string): string {
  return `Payslip — ${longMonthLabel(monthKey)}`;
}

/** 'YYYY-MM-DD' → '14 Mar 1995'. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '—';
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

export function todayTokyo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(now);
}

export function canIssueForMonth(monthKey: string): boolean {
  return monthKey >= FIRST_PAY_MONTH;
}

// ── Status / which payslip a row shows ──────────────────────────────────────

export type RowStatus = 'not_issued' | PayslipStatus;

export const STATUS_LABEL: Record<RowStatus, string> = {
  not_issued: 'Not issued', finalized: 'Finalized', paid: 'Paid', void: 'Void',
};

/** The payslip a staff row shows: the live (non-void) one, else the latest void one, else none. */
export function currentPayslip(payslips: Payslip[], userId: string): Payslip | null {
  const mine = payslips.filter(p => p.user_id === userId);
  const live = mine.find(p => p.status !== 'void');
  if (live) return live;
  return mine.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

// ── Staff details ───────────────────────────────────────────────────────────

export function detailsComplete(d: PayrollDetails | null | undefined): boolean {
  return !!(d && d.address && d.address.trim() && d.date_of_birth);
}

export function validateDetails(address: string, dob: string, today: string = todayTokyo()): string | null {
  if (address.trim().length > 500) return 'The address is over 500 characters.';
  if (dob) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return 'Enter the date of birth as a date.';
    if (dob < '1900-01-01') return 'The date of birth is before 1900.';
    if (dob > today) return 'The date of birth is in the future.';
  }
  return null;
}

// ── Payment ─────────────────────────────────────────────────────────────────

export interface PaymentForm {
  jpySent: string;
  phpReceived: string;
  paidOn: string;
}

export function validatePayment(f: PaymentForm, payMonth: string, today: string = todayTokyo()): string | null {
  if (!/^\d+$/.test(f.jpySent.trim()) || Number(f.jpySent) <= 0) return 'Enter the yen sent as a whole number above 0.';
  if (Number(f.jpySent) > 100_000_000) return 'The yen sent is too large.';
  if (!/^\d+(\.\d{1,2})?$/.test(f.phpReceived.trim()) || Number(f.phpReceived) <= 0) {
    return 'Enter the pesos received (up to 2 decimals) above 0.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.paidOn)) return 'Enter the date the money was received.';
  if (f.paidOn > today) return 'The paid-on date is in the future.';
  if (f.paidOn < payMonth.slice(0, 10)) return 'The paid-on date is before the pay month.';
  return null;
}

export const PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;

const PROOF_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
};

/** The file's type, falling back to its extension (browsers often report '' for .heic). */
export function proofContentType(file: { type: string; name?: string }): string {
  if (file.type) return file.type;
  const ext = (file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  return PROOF_TYPE_BY_EXT[ext] ?? '';
}

export function proofProblem(file: { type: string; size: number; name?: string } | null): string | null {
  if (!file) return 'Attach the proof of payment.';
  if (!PROOF_TYPES.includes(proofContentType(file))) return 'The proof can be a photo (JPG, PNG, WebP, HEIC) or a PDF.';
  if (file.size > PROOF_MAX_BYTES) return 'The proof is over 10 MB.';
  return null;
}

/** <payslip_id>/<timestamp>-<safe name>: the only shape record_payslip_payment accepts. */
export function proofPath(payslipId: string, fileName: string, now: number = Date.now()): string {
  const safe = fileName.normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-80) || 'proof';
  return `${payslipId}/${now}-${safe}`;
}

// ── Refusals (never show raw codes) ─────────────────────────────────────────

export function payslipRefusal(code: string | undefined): string {
  switch (code) {
    case 'permission_denied': return 'Only admin and timesheet managers can work on payslips.';
    case 'invalid_month': return 'Payslips can be issued from June 2026 up to this month.';
    case 'staff_not_found': return 'This staff member has no timesheet profile.';
    case 'already_issued': return 'A payslip for this month already exists. Void it first to issue a new one.';
    case 'name_missing': return 'This staff member has no name in Team. Add it first.';
    case 'details_missing': return 'Add address and date of birth first.';
    case 'invalid_figures':
    case 'invalid_totals': return 'The figures did not add up. Reload the page and try again.';
    case 'not_found': return 'This payslip no longer exists. Reload the page.';
    case 'not_finalized': return 'This payslip is no longer waiting for payment. Reload the page.';
    case 'invalid_jpy_sent': return 'Enter the yen sent as a whole number above 0.';
    case 'invalid_php_received': return 'Enter the pesos received (up to 2 decimals) above 0.';
    case 'invalid_paid_on': return 'The paid-on date must be between the pay month and today.';
    case 'proof_required':
    case 'proof_missing':
    case 'invalid_proof_path': return 'The proof of payment did not upload. Try again.';
    case 'reason_required': return 'Write a reason (at least 3 characters).';
    case 'already_void': return 'This payslip is already void.';
    case 'invalid_address': return 'The address is over 500 characters.';
    case 'invalid_date_of_birth': return 'The date of birth must be between 1900 and today.';
    default: return 'Something went wrong. Try again in a moment.';
  }
}

// ── Book normalising ────────────────────────────────────────────────────────

export function normaliseBook(raw: Record<string, unknown>): PayslipBook {
  const payslips = (Array.isArray(raw.payslips) ? raw.payslips : []) as Record<string, unknown>[];
  const details = (Array.isArray(raw.details) ? raw.details : []) as Record<string, unknown>[];
  const rate = raw.php_jpy_rate == null ? null : Number(raw.php_jpy_rate);
  return {
    month: String(raw.month ?? ''),
    php_jpy_rate: rate != null && Number.isFinite(rate) && rate > 0 ? rate : null,
    payslips: payslips.map(p => ({
      ...(p as unknown as Payslip),
      timesheet_net_php: num(p.timesheet_net_php),
      commission_php: num(p.commission_php),
      total_php: num(p.total_php),
      jpy_sent: p.jpy_sent == null ? null : num(p.jpy_sent),
      php_received: p.php_received == null ? null : num(p.php_received),
      php_per_jpy: p.php_per_jpy == null ? null : num(p.php_per_jpy),
      timesheet: (p.timesheet ?? {}) as Record<string, unknown>,
      commission: (p.commission ?? {}) as Record<string, unknown>,
    })),
    details: details.map(d => ({
      user_id: String(d.user_id),
      address: (d.address as string | null) ?? null,
      date_of_birth: (d.date_of_birth as string | null) ?? null,
    })),
  };
}

// ── Excel (STORED figures only) ─────────────────────────────────────────────

/** Payslip_<Name>_<YYYY-MM>.xlsx (or .pdf), the name reduced to letters, digits and _. */
export function payslipFileName(staffName: string, payMonth: string, ext: 'xlsx' | 'pdf' = 'xlsx'): string {
  const safe = staffName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Staff';
  return `Payslip_${safe}_${payMonth.slice(0, 7)}.${ext}`;
}

/** The proof's file name: everything after the first "/" of proof_path (<payslip_id>/<file>). */
export function proofFileName(proofPath: string | null | undefined): string {
  if (!proofPath) return '';
  const i = proofPath.indexOf('/');
  return i >= 0 ? proofPath.slice(i + 1) : proofPath;
}

/** "September 2026 salary ¥39,287 → ₱16,400" (paid payslips only). */
export function paymentLine(p: Pick<Payslip, 'pay_month' | 'jpy_sent' | 'php_received'>): string {
  if (p.jpy_sent == null || p.php_received == null) return 'Not paid yet';
  return `${longMonthLabel(p.pay_month)} salary ${formatYen(p.jpy_sent)} → ${formatPeso(p.php_received)}`;
}

export function payslipRows(p: Payslip, generatedOn: string = todayTokyo()): (string | number)[][] {
  const rows: (string | number)[][] = [
    [COMPANY_NAME],
    [payslipTitle(p.pay_month)],
    [],
    ['Staff name', p.staff_name],
    ['Address', p.address],
    ['Date of birth', formatDate(p.date_of_birth)],
    ['Job title', p.job_title ?? '—'],
    [],
    ['Timesheet'],
    ...timesheetLines(p.template_type, p.timesheet).map(l => [l.label, l.value]),
    [],
    ['Commission'],
    ...commissionLines(p.commission).map(l => [l.label, l.value]),
    [],
    ['Total', formatPeso(p.total_php)],
    [],
    ['Payment'],
  ];
  if (p.jpy_sent != null && p.php_received != null) {
    rows.push(
      [paymentLine(p), ''],
      ['Yen sent', formatYen(p.jpy_sent)],
      ['Pesos received', formatPeso(p.php_received)],
      ['Rate used (₱ per ¥1)', p.php_per_jpy != null ? String(p.php_per_jpy) : '—'],
      ['Paid on', formatDate(p.paid_on)],
      ['Proof of payment', proofFileName(p.proof_path) || '—'],
    );
    if (figuresChanged(p.total_php, p.php_received)) {
      rows.push(['Difference vs payslip total', formatPeso(p.php_received - p.total_php)]);
    }
  } else {
    rows.push(['Not paid yet']);
  }
  rows.push([], ['Status', STATUS_LABEL[p.status]], ['Generated', formatDate(generatedOn)]);
  return rows;
}

export function payslipWorkbook(p: Payslip, generatedOn?: string): XLSX.WorkBook {
  const ws = XLSX.utils.aoa_to_sheet(payslipRows(p, generatedOn));
  ws['!cols'] = [{ wch: 32 }, { wch: 48 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payslip');
  return wb;
}

export function downloadPayslipXlsx(p: Payslip): void {
  XLSX.writeFile(payslipWorkbook(p), payslipFileName(p.staff_name, p.pay_month));
}
