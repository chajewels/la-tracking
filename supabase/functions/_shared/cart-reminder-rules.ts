/**
 * Cart reminders (stages A/B, 2026-10-01): pure rules.
 *
 * Kept free of Deno globals and of the Supabase client so the SAME file the
 * edge function runs is imported by vitest (src/test/cart-reminders.test.tsx),
 * the way _shared/web-payment-reminder-rules.ts is.
 *
 * THE AUTHORITY IS SQL. cart_reminder_candidates / claim_cart_reminder
 * (migration 20261021100000_cart_reminders.sql) decide WHO is reminded and
 * WHEN — consent, the kill switch, idle time, no order since, once per cycle,
 * 7 days between reminders, stock, local hours — under a row lock. What is
 * here decides only WHAT the email says (stage A vs stage B, the money form per
 * language) and the plumbing names. docs/CART-REMINDERS.md.
 *
 * PROMOTIONAL. Every email built from these rules carries the opt-out link and
 * the full sender block; the Japanese form never mentions layaway.
 */

export type CartReminderMode = "off" | "owner_only" | "on";
export type CartReminderLang = "ja" | "en";
export type QuoteMode = "full" | "layaway";
export type QuoteCurrency = "JPY" | "PHP";

/** The storefront page the consent wording version is pinned to (storefront PR). */
export const CONSENT_KIND = "cart_reminder";

/**
 * system_settings.cart_reminders_mode, read FAIL-CLOSED: only the exact strings
 * "owner_only" and "on" do anything. Absent, null, a typo, a boolean — all OFF.
 */
export function readCartReminderMode(value: unknown): CartReminderMode {
  return value === "owner_only" || value === "on" ? value : "off";
}

/** One logical send per cart cycle — the ledger's UNIQUE(cycle_id), so a retry dedupes at the provider too. */
export function cartReminderIdempotencyKey(cycleId: string): string {
  return `cart-reminder-${cycleId}`;
}

/** Machine label in email_send_log and Lovable's send log. */
export const CART_REMINDER_LABEL = "cart-reminder";

/** cart_reminder_sends.status for a sendStorefrontEmail outcome. */
export function cartReminderFinishStatus(
  res: { sent: true } | { sent: false; reason: string },
): "sent" | "skipped" | "failed" | "suppressed" {
  if (res.sent) return "sent";
  if (res.reason === "recipient_suppressed") return "suppressed";
  if (res.reason === "error" || res.reason === "not_found") return "failed";
  return "skipped";
}

/** A candidate's quote columns, as cart_reminder_candidates returns them (NULLs = stage A). */
export interface CandidateQuote {
  quote_mode?: unknown;
  quote_currency?: unknown;
  quote_term?: unknown;
}

/**
 * THE FORM OF THE EMAIL (§2d / §2i of the plan):
 *   stage_a        — no checkout this cycle. EN: ¥ with (₱) and the Hub's
 *                    reserve line per piece; JA: yen only.
 *   full_jpy       — she chose full payment in yen: ¥ only, no reserve line.
 *   full_php       — she chose full payment in pesos: ₱ per piece (+ note).
 *   layaway        — she chose a layaway: items, then a plan panel from
 *                    layaway_quote. EN ONLY: JA + layaway renders stage_a
 *                    (yen only) — the Japanese site refuses layaway and so
 *                    does every Japanese email.
 */
export type ReminderForm = "stage_a" | "full_jpy" | "full_php" | "layaway";

export function reminderForm(lang: CartReminderLang, q: CandidateQuote | null | undefined): ReminderForm {
  const mode = q?.quote_mode === "layaway" ? "layaway" : q?.quote_mode === "full" ? "full" : null;
  if (!mode) return "stage_a";
  if (mode === "layaway") return lang === "ja" ? "stage_a" : "layaway";
  return q?.quote_currency === "PHP" ? "full_php" : "full_jpy";
}

/** The layaway term the quote asked for, or 3 when it is not a usable number. */
export function quoteTerm(q: CandidateQuote | null | undefined): number {
  const t = Number(q?.quote_term);
  return Number.isInteger(t) && t >= 3 && t <= 12 ? t : 3;
}

/** Yen with the comma grouping every storefront email uses. */
export function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString("en-US")}`;
}

/** Pesos, whole, as the Hub stores them. */
export function pesos(n: number): string {
  return `₱${Math.round(n).toLocaleString("en-US")}`;
}

/** "¥68,000 (₱27,016)" when the Hub supplied a peso figure; "¥68,000" when it did not. */
export function yenWithPesos(jpy: number, php: number | null | undefined): string {
  return php === null || php === undefined || !Number.isFinite(php) ? yen(jpy) : `${yen(jpy)} (${pesos(php)})`;
}

/** A whole, non-negative percentage from the Hub's dp fraction (0.3 → 30), or null. */
export function percentFromFraction(fraction: unknown): number | null {
  const f = Number(fraction);
  if (!Number.isFinite(f) || f <= 0 || f >= 1) return null;
  return Math.round(f * 100);
}

/**
 * The layaway plan panel's figures, from a layaway_quote answer, or null when
 * the Hub refused or downgraded the term — the renderer then falls back to
 * the stage-A EN form. NEVER invent a plan (web-layaway rule: refuse on NOT
 * eligible OR term_downgraded).
 */
export interface PlanFigures {
  currency: QuoteCurrency;
  deposit: number;
  monthly: number;
  lastMonth: number;
  termMonths: number;
  total: number;
}

export function planFiguresFromQuote(quote: Record<string, unknown> | null | undefined, currency: QuoteCurrency): PlanFigures | null {
  if (!quote || quote.eligible !== true || quote.term_downgraded === true) return null;
  const deposit = Number(quote.deposit);
  const monthly = Number(quote.monthly);
  const lastMonth = Number(quote.last_month ?? monthly);
  const termMonths = Number(quote.term_months);
  const total = Number(quote.total);
  if (![deposit, monthly, lastMonth, termMonths, total].every((n) => Number.isFinite(n) && n > 0)) return null;
  return { currency, deposit, monthly, lastMonth, termMonths, total };
}

/**
 * Words that must never appear in a JAPANESE cart reminder (owner rule: nothing
 * layaway-related on the Japanese site, emails included) and promotional
 * phrasings no reminder uses. Pinned by the test.
 */
export const JA_FORBIDDEN = ["分割", "レイアウェイ", "頭金", "お申込金", "layaway", "Layaway"] as const;
