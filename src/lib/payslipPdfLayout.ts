/**
 * Payslip PDF page 1 — pure layout logic, no canvas (owner 2026-10-27; docs/PAYSLIPS.md
 * "Corporate PDF"). renderPayslipPage (src/lib/payslipPdf.ts) draws from these, so what is on the
 * page can be tested without a browser. Every figure comes from the STORED payslip.
 */
import { ADDRESS_EN, CORPORATE_NO, EMAIL, LEGAL_NAME_JA, NAME_EN, PHONE, REPRESENTATIVE } from '@/lib/companyInfo';
import {
  STATUS_LABEL, figuresChanged, formatDate, formatPeso, formatYen, longMonthLabel, paymentLine, round2,
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
export function earningsRows(p: Pick<Payslip, 'template_type' | 'timesheet' | 'commission'>): EarningsRow[] {
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
  if (figuresChanged(p.total_php, p.php_received)) {
    rows.push({ label: 'Difference vs payslip total', value: formatPeso(p.php_received - p.total_php) });
  }
  return { paid: true, rows };
}

/** The one line under Net pay on a paid payslip; null when unpaid. */
export function paymentNote(p: Payslip, proofIncluded: boolean | null): string | null {
  if (p.status !== 'paid' || p.jpy_sent == null || p.php_received == null) return null;
  const proof = proofIncluded === false
    ? 'Proof of payment could not be included'
    : 'Proof of payment attached (page 2)';
  return `${paymentLine(p)} · ${proof}`;
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
export function proofCaption(payslipNo: string, fileName: string, paidOn: string | null): string {
  return `Cha Jewels Co., Ltd. — Proof of payment — ${payslipNo} — ${fileName} — paid on ${formatDate(paidOn)}`;
}
