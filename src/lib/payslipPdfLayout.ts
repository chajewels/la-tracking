/**
 * Payslip PDF page 1 — pure layout logic, no canvas (owner 2026-10-27; docs/PAYSLIPS.md
 * "Corporate PDF"). renderPayslipPage (src/lib/payslipPdf.ts) draws from these, so what is on the
 * page can be tested without a browser. Every figure comes from the STORED payslip.
 */
import { ADDRESS_EN, CORPORATE_NO, EMAIL, LEGAL_NAME_JA, NAME_EN, PHONE, REPRESENTATIVE } from '@/lib/companyInfo';
import {
  BOND_HELD_LABEL, STATUS_LABEL, advanceLabel, amountDue, bonusCategoryLabel, bondReleasedLabel, differenceLabel, figuresChanged, formatDate,
  formatDateDD, formatPeso, formatYen, longMonthLabel, round2, storedBreakdown,
  type Payslip,
} from '@/lib/payslips';

export interface LabelValue { label: string; value: string }

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hours(n: number): string {
  return round2(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** PS-YYYY-MM-XXXXXX: the pay month and the first 6 hex characters of the payslip id, uppercase. */
export function payslipNumber(p: Pick<Payslip, 'id' | 'pay_month'>): string {
  const hex = p.id.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase();
  return `PS-${p.pay_month.slice(0, 7)}-${hex}`;
}

/** "October 2026" — the month, never a 1–31 range (the sheet is a 31-row window). */
export function periodLabel(p: Pick<Payslip, 'pay_month'>): string {
  return longMonthLabel(p.pay_month);
}

/** A timestamp as "05 Oct 2026" in Japan time. */
export function issuedLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

/** The right-hand details under "PAYSLIP", in this order. */
export function headerDetails(p: Payslip): LabelValue[] {
  return [
    { label: 'Pay period', value: periodLabel(p) },
    { label: 'Payslip no.', value: payslipNumber(p) },
    { label: 'Issued', value: issuedLabel(p.finalized_at) },
    { label: 'Status', value: STATUS_LABEL[p.status] },
  ];
}

export interface RightBlockLayout {
  /** x of the first glyph of the title (glyphs are drawn one by one, left to right). */
  titleX: number;
  /** x where the last glyph of the title ends — equals `right`. */
  titleRight: number;
  /** labels are right-aligned at this x. */
  labelRight: number;
  /** every value starts at this x. */
  valueX: number;
  /** x where the widest value ends — equals `right`. */
  blockRight: number;
  /** leftmost x the block uses (title or labels). */
  left: number;
}

/**
 * The right header block, flush with `right`. The title is drawn glyph by glyph with
 * `letterSpacing` BETWEEN glyphs only, so no trailing spacing pushes its last letter left of the
 * edge. The values column starts at one x, computed from the widest value; labels sit `gap` to
 * its left.
 */
export function rightBlockLayout(opts: {
  right: number;
  titleGlyphWidths: number[];
  letterSpacing: number;
  labelWidths: number[];
  valueWidths: number[];
  gap: number;
}): RightBlockLayout {
  const glyphs = opts.titleGlyphWidths;
  const titleWidth = glyphs.reduce((s, w) => s + w, 0) + opts.letterSpacing * Math.max(0, glyphs.length - 1);
  const titleX = opts.right - titleWidth;
  const widestValue = Math.max(0, ...opts.valueWidths);
  const valueX = opts.right - widestValue;
  const labelRight = valueX - opts.gap;
  const widestLabel = Math.max(0, ...opts.labelWidths);
  return {
    titleX,
    titleRight: titleX + titleWidth,
    labelRight,
    valueX,
    blockRight: valueX + widestValue,
    left: Math.min(titleX, labelRight - widestLabel),
  };
}

// ── Letterhead (left block) ─────────────────────────────────────────────────

export type LetterheadRole = 'name' | 'legal' | 'address' | 'contact' | 'corporate';
export interface LetterheadLine { role: LetterheadRole; text: string }

/** The five fixed letterhead lines (owner 2026-10-27): no item is ever split across lines. */
export function letterheadLines(): LetterheadLine[] {
  return [
    { role: 'name', text: NAME_EN },
    { role: 'legal', text: LEGAL_NAME_JA },
    { role: 'address', text: ADDRESS_EN },
    { role: 'contact', text: `Tel ${PHONE} · ${EMAIL}` },
    { role: 'corporate', text: `Corporate No. ${CORPORATE_NO}` },
  ];
}

/** Width of `text` at `size` pt (the canvas passes ctx.measureText after setting the font). */
export type MeasureText = (text: string, size: number) => number;

export const LETTERHEAD_SMALL_START = 8.5;
export const LETTERHEAD_SMALL_MIN = 8;
const LETTERHEAD_STEP = 0.25;

/**
 * The largest size from `start` down to `min` (in 0.25 pt steps) at which every text fits on one
 * line within `maxWidth`; `fits` is false when even `min` is too wide.
 */
export function fitFontSize(
  measure: MeasureText, texts: string[], maxWidth: number,
  start: number = LETTERHEAD_SMALL_START, min: number = LETTERHEAD_SMALL_MIN,
): { size: number; fits: boolean } {
  for (let size = start; size >= min - 1e-9; size = Math.round((size - LETTERHEAD_STEP) * 100) / 100) {
    if (texts.every(t => measure(t, size) <= maxWidth)) return { size, fits: true };
  }
  return { size: min, fits: false };
}

/** The address split at the comma before "Tokyo" — never inside a number. */
export function splitAddress(address: string): string[] {
  const i = address.indexOf(', Tokyo');
  return i < 0 ? [address] : [address.slice(0, i + 1), address.slice(i + 2)];
}

/**
 * The address and contact lines at one size that fits `maxWidth`. Only when even 8 pt is too wide
 * is the address broken at the comma before "Tokyo"; the contact and corporate-number lines are
 * never broken.
 */
export function letterheadSmallLines(measure: MeasureText, maxWidth: number): { size: number; lines: LetterheadLine[] } {
  const small = letterheadLines().filter(l => l.role === 'address' || l.role === 'contact' || l.role === 'corporate');
  const fit = fitFontSize(measure, small.map(l => l.text), maxWidth);
  if (fit.fits) return { size: fit.size, lines: small };
  const lines = small.flatMap(l => l.role === 'address'
    ? splitAddress(l.text).map(text => ({ role: 'address' as const, text }))
    : [l]);
  return { size: LETTERHEAD_SMALL_MIN, lines };
}

// ── Earnings ────────────────────────────────────────────────────────────────

export interface EarningsRow {
  label: string;
  details: string;
  /** counted in the total; null = nothing to add. */
  amount: number | null;
  /** what the Amount column shows. */
  amountText: string;
}

function money(label: string, details: string, amount: number): EarningsRow {
  return { label, details, amount: round2(amount), amountText: formatPeso(amount) };
}

/** The earnings table from the STORED timesheet / commission breakdowns. */
export function earningsRows(p: Pick<Payslip, 'template_type' | 'timesheet' | 'commission' | 'bonuses'>): EarningsRow[] {
  const t = p.timesheet;
  const rows: EarningsRow[] = [];
  if (p.template_type === 'csr') {
    const dailySum = num(t.daily_pay_sum);
    const capped = num(t.capped_gross);
    const basic = num(t.basic_salary);
    const weeks = num(t.forfeited_weeks);
    rows.push(money('Daily pay earned', `${num(t.days_worked)} days · ${hours(num(t.total_hours))} hrs`, dailySum));
    if (round2(capped) < round2(dailySum)) {
      rows.push(money('Basic salary cap', `Capped at ${formatPeso(basic)}`, -(round2(dailySum) - round2(capped))));
    } else {
      rows.push({ label: 'Basic salary cap', details: `${formatPeso(basic)} — not reached`, amount: null, amountText: '—' });
    }
    rows.push(money('Allowance',
      `${formatPeso(num(t.monthly_allowance))} monthly · ${weeks} week${weeks === 1 ? '' : 's'} forfeited`,
      num(t.allowance_paid)));
  } else {
    const d500 = num(t.days_at_500);
    const d300 = num(t.days_at_300);
    rows.push(money('Full days', `${d500} × ₱500`, 500 * d500));
    rows.push(money('Half days', `${d300} × ₱300`, 300 * d300));
    rows.push({ label: 'Hours', details: `Total hours ${hours(num(t.total_hours))}`, amount: null, amountText: '' });
  }
  const c = p.commission;
  if (num(c.total) > 0) {
    const role = typeof c.role_won === 'string' && c.role_won ? c.role_won : '—';
    rows.push(money('Commission', `Role won: ${role}`, num(c.earnings)));
    const tier = num(c.top_sales_tier);
    if (tier > 0) rows.push(money(`Top Sales ${tier} bonus`, '', num(c.top_sales_bonus)));
  }
  // Bonuses typed per month (owner 2026-10-27): earnings, in the frozen order.
  for (const b of p.bonuses ?? []) {
    rows.push(money(bonusCategoryLabel(b.category), `${formatDateDD(b.bonus_date)} · ${b.note}`, b.amount_php));
  }
  return rows;
}

/** Sum of the rows in whole centavos (no float drift). */
export function earningsTotal(rows: EarningsRow[]): number {
  return rows.reduce((s, r) => s + Math.round((r.amount ?? 0) * 100), 0) / 100;
}

/** The rows must add up to the payslip total exactly; a page that does not add up is never drawn. */
export function assertEarningsMatch(rows: EarningsRow[], totalPhp: number): void {
  if (Math.round(earningsTotal(rows) * 100) !== Math.round(round2(totalPhp) * 100)) {
    throw new Error('earnings_mismatch');
  }
}

// ── Cash advances, cash bond, amount due (owner 2026-10-27) ─────────────────

/** "Employee ID: …" for the PAID TO box; null on payslips without one (issued before the migration). */
export function employeeIdLine(p: Pick<Payslip, 'employee_id'>): string | null {
  const id = (p.employee_id ?? '').trim();
  return id ? `Employee ID: ${id}` : null;
}

export interface SummaryRow { label: string; amountText: string; amount: number; emphasis?: boolean }

/**
 * The rows after the earnings table, from the STORED columns: one negative row per cash advance,
 * then Total earnings / Total cash advances / Net pay, then the cash bond (held − or released +).
 * Empty for payslips issued before the migration (they go straight to NET PAY).
 */
export function deductionRows(p: Payslip): { advances: SummaryRow[]; summary: SummaryRow[]; bond: SummaryRow[] } {
  const b = storedBreakdown(p);
  if (!b) return { advances: [], summary: [], bond: [] };
  const advances = b.advances.map(a => ({ label: advanceLabel(a), amount: -round2(a.amount_php), amountText: formatPeso(-a.amount_php) }));
  const summary: SummaryRow[] = [
    { label: 'Total earnings', amount: b.earnings, amountText: formatPeso(b.earnings) },
    { label: 'Total cash advances', amount: b.advancesTotal, amountText: formatPeso(b.advancesTotal) },
    { label: 'Net pay', amount: b.net, amountText: formatPeso(b.net), emphasis: true },
  ];
  const bond: SummaryRow[] = [];
  if (b.held > 0) bond.push({ label: BOND_HELD_LABEL, amount: -b.held, amountText: formatPeso(-b.held) });
  if (b.released > 0) bond.push({ label: bondReleasedLabel(b.releasedFrom), amount: b.released, amountText: formatPeso(b.released) });
  return { advances, summary, bond };
}

/** The dark band: AMOUNT DUE / AMOUNT PAID = amount_due_php; older payslips keep NET PAY = total_php. */
export function payBand(p: Payslip): { label: string; amount: number } {
  if (p.amount_due_php == null) return { label: 'NET PAY', amount: p.total_php };
  return { label: p.status === 'paid' ? 'AMOUNT PAID' : 'AMOUNT DUE', amount: p.amount_due_php };
}

/** earnings − advances − bond held + bond released must equal amount_due_php to the centavo. */
export function assertDeductionsMatch(p: Payslip): void {
  const b = storedBreakdown(p);
  if (!b) return;
  const c = (n: number) => Math.round(round2(n) * 100);
  const advances = (p.cash_advances ?? []).reduce((s, a) => s + c(a.amount_php), 0);
  if (advances !== c(b.advancesTotal)
      || c(b.earnings) - advances - c(b.held) + c(b.released) !== c(amountDue(p))) {
    throw new Error('deductions_mismatch');
  }
}

/** Pages a–b holding the cash advance proofs; null when there are none. */
export interface PageRange { first: number; last: number }

function pagesText(r: PageRange): string {
  return r.first === r.last ? `page ${r.first}` : `pages ${r.first}–${r.last}`;
}

/** Caption under an image advance proof (drawn with a standard font: callers pass it through winAnsiSafe). */
export function advanceProofCaption(advanceDate: string, fileName: string): string {
  return `Cha Jewels Co., Ltd. — Cash advance — ${formatDateDD(advanceDate)} — ${fileName}`;
}

export function bonusProofCaption(category: string, bonusDate: string, fileName: string): string {
  return `Cha Jewels Co., Ltd. — ${bonusCategoryLabel(category)} — ${formatDateDD(bonusDate)} — ${fileName}`;
}

export function bonusProofFallback(fileName: string): string {
  return `Bonus proof could not be included — open it from the Hub: ${fileName}`;
}

export function advanceProofFallback(fileName: string): string {
  return `Cash advance proof could not be included — open it from the Hub: ${fileName}`;
}

// ── Payment, signatures, footer ─────────────────────────────────────────────

export type PaymentBlock =
  | { paid: true; rows: LabelValue[] }
  | { paid: false; rows: []; note: string };

export function paymentBlock(p: Payslip): PaymentBlock {
  if (p.status !== 'paid' || p.jpy_sent == null || p.php_received == null) {
    return { paid: false, rows: [], note: 'Not paid yet' };
  }
  const rows: LabelValue[] = [
    { label: 'Paid on', value: formatDate(p.paid_on) },
    { label: 'Yen sent', value: formatYen(p.jpy_sent) },
    { label: 'Pesos received', value: formatPeso(p.php_received) },
    { label: 'Rate used (₱ per ¥1)', value: p.php_per_jpy != null ? String(p.php_per_jpy) : '—' },
  ];
  if (figuresChanged(amountDue(p), p.php_received)) {
    rows.push({ label: differenceLabel(p), value: formatPeso(p.php_received - amountDue(p)) });
  }
  return { paid: true, rows };
}

/**
 * The line under the amount band. Paid: "<Month YYYY> salary paid on <DD Mon YYYY>: ¥x → ₱y · Proof of
 * payment attached (page 2)" plus ", cash advance proofs pages a–b". Unpaid: only the advance-proof pages,
 * or null.
 */
/**
 * `proofPages`: the pages holding the payment proof file(s) (2 files, or a multi-page PDF, take more
 * than page 2); omitted = "page 2".
 */
export function paymentNote(
  p: Payslip, proofIncluded: boolean | null, advancePages: PageRange | null = null, proofPages: PageRange | null = null,
  bonusPages: PageRange | null = null,
): string | null {
  const parts = [
    ...(advancePages ? [`cash advance proofs ${pagesText(advancePages)}`] : []),
    ...(bonusPages ? [`bonus proofs ${pagesText(bonusPages)}`] : []),
  ];
  const advances = parts.length ? parts.join(', ') : null;
  if (p.status !== 'paid' || p.jpy_sent == null || p.php_received == null) {
    if (!advancePages && !bonusPages) return null;
    if (advancePages && !bonusPages) return `Cash advance proofs attached (${pagesText(advancePages)})`;
    if (bonusPages && !advancePages) return `Bonus proofs attached (${pagesText(bonusPages)})`;
    return `Proofs attached: ${advances}`;
  }
  const proof = proofIncluded === false
    ? 'Proof of payment could not be included'
    : `Proof of payment attached (${proofPages ? pagesText(proofPages) : 'page 2'})`;
  const paid = `${longMonthLabel(p.pay_month)} salary paid on ${formatDateDD(p.paid_on)}: ${formatYen(p.jpy_sent)} → ${formatPeso(p.php_received)}`;
  return `${paid} · ${proof}${advances ? `, ${advances}` : ''}`;
}

export interface SignatureColumn { label: string; name: string }

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prepared by (the finalizer's name, blank when unknown — never an id) · Approved by · Received by. */
export function signatureBlock(_p: Payslip, finalizerName: string | null | undefined): SignatureColumn[] {
  const name = (finalizerName ?? '').trim();
  return [
    { label: 'Prepared by', name: name && !UUID_LIKE.test(name) ? name : '' },
    { label: 'Approved by', name: REPRESENTATIVE },
    { label: 'Received by', name: 'Staff signature and date' },
  ];
}

export function footer(pageCount: number): { left: string; right: string } {
  return { left: 'Confidential — for the named recipient only.', right: `Page 1 of ${pageCount}` };
}

/** Caption under an image proof (drawn with a standard font, so callers pass it through winAnsiSafe). */
/** `part` = "1 of 2" / "2 of 2" when the payment has two proof files. */
export function proofCaption(payslipNo: string, fileName: string, paidOn: string | null, part?: string): string {
  const label = part ? `Proof of payment (${part})` : 'Proof of payment';
  return `Cha Jewels Co., Ltd. — ${label} — ${payslipNo} — ${fileName} — paid on ${formatDate(paidOn)}`;
}
