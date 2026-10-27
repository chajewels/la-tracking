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
import type { MonthComputation, PaySetting, TemplateType, TimesheetProfile } from '@/lib/timesheetEngine';
import type { AgentMonthResult, MonthlyComputation } from '@/lib/commissionEngine';
import { LEGAL_NAME_JA } from '@/lib/companyInfo';

export const COMPANY_NAME = LEGAL_NAME_JA;
export const PAYSLIP_PROOF_BUCKET = 'payslip-proofs';
/** finalize_payslip refuses months before this one (before migration 20270204100000). */
export const FIRST_PAY_MONTH = '2026-06';
/** …and before this one once it is applied (owner 2026-10-27, decision L). */
export const FIRST_PAY_MONTH_APRIL = '2026-04';

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
  /** The 2nd proof-of-payment file (migration 20270205100000; absent before it). */
  proof_path_2?: string | null;
  /** Paid outside the Hub — proof not on file (migration 20270209100000; months before June 2026 only). */
  proof_not_on_file?: boolean;
  /** Who finalized it (get_payslip_book returns the whole row). */
  finalized_by?: string | null;
  // Migration 20270204100000 (absent on payslips read before it is applied):
  employee_id?: string | null;
  hire_date?: string | null;
  cash_advances?: AdvanceSnapshot[];
  cash_advance_php?: number;
  net_pay_php?: number;
  is_final_pay?: boolean;
  cash_bond_held_php?: number;
  cash_bond_released_php?: number;
  cash_bond_source_payslip_id?: string | null;
  amount_due_php?: number;
  // Migration 20270206100000 (bonuses; absent before it). total_php includes bonus_php.
  bonuses?: BonusSnapshot[];
  bonus_php?: number;
  /** get_payslip_book: 'YYYY-MM-DD' of the payslip whose cash bond this one releases. */
  cash_bond_source_month?: string | null;
  // Migration 20270207100000 (Edit figures; absent before it):
  /** Set when the figures were typed by hand: the reason. */
  correction_reason?: string | null;
  /** The payslip this one replaces (voided "Corrected: …" in the same step). */
  corrected_from_payslip_id?: string | null;
  finalized_at: string;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}

/** One advance as frozen on a payslip (payslips.cash_advances). */
export interface AdvanceSnapshot {
  id: string;
  advance_date: string;
  amount_php: number;
  note: string;
  proof_path: string | null;
  /** The advance's 2nd proof file (migration 20270205100000). */
  proof_path_2?: string | null;
}

export type BonusCategory = 'performance' | 'holiday';

/** Bonus categories (owner 2026-10-27). The commission Top Sales bonus is separate and automatic. */
export const BONUS_CATEGORIES: { value: BonusCategory; label: string }[] = [
  { value: 'performance', label: 'Performance / KPI bonus' },
  { value: 'holiday', label: 'Holiday / Christmas bonus' },
];

export function bonusCategoryLabel(c: string): string {
  return BONUS_CATEGORIES.find(x => x.value === c)?.label ?? 'Bonus';
}

/** One bonus as frozen on a payslip (payslips.bonuses). */
export interface BonusSnapshot {
  id: string;
  bonus_date: string;
  category: BonusCategory;
  amount_php: number;
  note: string;
  proof_path: string | null;
  proof_path_2?: string | null;
}

/** One row of payslip_bonuses. */
export interface PayslipBonus extends BonusSnapshot {
  user_id: string;
  pay_month: string;
  status: 'active' | 'void';
  void_reason: string | null;
  created_at: string;
  payslip_id: string | null;
}

/** One row of payslip_cash_advances. */
export interface CashAdvance extends AdvanceSnapshot {
  user_id: string;
  pay_month: string;
  status: 'active' | 'void';
  void_reason: string | null;
  created_at: string;
  payslip_id: string | null;
}

export interface BondPending {
  source_payslip_id: string;
  pay_month: string;
  amount: number;
}

export interface PayrollDetails {
  user_id: string;
  address: string | null;
  date_of_birth: string | null;
  employee_id?: string | null;
  hire_date?: string | null;
  first_month_issued?: boolean | null;
  cash_bond_pending?: BondPending | null;
}

/** get_payslip_book "features" — present once migration 20270204100000 is applied. */
export interface PayslipFeatures {
  cash_advances: boolean;
  employee_id: boolean;
  cash_bond: boolean;
  pay_history: boolean;
  from_april: boolean;
  /** Migration 20270205100000: a 2nd proof file on the payment and on each cash advance. */
  second_proof: boolean;
  /** Migration 20270206100000: bonuses typed per month. */
  bonuses: boolean;
  /** Migration 20270207100000: Edit figures (manual correction) and the cash bond on the timesheet pay only. */
  edit_figures: boolean;
  /** Migration 20270209100000: "Proof not on file" (April–May 2026) shown on Paid payslips. */
  proof_not_on_file: boolean;
  /** Migration 20270209100000: a cash bond held before the Hub, returned on Final pay (Edit figures). */
  bond_returned: boolean;
}

export const NO_FEATURES: PayslipFeatures = {
  cash_advances: false, employee_id: false, cash_bond: false, pay_history: false, from_april: false,
  second_proof: false, bonuses: false, edit_figures: false, proof_not_on_file: false, bond_returned: false,
};

export interface PayslipBook {
  month: string;
  php_jpy_rate: number | null;
  payslips: Payslip[];
  details: PayrollDetails[];
  features: PayslipFeatures;
  cash_advances: CashAdvance[];
  /** The month's bonuses (all statuses); empty before migration 20270206100000. */
  bonuses: PayslipBonus[];
  pay_settings: PaySetting[];
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
/** The stored total WITHOUT bonuses, comparable with live timesheet + commission figures. */
export function storedFiguresTotal(p: Pick<Payslip, 'total_php' | 'bonus_php'>): number {
  return (cents(p.total_php) - cents(p.bonus_php ?? 0)) / 100;
}

export function figuresChanged(storedTotal: number, liveTotal: number): boolean {
  return Math.abs(round2(storedTotal) - round2(liveTotal)) >= 0.005;
}

// ── Edit figures (owner 2026-10-27; migration 20270207100000) ───────────────

/**
 * The lines typed in "Edit figures". The totals are recalculated from them exactly as the engines do:
 * CSR gross = min(sum of daily pay, basic salary), allowance paid = allowance × (4 − weeks forfeited) / 4,
 * net = gross + allowance paid; Live Admin net = ₱500 × days + ₱300 × days; commission total = earnings +
 * top-sales bonus.
 */
export interface FigureInputs {
  days_worked: string;
  total_hours: string;
  daily_pay_sum: string;
  basic_salary: string;
  monthly_allowance: string;
  forfeited_weeks: string;
  days_at_500: string;
  days_at_300: string;
  earnings: string;
  top_sales_bonus: string;
  /** Cash bond held, '' = as calculated. */
  cash_bond: string;
  /** Cash bond returned on Final pay (held before the Hub), '' = none. */
  cash_bond_returned: string;
}

const str = (v: unknown): string => (v == null ? '' : String(round2(num(v))));

/** The form, filled from stored figures (issued payslip) or the live draft. */
export function figureInputs(
  template: TemplateType, t: Record<string, unknown>, c: Record<string, unknown>, bond: number | null = null,
  returned: number | null = null,
): FigureInputs {
  const csr = template === 'csr';
  return {
    days_worked: csr ? str(t.days_worked) : '',
    total_hours: str(t.total_hours),
    daily_pay_sum: csr ? str(t.daily_pay_sum) : '',
    basic_salary: csr ? str(t.basic_salary) : '',
    monthly_allowance: csr ? str(t.monthly_allowance) : '',
    forfeited_weeks: csr ? str(t.forfeited_weeks) : '',
    days_at_500: csr ? '' : str(t.days_at_500),
    days_at_300: csr ? '' : str(t.days_at_300),
    earnings: str(c.earnings),
    top_sales_bonus: str(c.top_sales_bonus),
    cash_bond: bond == null ? '' : str(bond),
    cash_bond_returned: returned == null ? '' : str(returned),
  };
}

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const WHOLE_RE = /^\d+$/;

/** null when every typed line is valid (and the reason is 3–500 characters), else what to fix. */
export function validateFigureInputs(template: TemplateType, f: FigureInputs, reason: string): string | null {
  const check = (v: string, label: string, whole: boolean, max?: number): string | null => {
    const t = v.trim();
    if (!(whole ? WHOLE_RE : MONEY_RE).test(t)) {
      return whole ? `${label}: enter a whole number (0 or more).` : `${label}: enter a number (0 or more, up to 2 decimals).`;
    }
    if (max != null && Number(t) > max) return `${label}: at most ${max}.`;
    return null;
  };
  const fields: [string, string, boolean, number?][] = template === 'csr'
    ? [[f.days_worked, 'Days worked', true, 31], [f.total_hours, 'Total hours', false],
      [f.daily_pay_sum, 'Sum of daily pay', false], [f.basic_salary, 'Basic salary cap', false],
      [f.monthly_allowance, 'Monthly allowance', false], [f.forfeited_weeks, 'Weeks forfeited', true, 4]]
    : [[f.days_at_500, 'Days at ₱500', true, 31], [f.days_at_300, 'Days at ₱300', true, 31], [f.total_hours, 'Total hours', false]];
  fields.push([f.earnings, 'Commission earnings', false], [f.top_sales_bonus, 'Top sales bonus', false]);
  for (const [v, label, whole, max] of fields) {
    const e = check(v, label, whole, max);
    if (e) return e;
  }
  if (template !== 'csr' && Number(f.days_at_500) + Number(f.days_at_300) > 31) return 'Days at ₱500 and ₱300: at most 31 together.';
  if (f.cash_bond.trim() !== '') {
    const e = check(f.cash_bond, 'Cash bond', false);
    if (e) return e;
  }
  if ((f.cash_bond_returned ?? '').trim() !== '') {
    const e = check(f.cash_bond_returned, 'Cash bond returned', false);
    if (e) return e;
  }
  const r = reason.trim();
  if (r.length < 3) return 'Write the reason for the correction (at least 3 characters).';
  if (r.length > 500) return 'The reason is over 500 characters.';
  return null;
}

/** The recalculated figures from valid inputs. `base` keeps the commission role and top-sales tier. */
export function figuresFromInputs(template: TemplateType, f: FigureInputs, base: Record<string, unknown>): PayslipFigures {
  const n = (v: string) => round2(Number(v.trim()) || 0);
  let timesheet: TimesheetFigures;
  if (template === 'csr') {
    const daily = n(f.daily_pay_sum);
    const basic = n(f.basic_salary);
    const allowance = n(f.monthly_allowance);
    const weeks = Math.min(Math.trunc(n(f.forfeited_weeks)), 4);
    const capped = round2(Math.min(daily, basic));
    const paid = round2(allowance * (1 - weeks / 4));
    timesheet = {
      days_worked: Math.trunc(n(f.days_worked)), total_hours: n(f.total_hours), daily_pay_sum: daily, basic_salary: basic,
      capped_gross: capped, monthly_allowance: allowance, forfeited_weeks: weeks, allowance_paid: paid, net: round2(capped + paid),
    };
  } else {
    const a = Math.trunc(n(f.days_at_500));
    const b = Math.trunc(n(f.days_at_300));
    timesheet = { days_at_500: a, days_at_300: b, total_hours: n(f.total_hours), net: 500 * a + 300 * b };
  }
  const earnings = n(f.earnings);
  const bonus = n(f.top_sales_bonus);
  const baseTier = num(base.top_sales_tier);
  const tier: 0 | 1 | 2 = bonus > 0 ? (baseTier === 2 ? 2 : 1) : 0;
  const role = typeof base.role_won === 'string' && base.role_won.trim() ? base.role_won : null;
  return buildFigures(timesheet, { role_won: role, earnings, top_sales_tier: tier, top_sales_bonus: bonus, total: round2(earnings + bonus) });
}

/**
 * The payload of finalize_payslip (5 arguments) / correct_payslip: the figures, an optional typed bond held
 * and, on Final pay, an optional cash bond returned (held before the Hub; migration 20270209100000).
 */
export function editPayload(f: PayslipFigures, bond: string, returned = ''): Record<string, unknown> {
  const out = finalizePayload(f);
  if (bond.trim() !== '') out.cash_bond_held_php = round2(Number(bond.trim()));
  if (returned.trim() !== '' && Number(returned.trim()) > 0) out.cash_bond_returned_php = round2(Number(returned.trim()));
  return out;
}

/** PS-YYYY-MM-XXXXXX: the pay month and the first 6 hex characters of the payslip id, uppercase. */
export function payslipNumber(p: Pick<Payslip, 'id' | 'pay_month'>): string {
  const hex = p.id.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase();
  return `PS-${p.pay_month.slice(0, 7)}-${hex}`;
}

/** "Manually corrected (replaces payslip no. PS-…) — <reason>", or null for calculated figures. */
export function correctionLabel(p: Pick<Payslip, 'pay_month' | 'correction_reason' | 'corrected_from_payslip_id'>): string | null {
  if (!p.correction_reason) return null;
  const replaced = p.corrected_from_payslip_id
    ? ` (replaces payslip no. ${payslipNumber({ id: p.corrected_from_payslip_id, pay_month: p.pay_month })})` : '';
  return `Manually corrected${replaced} — ${p.correction_reason}`;
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

export function canIssueForMonth(monthKey: string, fromApril = false): boolean {
  return monthKey >= (fromApril ? FIRST_PAY_MONTH_APRIL : FIRST_PAY_MONTH);
}

/** 'YYYY-MM-DD' → '05 Oct 2026' (two-digit day; the cash-advance and paid-on lines). */
export function formatDateDD(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '—';
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

/** 'YYYY-MM' + n months → 'YYYY-MM'. */
export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
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

/** Address + date of birth, and (once the database has employee IDs) the employee ID. */
export function detailsComplete(d: PayrollDetails | null | undefined, requireEmployeeId = false): boolean {
  return !!(d && d.address && d.address.trim() && d.date_of_birth && (!requireEmployeeId || (d.employee_id ?? '').trim()));
}

export const EMPLOYEE_ID_PATTERN = /^[A-Za-z0-9-]{1,30}$/;

/** Employee ID (empty = none) and hire date (empty = none), as save_staff_payroll_details checks them. */
export function validateEmployeeDetails(employeeId: string, hireDate: string, today: string = todayTokyo()): string | null {
  const id = employeeId.trim();
  if (id && !EMPLOYEE_ID_PATTERN.test(id)) return 'The employee ID can have 1–30 letters, digits and hyphens.';
  if (hireDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return 'Enter the hire date as a date.';
    if (hireDate < '2020-01-01') return 'The hire date is before 2020.';
    const [y, m, d] = today.split('-').map(Number);
    const limit = `${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (hireDate > limit) return 'The hire date is more than a year ahead.';
  }
  return null;
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
    case 'invalid_month': return 'Payslips can be issued from April 2026 (June 2026 until the database update) up to this month.';
    case 'staff_not_found': return 'This staff member has no timesheet profile.';
    case 'already_issued': return 'A payslip for this month already exists. Void it first to issue a new one.';
    case 'name_missing': return 'This staff member has no name in Team. Add it first.';
    case 'details_missing': return 'Add employee ID, address and date of birth first.';
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
    case 'invalid_employee_id': return 'The employee ID can have 1–30 letters, digits and hyphens.';
    case 'employee_id_taken': return 'Another staff member already has this employee ID.';
    case 'invalid_hire_date': return 'The hire date must be from 2020 up to a year from today.';
    case 'pay_settings_mismatch': return 'The basic salary or allowance changed for this month. Reload the page and try again.';
    case 'cash_bond_order': return 'Finalize the first-month payslip first (it holds the cash bond).';
    case 'advance_exceeds_pay': return 'The cash advances are more than this month\'s earnings.';
    case 'month_finalized': return 'This month\'s payslip is finalized — void it to change advances.';
    case 'invalid_date': return 'The advance date must be from the 1st of last month up to today.';
    case 'invalid_amount': return 'Enter the amount in pesos (up to 2 decimals) above 0.';
    case 'note_required': return 'Write a note for the advance.';
    case 'note_too_long': return 'The note is over 200 characters.';
    case 'advance_void': return 'This advance is void.';
    case 'proof_already_attached': return 'This advance already has 2 proofs.';
    case 'not_paid': return 'Record the payment first.';
    case 'second_proof_attached': return 'This payslip already has 2 proof files.';
    case 'invalid_bonus_date': return 'The bonus date must be from April 2026 up to today.';
    case 'invalid_category': return 'Choose the bonus category.';
    case 'bonus_note_required': return 'Write a note for the bonus.';
    case 'bonus_month_finalized': return 'This month\'s payslip is finalized — void it to change bonuses.';
    case 'bonus_void': return 'This bonus is void.';
    case 'bonus_proofs_full': return 'This bonus already has 2 proofs.';
    case 'bonus_already_void': return 'This bonus is already void.';
    case 'bond_exceeds_pay': return 'The cash bond is more than what is left to pay this month. Lower it with Edit figures.';
    case 'bond_pending_in_hub': return 'A cash bond held in the Hub is waiting: it is added by itself on Final pay. Leave "Cash bond returned" empty.';
    case 'bond_already_released': return 'This payslip\'s cash bond was already released on a later payslip. Correct that later payslip first.';
    default: return 'Something went wrong. Try again in a moment.';
  }
}

// ── Book normalising ────────────────────────────────────────────────────────

/** The features of a book; all false when the database predates migration 20270204100000. */
export function bookFeatures(raw: Record<string, unknown>): PayslipFeatures {
  const f = (raw.features && typeof raw.features === 'object' ? raw.features : {}) as Record<string, unknown>;
  return {
    cash_advances: f.cash_advances === true,
    employee_id: f.employee_id === true,
    cash_bond: f.cash_bond === true,
    pay_history: f.pay_history === true,
    from_april: f.from_april === true,
    second_proof: f.second_proof === true,
    bonuses: f.bonuses === true,
    edit_figures: f.edit_figures === true,
    proof_not_on_file: f.proof_not_on_file === true,
    bond_returned: f.bond_returned === true,
  };
}

const optNum = (v: unknown): number | undefined => (v == null ? undefined : num(v));

export function normaliseBook(raw: Record<string, unknown>): PayslipBook {
  const payslips = (Array.isArray(raw.payslips) ? raw.payslips : []) as Record<string, unknown>[];
  const details = (Array.isArray(raw.details) ? raw.details : []) as Record<string, unknown>[];
  const advances = (Array.isArray(raw.cash_advances) ? raw.cash_advances : []) as Record<string, unknown>[];
  const settings = (Array.isArray(raw.pay_settings) ? raw.pay_settings : []) as Record<string, unknown>[];
  const bonuses = (Array.isArray(raw.bonuses) ? raw.bonuses : []) as Record<string, unknown>[];
  const bonusOf = (b: Record<string, unknown>): BonusSnapshot => ({
    id: String(b.id), bonus_date: String(b.bonus_date ?? ''),
    category: b.category === 'holiday' ? 'holiday' : 'performance',
    amount_php: num(b.amount_php), note: String(b.note ?? ''),
    proof_path: (b.proof_path as string | null) ?? null, proof_path_2: (b.proof_path_2 as string | null) ?? null,
  });
  const rate = raw.php_jpy_rate == null ? null : Number(raw.php_jpy_rate);
  return {
    month: String(raw.month ?? ''),
    php_jpy_rate: rate != null && Number.isFinite(rate) && rate > 0 ? rate : null,
    features: bookFeatures(raw),
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
      cash_advances: Array.isArray(p.cash_advances)
        ? (p.cash_advances as Record<string, unknown>[]).map(a => ({
          id: String(a.id), advance_date: String(a.advance_date ?? ''), amount_php: num(a.amount_php),
          note: String(a.note ?? ''), proof_path: (a.proof_path as string | null) ?? null,
          proof_path_2: (a.proof_path_2 as string | null) ?? null,
        }))
        : undefined,
      cash_advance_php: optNum(p.cash_advance_php),
      net_pay_php: optNum(p.net_pay_php),
      cash_bond_held_php: optNum(p.cash_bond_held_php),
      cash_bond_released_php: optNum(p.cash_bond_released_php),
      amount_due_php: optNum(p.amount_due_php),
      bonuses: Array.isArray(p.bonuses) ? (p.bonuses as Record<string, unknown>[]).map(bonusOf) : undefined,
      bonus_php: optNum(p.bonus_php),
    })),
    details: details.map(d => {
      const pending = d.cash_bond_pending as Record<string, unknown> | null | undefined;
      return {
        user_id: String(d.user_id),
        address: (d.address as string | null) ?? null,
        date_of_birth: (d.date_of_birth as string | null) ?? null,
        employee_id: (d.employee_id as string | null) ?? null,
        hire_date: (d.hire_date as string | null) ?? null,
        first_month_issued: d.first_month_issued == null ? null : d.first_month_issued === true,
        cash_bond_pending: pending && pending.source_payslip_id
          ? { source_payslip_id: String(pending.source_payslip_id), pay_month: String(pending.pay_month), amount: num(pending.amount) }
          : null,
      };
    }),
    cash_advances: advances.map(a => ({
      id: String(a.id), user_id: String(a.user_id), pay_month: String(a.pay_month ?? ''),
      advance_date: String(a.advance_date ?? ''), amount_php: num(a.amount_php), note: String(a.note ?? ''),
      proof_path: (a.proof_path as string | null) ?? null,
      proof_path_2: (a.proof_path_2 as string | null) ?? null, status: a.status === 'void' ? 'void' : 'active',
      void_reason: (a.void_reason as string | null) ?? null, created_at: String(a.created_at ?? ''),
      payslip_id: (a.payslip_id as string | null) ?? null,
    })),
    bonuses: bonuses.map(b => ({
      ...bonusOf(b), user_id: String(b.user_id), pay_month: String(b.pay_month ?? ''),
      status: b.status === 'void' ? 'void' : 'active', void_reason: (b.void_reason as string | null) ?? null,
      created_at: String(b.created_at ?? ''), payslip_id: (b.payslip_id as string | null) ?? null,
    })),
    pay_settings: settings.map(s => ({
      user_id: String(s.user_id), effective_from: String(s.effective_from ?? ''),
      basic_salary: s.basic_salary == null ? null : num(s.basic_salary),
      allowance: s.allowance == null ? null : num(s.allowance),
      note: (s.note as string | null) ?? null,
    })),
  };
}

// ── Cash advances, cash bond, amount due (owner 2026-10-27; migration 20270204100000) ──

/** True when the payslip was issued after migration 20270204100000 (it carries amount_due_php). */
export function hasDeductionColumns(p: Pick<Payslip, 'amount_due_php'>): boolean {
  return p.amount_due_php != null;
}

/** What the staff member receives: amount_due_php, else net_pay_php, else total_php (older payslips). */
export function amountDue(p: Pick<Payslip, 'amount_due_php' | 'net_pay_php' | 'total_php'>): number {
  return p.amount_due_php ?? p.net_pay_php ?? p.total_php;
}

const cents = (n: number) => Math.round(round2(n) * 100);

export type BondKind = 'held' | 'released' | 'none' | 'blocked';

export interface BondPreview {
  kind: BondKind;
  held: number;
  released: number;
  /** 'YYYY-MM' of the payslip whose bond is released (released only). */
  releasedFrom: string | null;
  /** 'YYYY-MM' of the first pay month (blocked only). */
  firstMonth: string | null;
}

/**
 * The cash bond finalize_payslip will decide, computed the same way for the draft preview:
 *   - the hire month holds floor(net pay / 2) to the centavo (net pay = earnings − advances; the odd
 *     centavo stays in the paid half), unless ticked "Final pay". Once migration 20270207100000 is
 *     applied (`salaryOnly`) it is floor(timesheet net / 2) instead — the salary only: commission and
 *     bonuses excluded, advances not taken off first (owner 2026-10-27 15:31);
 *   - a pending bond is released ONLY on a "Final pay" payslip (staff leaving) — never automatically the
 *     next month (owner 2026-10-27 17:54; migration 20270208100000);
 *   - a later month before the hire-month payslip exists is refused (cash_bond_order).
 * The hire month counts only from April 2026 (the first month a payslip can exist).
 */
export function bondPreview(o: {
  monthKey: string;
  totalPhp: number;
  advancesPhp: number;
  hireDate: string | null | undefined;
  firstMonthIssued: boolean | null | undefined;
  pending: BondPending | null | undefined;
  isFinalPay: boolean;
  /** The timesheet net (salary), used when `salaryOnly`. */
  timesheetNetPhp?: number;
  /** features.edit_figures: the bond is half of the salary only. */
  salaryOnly?: boolean;
}): BondPreview {
  const none: BondPreview = { kind: 'none', held: 0, released: 0, releasedFrom: null, firstMonth: null };
  const first = o.hireDate ? o.hireDate.slice(0, 7) : null;
  if (first && first >= FIRST_PAY_MONTH_APRIL && o.monthKey > first && !o.firstMonthIssued) {
    return { ...none, kind: 'blocked', firstMonth: first };
  }
  if (first && first === o.monthKey && !o.isFinalPay) {
    const base = o.salaryOnly ? cents(o.timesheetNetPhp ?? 0) : cents(o.totalPhp) - cents(o.advancesPhp);
    return { ...none, kind: 'held', held: Math.floor(Math.max(0, base) / 2) / 100 };
  }
  const p = o.pending;
  if (p && p.pay_month.slice(0, 7) < o.monthKey && o.isFinalPay) {
    return { ...none, kind: 'released', released: round2(p.amount), releasedFrom: p.pay_month.slice(0, 7) };
  }
  return none;
}

export interface PayBreakdown {
  /** Bonuses (earnings, owner 2026-10-27); included in `earnings`. */
  bonuses: { bonus_date: string; category: string; note: string; amount_php: number }[];
  bonusesTotal: number;
  earnings: number;
  advances: { advance_date: string; note: string; amount_php: number }[];
  advancesTotal: number;
  net: number;
  held: number;
  released: number;
  /** 'YYYY-MM' of the payslip whose bond is released. */
  releasedFrom: string | null;
  /** The held line's label: a typed bond (Edit figures) is not "50% held". */
  heldLabel?: string;
  /** The released line's label when it is a bond held before the Hub (no source payslip). */
  releasedLabel?: string;
  due: number;
}

/** The deductions block of an ISSUED payslip, from its stored columns (null for older payslips). */
export function storedBreakdown(p: Payslip, sourceMonth: string | null = p.cash_bond_source_month?.slice(0, 7) ?? null): PayBreakdown | null {
  if (!hasDeductionColumns(p)) return null;
  const advances = (p.cash_advances ?? []).map(a => ({ advance_date: a.advance_date, note: a.note, amount_php: a.amount_php }));
  const bonuses = (p.bonuses ?? []).map(b => ({ bonus_date: b.bonus_date, category: b.category, note: b.note, amount_php: b.amount_php }));
  return {
    bonuses,
    bonusesTotal: p.bonus_php ?? 0,
    earnings: p.total_php,
    advances,
    advancesTotal: p.cash_advance_php ?? 0,
    net: p.net_pay_php ?? p.total_php,
    held: p.cash_bond_held_php ?? 0,
    released: p.cash_bond_released_php ?? 0,
    releasedFrom: sourceMonth,
    ...(p.correction_reason ? { heldLabel: BOND_HELD_TYPED_LABEL } : {}),
    ...((p.cash_bond_released_php ?? 0) > 0 && !p.cash_bond_source_payslip_id ? { releasedLabel: BOND_RETURNED_LABEL } : {}),
    due: amountDue(p),
  };
}

/** The month's ACTIVE bonuses, in finalize order (date, then created). */
export function activeBonuses(bonuses: PayslipBonus[]): PayslipBonus[] {
  return bonuses.filter(b => b.status === 'active')
    .sort((a, b) => a.bonus_date.localeCompare(b.bonus_date) || a.created_at.localeCompare(b.created_at));
}

export function bonusesTotal(bonuses: PayslipBonus[]): number {
  return activeBonuses(bonuses).reduce((s, b) => s + cents(b.amount_php), 0) / 100;
}

/**
 * The deductions block of a DRAFT, from live figures (timesheet + commission), the month's active
 * bonuses (added to earnings, as finalize_payslip does), active advances and the bond preview.
 */
export function draftBreakdown(totalPhp: number, advances: CashAdvance[], bond: BondPreview, bonuses: PayslipBonus[] = []): PayBreakdown {
  const active = advances.filter(a => a.status === 'active')
    .sort((a, b) => a.advance_date.localeCompare(b.advance_date) || a.created_at.localeCompare(b.created_at));
  const advancesTotal = active.reduce((s, a) => s + cents(a.amount_php), 0) / 100;
  const bonusSum = bonusesTotal(bonuses);
  const earnings = (cents(totalPhp) + cents(bonusSum)) / 100;
  const net = (cents(earnings) - cents(advancesTotal)) / 100;
  return {
    bonuses: activeBonuses(bonuses).map(b => ({ bonus_date: b.bonus_date, category: b.category, note: b.note, amount_php: b.amount_php })),
    bonusesTotal: bonusSum,
    earnings,
    advances: active.map(a => ({ advance_date: a.advance_date, note: a.note, amount_php: a.amount_php })),
    advancesTotal,
    net,
    held: bond.held,
    released: bond.released,
    releasedFrom: bond.releasedFrom,
    due: (cents(net) - cents(bond.held) + cents(bond.released)) / 100,
  };
}

export const BOND_HELD_LABEL = 'Less: Cash bond — first-month pay (50% held)';
/** On a payslip with figures typed by hand the bond may be any amount (Edit figures). */
export const BOND_HELD_TYPED_LABEL = 'Less: Cash bond held';
/** A Paid payslip of April–May 2026 whose proof could not be located (migration 20270209100000). */
export const PROOF_NOT_ON_FILE = 'Paid outside the Hub — proof not on file';
/** A cash bond held before the Hub, returned on the staff member's last payslip (owner 2026-10-28). */
export const BOND_RETURNED_LABEL = 'Add: Cash bond returned (held before the Hub)';
export function bondReleasedLabel(fromMonth: string | null): string {
  return fromMonth ? `Cash bond released — ${longMonthLabel(fromMonth)}` : 'Cash bond released';
}
export function bonusLabel(b: { bonus_date: string; category: string; note: string }): string {
  return `Add: ${bonusCategoryLabel(b.category)} — ${formatDateDD(b.bonus_date)} · ${b.note}`;
}
export function advanceLabel(a: { advance_date: string; note: string }): string {
  return `Less: Cash advance — ${formatDateDD(a.advance_date)} · ${a.note}`;
}

/** The lines after the earnings: bonuses, advances, totals, net pay, cash bond, amount due / paid. */
export function breakdownLines(b: PayBreakdown, paid: boolean): Line[] {
  const lines: Line[] = b.bonuses.map(x => ({ label: bonusLabel(x), value: formatPeso(x.amount_php) }));
  lines.push(...b.advances.map(a => ({ label: advanceLabel(a), value: formatPeso(-a.amount_php) })));
  lines.push(
    { label: 'Total earnings', value: formatPeso(b.earnings) },
    { label: 'Total cash advances', value: formatPeso(b.advancesTotal) },
    { label: 'Net pay', value: formatPeso(b.net) },
  );
  if (b.held > 0) lines.push({ label: b.heldLabel ?? BOND_HELD_LABEL, value: formatPeso(-b.held) });
  if (b.released > 0) lines.push({ label: b.releasedLabel ?? bondReleasedLabel(b.releasedFrom), value: formatPeso(b.released) });
  lines.push({ label: paid ? 'Amount paid' : 'Amount due', value: formatPeso(b.due) });
  return lines;
}

// ── Cash advance form + proof ───────────────────────────────────────────────

export interface AdvanceForm { advanceDate: string; amount: string; note: string }

/** The first day an advance may be dated: the 1st of last month (Japan time). */
export function advanceDateMin(today: string = todayTokyo()): string {
  return `${addMonths(today.slice(0, 7), -1)}-01`;
}

export function validateAdvance(f: AdvanceForm, today: string = todayTokyo()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.advanceDate)) return 'Enter the date of the advance.';
  if (f.advanceDate > today) return 'The advance date is in the future.';
  if (f.advanceDate < advanceDateMin(today)) return 'The advance date must be from the 1st of last month.';
  if (!/^\d+(\.\d{1,2})?$/.test(f.amount.trim()) || Number(f.amount) <= 0) return 'Enter the amount in pesos (up to 2 decimals) above 0.';
  if (Number(f.amount) > 10_000_000) return 'The amount is too large.';
  if (!f.note.trim()) return 'Write a note for the advance.';
  if (f.note.trim().length > 200) return 'The note is over 200 characters.';
  return null;
}

/** advances/<advance id>/<timestamp>-<safe name>: the only shape attach_cash_advance_proof accepts. */
export function advanceProofPath(advanceId: string, fileName: string, now: number = Date.now()): string {
  return `advances/${proofPath(advanceId, fileName, now)}`;
}

/** The file name of an advance proof: everything after advances/<id>/. */
export function advanceProofFileName(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.split('/');
  return parts.length >= 3 ? parts.slice(2).join('/') : path;
}

// ── Bonus form + proof (owner 2026-10-27; migration 20270206100000) ────────

export interface BonusForm { bonusDate: string; category: string; amount: string; note: string }

export const BONUS_DATE_MIN = '2026-04-01';

export function validateBonus(f: BonusForm, today: string = todayTokyo()): string | null {
  if (!BONUS_CATEGORIES.some(c => c.value === f.category)) return 'Choose the bonus category.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.bonusDate)) return 'Enter the date of the bonus.';
  if (f.bonusDate > today) return 'The bonus date is in the future.';
  if (f.bonusDate < BONUS_DATE_MIN) return 'The bonus date must be from April 2026.';
  if (!/^\d+(\.\d{1,2})?$/.test(f.amount.trim()) || Number(f.amount) <= 0) return 'Enter the amount in pesos (up to 2 decimals) above 0.';
  if (Number(f.amount) > 10_000_000) return 'The amount is too large.';
  if (!f.note.trim()) return 'Write a note for the bonus.';
  if (f.note.trim().length > 200) return 'The note is over 200 characters.';
  return null;
}

/** bonuses/<bonus id>/<timestamp>-<safe name>: the only shape attach_payslip_bonus_proof accepts. */
export function bonusProofPath(bonusId: string, fileName: string, now: number = Date.now()): string {
  return `bonuses/${proofPath(bonusId, fileName, now)}`;
}

// ── Excel (STORED figures only) ─────────────────────────────────────────────

/** Payslip_<Name>_<YYYY-MM>.xlsx (or .pdf), the name reduced to letters, digits and _. */
export function payslipFileName(staffName: string, payMonth: string, ext: 'xlsx' | 'pdf' = 'xlsx'): string {
  const safe = staffName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Staff';
  return `Payslip_${safe}_${payMonth.slice(0, 7)}.${ext}`;
}

/** The payment proof paths of a payslip, in order (1st, then the 2nd when there is one). */
export function payslipProofPaths(p: Pick<Payslip, 'proof_path' | 'proof_path_2'>): string[] {
  return [p.proof_path, p.proof_path_2].filter((x): x is string => !!x);
}

/** The proof paths of a cash advance, in order. */
export function advanceProofPaths(a: Pick<AdvanceSnapshot, 'proof_path' | 'proof_path_2'>): string[] {
  return [a.proof_path, a.proof_path_2].filter((x): x is string => !!x);
}

/** A 2nd proof can still be added to an advance (the database has the feature and a slot is free). */
export function advanceProofSlotFree(a: Pick<AdvanceSnapshot, 'proof_path' | 'proof_path_2'>, secondProof: boolean): boolean {
  if (!a.proof_path) return true;
  return secondProof && !a.proof_path_2;
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

export function payslipRows(p: Payslip, generatedOn: string = todayTokyo(), sourceMonth: string | null = null): (string | number)[][] {
  const rows: (string | number)[][] = [
    [COMPANY_NAME],
    [payslipTitle(p.pay_month)],
    [],
    ['Staff name', p.staff_name],
    ...(p.employee_id ? [['Employee ID', p.employee_id]] : []),
    ['Address', p.address],
    ['Date of birth', formatDate(p.date_of_birth)],
    ['Job title', p.job_title ?? '—'],
    ...(correctionLabel(p) ? [[], [correctionLabel(p) as string]] : []),
    [],
    ['Timesheet'],
    ...timesheetLines(p.template_type, p.timesheet).map(l => [l.label, l.value]),
    [],
    ['Commission'],
    ...commissionLines(p.commission).map(l => [l.label, l.value]),
    [],
  ];
  const breakdown = storedBreakdown(p, sourceMonth ?? p.cash_bond_source_month?.slice(0, 7) ?? null);
  if (breakdown) {
    rows.push(...breakdownLines(breakdown, p.status === 'paid').map(l => [l.label, l.value]));
  } else {
    rows.push(['Total', formatPeso(p.total_php)]);
  }
  rows.push([], ['Payment']);
  if (p.jpy_sent != null && p.php_received != null) {
    rows.push(
      [paymentLine(p), ''],
      ['Yen sent', formatYen(p.jpy_sent)],
      ['Pesos received', formatPeso(p.php_received)],
      ['Rate used (₱ per ¥1)', p.php_per_jpy != null ? String(p.php_per_jpy) : '—'],
      ['Paid on', formatDate(p.paid_on)],
      ['Proof of payment', p.proof_not_on_file ? PROOF_NOT_ON_FILE : (proofFileName(p.proof_path) || '—')],
      ...(p.proof_path_2 ? [['Proof of payment (2nd file)', proofFileName(p.proof_path_2)]] : []),
    );
    if (figuresChanged(amountDue(p), p.php_received)) {
      rows.push([differenceLabel(p), formatPeso(p.php_received - amountDue(p))]);
    }
  } else {
    rows.push(['Not paid yet']);
  }
  rows.push([], ['Status', STATUS_LABEL[p.status]], ['Generated', formatDate(generatedOn)]);
  return rows;
}

/** "Difference vs amount due" on payslips with deductions, "… vs payslip total" on older ones. */
export function differenceLabel(p: Pick<Payslip, 'amount_due_php'>): string {
  return hasDeductionColumns(p) ? 'Difference vs amount due' : 'Difference vs payslip total';
}

export function payslipWorkbook(p: Payslip, generatedOn?: string, sourceMonth: string | null = null): XLSX.WorkBook {
  const ws = XLSX.utils.aoa_to_sheet(payslipRows(p, generatedOn, sourceMonth));
  ws['!cols'] = [{ wch: 32 }, { wch: 48 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payslip');
  return wb;
}

/** `sourceMonth` = 'YYYY-MM' of the payslip whose cash bond this one releases (for its label). */
export function downloadPayslipXlsx(p: Payslip, sourceMonth: string | null = null): void {
  XLSX.writeFile(payslipWorkbook(p, undefined, sourceMonth), payslipFileName(p.staff_name, p.pay_month));
}
