/**
 * WEBSITE RECEIPTS (領収書) — the pure rules (owner decisions 2026-10-27;
 * docs/RECEIPTS.md). No I/O, no imports: vitest pins this file
 * (src/test/receipt-math.test.ts) and the website edge function renders with it.
 *
 * The SQL twin is public.web_receipt_snapshot / web_receipt_sync
 * (migration 20270216100000_website_receipts.sql). The SQL computes and STORES
 * the figures once, when the receipt is issued; this file mirrors that maths
 * so the tests can prove the rules, and formats what the PDF prints.
 *
 * TAX RULE (owner, locked): every amount in the system is already
 * tax-included. Nothing is added. Item rows are shown EXCLUDING tax so they add
 * up to the subtotal — generate-invoice's rule (owner correction 2026-10-27):
 *   unit price excl. tax = Math.round(tax-included unit price ÷ 1.1)
 *   line amount excl. tax = unit price excl. tax × qty
 *   小計（税抜）  subtotal = Σ line amounts excl. tax
 *   消費税（10%） tax      = Σ tax-included item amounts − subtotal
 *   割引          discount = discount_amount (coupon included) + points (always shown)
 *   送料          shipping = shipping_fee (always shown)
 *   代引手数料    COD fee  (only when > 0)
 *   延滞金        late fee = non-waived layaway penalties (only when > 0)
 *   合計（税込）  total    = subtotal + tax − discount + shipping + COD + late fee
 *                          = the money received
 * The block must add up EXACTLY; when the stored data does not, no receipt is
 * issued (never a balancing line). PESO orders are held: their item lines are
 * stored in yen only and checkout never derived per-line pesos (owner decision
 * pending; docs/RECEIPTS.md "Peso orders").
 */

export type ReceiptCurrency = "JPY" | "PHP";
export type ReceiptLang = "ja" | "en";

/** Half-up rounding of a non-negative ratio a / b, exact for whole cents. */
function roundHalfUpRatio(a: number, b: number): number {
  // floor((2a + b) / 2b) for a, b > 0 — integer arithmetic, no float drift.
  return Math.floor((2 * a + b) / (2 * b));
}

/** Money to whole cents (the DB keeps 2 decimals). */
function cents(n: number): number {
  return Math.round(Number(n) * 100);
}

/** 内消費税 included in a tax-inclusive amount: round(amount × 10 / 110). */
export function includedTax(taxable: number): number {
  const c = cents(taxable);
  if (!Number.isFinite(c) || c <= 0) return 0;
  // amount × 10 / 110 in whole units = cents × 10 / (110 × 100)
  return roundHalfUpRatio(c * 10, 110 * 100);
}

/** Unit price excl. tax: Math.round(tax-included ÷ 1.1), exact (integer maths). */
export function unitPriceExTax(unitPriceIncl: number): number {
  const c = cents(unitPriceIncl);
  if (!Number.isFinite(c) || c <= 0) return 0;
  // ÷ 1.1 = × 10 / 11, in whole units: cents × 10 / (11 × 100)
  return roundHalfUpRatio(c * 10, 11 * 100);
}

export interface ReceiptItemInput {
  /** Tax-included unit price (cash_order_items / layaway_account_items.unit_price_jpy). */
  unitPrice: number;
  quantity: number;
  /** The stored line_total_jpy; must equal unitPrice × quantity. */
  lineTotal: number;
}

export interface ReceiptTotalsInput {
  currency: ReceiptCurrency;
  items: ReceiptItemInput[];
  /** discount_amount (coupon included). */
  discount: number;
  /** Σ LOYALTY-% payments — shown as a discount. */
  points: number;
  shipping: number;
  codFee: number;
  /** Σ non-waived layaway penalties. */
  penalties: number;
  /** The money received (non-voided payments − points − refunds). */
  received: number;
}

export interface ReceiptTotals {
  lines: { unitPriceEx: number; lineEx: number }[];
  subtotal: number;
  tax: number;
  discount: number;
  shipping: number;
  codFee: number;
  penalties: number;
  total: number;
  /** subtotal + tax − discount + shipping + COD fee + late fee === received (yen only). */
  addsUp: boolean;
  /** Why it does not: lines_mismatch | block_mismatch | no_items | peso_pending_owner_decision. */
  problem: string | null;
}

/** The owner's totals block (mirror of web_receipt_snapshot). */
export function receiptTotals(i: ReceiptTotalsInput): ReceiptTotals {
  const lines = i.items.map((it) => {
    const unitPriceEx = unitPriceExTax(it.unitPrice);
    return { unitPriceEx, lineEx: unitPriceEx * Math.trunc(it.quantity) };
  });
  const inclC = i.items.reduce((s, it) => s + cents(it.unitPrice) * Math.trunc(it.quantity), 0);
  const storedC = i.items.reduce((s, it) => s + cents(it.lineTotal), 0);
  const subtotal = lines.reduce((s, l) => s + l.lineEx, 0);
  const taxC = inclC - subtotal * 100;
  const discountC = cents(i.discount) + cents(i.points);
  const blockC = subtotal * 100 + taxC - discountC + cents(i.shipping) + cents(i.codFee) + cents(i.penalties);
  let problem: string | null = null;
  if (i.currency !== "JPY") problem = "peso_pending_owner_decision";
  else if (inclC <= 0) problem = "no_items";
  else if (inclC !== storedC) problem = "lines_mismatch";
  else if (blockC !== cents(i.received)) problem = "block_mismatch";
  return {
    lines,
    subtotal,
    tax: taxC / 100,
    discount: discountC / 100,
    shipping: cents(i.shipping) / 100,
    codFee: cents(i.codFee) / 100,
    penalties: cents(i.penalties) / 100,
    total: cents(i.received) / 100,
    addsUp: problem === null,
    problem,
  };
}

/** CJR-YYYY-NNNNNN — YYYY is the JST year of issue, NNNNNN the receipt sequence. */
export function receiptNumber(seq: number, issuedAt: Date): string {
  const year = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric" }).format(issuedAt);
  return `CJR-${year}-${String(Math.trunc(seq)).padStart(6, "0")}`;
}

export const RECEIPT_NUMBER_RE = /^CJR-\d{4}-\d{6,}$/;
/** Verify codes: 20 random bytes as lowercase hex (160 bits). */
export const VERIFY_CODE_RE = /^[0-9a-f]{40}$/;

export function normaliseVerifyCode(raw: unknown): string | null {
  const c = String(raw ?? "").trim().toLowerCase();
  return VERIFY_CODE_RE.test(c) ? c : null;
}

/** Every download after the first is a reissue (再発行 / Reissued). */
export function isReissue(issueNo: number): boolean {
  return issueNo > 1;
}

export type CancelReason =
  | "not_completed" | "refunded" | "disputed" | "not_fully_paid" | "does_not_add_up" | "owner_changed" | "figures_changed";

export interface ReceiptStateInput {
  status: string;
  refunds: number;
  disputed: boolean;
  fullyPaid: boolean;
  addsUp: boolean;
  ownerChanged: boolean;
  figuresChanged: boolean;
}

/** Mirror of web_receipt_sync's cancel decision: null = the issued receipt stays. */
export function cancelReason(s: ReceiptStateInput): CancelReason | null {
  if (s.status !== "completed") return "not_completed";
  if (s.refunds > 0) return "refunded";
  if (s.disputed) return "disputed";
  if (!s.fullyPaid) return "not_fully_paid";
  if (!s.addsUp) return "does_not_add_up";
  if (s.ownerChanged) return "owner_changed";
  if (s.figuresChanged) return "figures_changed";
  return null;
}

export type ReceiptSwitch = "off" | "test" | "on";

/** Mirror of the switch rule: test = TEST- orders only, on = real orders only, off = nothing. */
export function switchAllowsIssue(
  mode: ReceiptSwitch, liveAt: Date | null, completedAt: Date | null, isTest: boolean,
): boolean {
  if (mode === "off" || !liveAt || !completedAt) return false;
  if (completedAt.getTime() < liveAt.getTime()) return false;
  return (mode === "test") === isTest;
}

export function readReceiptSwitch(raw: unknown): ReceiptSwitch {
  let v: unknown = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { /* bare string */ }
  }
  return v === "test" || v === "on" ? v : "off";
}

// ------------------------------------------------------------ addressee / purpose
export const ADDRESSEE_MAX = 60;
export const PURPOSE_MAX = 40;
export const DEFAULT_PURPOSE = "お品代として";

export type DetailsProblem = "addressee_too_long" | "purpose_too_long" | "invalid_characters";

/** Same checks as update_website_receipt_details (the SQL is the guard). */
export function cleanReceiptDetails(addressee: unknown, purpose: unknown):
  { addressee: string | null; purpose: string } | { error: DetailsProblem } {
  const a = String(addressee ?? "").trim();
  const p = String(purpose ?? "").trim();
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(a) || /[\u0000-\u001f\u007f]/.test(p)) return { error: "invalid_characters" };
  if ([...a].length > ADDRESSEE_MAX) return { error: "addressee_too_long" };
  if ([...p].length > PURPOSE_MAX) return { error: "purpose_too_long" };
  return { addressee: a || null, purpose: p || DEFAULT_PURPOSE };
}

// ------------------------------------------------------------------- printing
/**
 * Money as the receipt prints it. Yen: ¥100,000. Pesos: the ISO code, never ₱
 * (owner 2026-10-27: Noto Sans JP has no ₱ glyph) — "PHP 42,000", two decimals
 * only when they are not zero.
 */
export function receiptMoney(n: number, currency: ReceiptCurrency): string {
  const c = cents(n);
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.trunc(abs / 100).toLocaleString("en-US");
  const frac = abs % 100;
  const body = currency === "JPY" || frac === 0 ? whole : `${whole}.${String(frac).padStart(2, "0")}`;
  const sign = neg ? "-" : "";
  return currency === "JPY" ? `${sign}¥${body}` : `${sign}PHP ${body}`;
}

/** A discount as the totals block prints it: always a minus, even at zero ("−¥0", "−PHP 1,000"). */
export function receiptMinus(n: number, currency: ReceiptCurrency): string {
  return `\u2212${receiptMoney(Math.abs(n), currency)}`;
}

/** The receipt's day in Japan time: 2026年10月27日 / 27 October 2026. */
export function receiptDate(iso: string | Date, lang: ReceiptLang): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (lang === "ja") {
    const p = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric" }).format(d);
    return p;
  }
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", day: "numeric", month: "long", year: "numeric" }).format(d);
}

const METHOD_LABELS: Record<string, { ja: string; en: string }> = {
  bank_transfer: { ja: "銀行振込", en: "Bank transfer" },
  transfer: { ja: "銀行振込", en: "Bank transfer" },
  rakuten: { ja: "銀行振込", en: "Bank transfer" },
  sumitomo: { ja: "銀行振込", en: "Bank transfer" },
  jp_bank: { ja: "銀行振込", en: "Bank transfer" },
  bdo: { ja: "銀行振込", en: "Bank transfer" },
  bpi: { ja: "銀行振込", en: "Bank transfer" },
  metrobank: { ja: "銀行振込", en: "Bank transfer" },
  genkin_kaketome: { ja: "現金書留", en: "Registered cash mail" },
  paypay: { ja: "PayPay", en: "PayPay" },
  gcash: { ja: "GCash", en: "GCash" },
  square: { ja: "クレジットカード", en: "Credit card" },
  card: { ja: "クレジットカード", en: "Credit card" },
  credit_card: { ja: "クレジットカード", en: "Credit card" },
  paidy: { ja: "ペイディ（あと払い）", en: "Paidy" },
  cod: { ja: "代金引換", en: "Cash on delivery" },
  "cash on delivery": { ja: "代金引換", en: "Cash on delivery" },
  store_credit: { ja: "ストアクレジット", en: "Store credit" },
  cash: { ja: "現金", en: "Cash" },
  "cash payment": { ja: "現金", en: "Cash" },
  cash_pickup: { ja: "現金", en: "Cash" },
  other: { ja: "その他", en: "Other" },
};

/** A payment method's printed name; an unknown spelling prints as stored. */
export function methodLabel(method: string, lang: ReceiptLang): string {
  const key = String(method ?? "").trim().toLowerCase();
  return METHOD_LABELS[key]?.[lang] ?? (String(method ?? "").trim() || METHOD_LABELS.other[lang]);
}

/** The purpose line in English: the default prints as "Payment for goods"; anything else as typed. */
export function purposeFor(purpose: string | null | undefined, lang: ReceiptLang): string {
  const p = String(purpose ?? "").trim() || DEFAULT_PURPOSE;
  if (lang === "en" && p === DEFAULT_PURPOSE) return "Payment for goods";
  return p;
}
