/**
 * Cancellation store-credit rule — TS mirror of public.cancellation_credit_split
 * (migration 20261117100000). Owner 2026-10-06 13:04 / 2026-10-08 (E3–E6):
 * a website or Hub cash order cancelled ON its order_date → 100 % of the money
 * paid as store credit; cancelled later → 30 % of the money PAID is kept as the
 * cancellation charge, 70 % is credit. No override. order_date is written as
 * the PHT calendar day (Asia/Manila, the Hub's day boundary), so the cancel
 * day is taken in the same zone.
 * Shopify orders are not covered (100 %). Pure: no Deno, no imports. The SQL
 * is the authority; change one, change the other.
 * Twin: src/lib/cancellation-credit.ts.
 */
export type CancellationRule = "same_day" | "after_order_day";
export interface CancellationSplit { rule: CancellationRule; chargePct: 0 | 30; money: number; kept: number; credit: number }

export const CANCELLATION_CHARGE_PCT = 30;

/** YYYY-MM-DD of an instant as the PHT calendar day (en-CA formats as ISO). */
export function phtDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(at);
}

/** Half-up to whole yen or to 2 decimals (pesos), like the SQL round(); computed in integer units. */
function roundMoney(n: number, currency: "JPY" | "PHP"): number {
  const f = currency === "PHP" ? 100 : 1;
  return Math.round(Number((n * f).toFixed(6))) / f;
}

export function cancellationCreditSplit(
  currency: "JPY" | "PHP",
  orderDate: string | null | undefined,
  money: number,
  at: Date,
): CancellationSplit {
  const m = roundMoney(Math.max(0, Number(money) || 0), currency);
  const sameDay = !orderDate || phtDate(at) <= orderDate;
  const kept = sameDay ? 0 : roundMoney((m * CANCELLATION_CHARGE_PCT) / 100, currency);
  return { rule: sameDay ? "same_day" : "after_order_day", chargePct: sameDay ? 0 : 30, money: m, kept, credit: roundMoney(m - kept, currency) };
}
