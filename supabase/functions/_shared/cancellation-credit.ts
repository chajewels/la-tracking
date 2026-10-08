/**
 * Cancellation store-credit rule — TS mirror of public.cancellation_credit_split
 * (migrations 20261118100000, 20261129090000). Owner 2026-10-06 13:04 /
 * 2026-10-08 (E3–E6) / 2026-10-08 23:38 (D-SQF01 = A, Japan time):
 * a website or Hub cash order cancelled ON ITS ORDER DAY, JAPAN TIME → 100 %
 * of the money paid as store credit; cancelled on a later Japan day → 30 % of
 * the money PAID is kept as the cancellation charge, 70 % is credit. No
 * override. Shopify orders are not covered (100 %).
 *
 * THE ORDER DAY IS A JAPAN DAY (SQF01). cash_orders.order_date is written as
 * the PHT calendar day (the Hub's day boundary, one hour behind JST), so an
 * order placed 00:00–00:59 JST carries the PREVIOUS day. The rule therefore
 * takes the order's creation instant (cash_orders.created_at) and reads its
 * Japan day — but only while order_date still equals the PHT day of that
 * instant, i.e. nobody changed it. An order_date that differs (an admin edit,
 * V10c; a Page365 / live-selling date typed by staff) is the owner's stated
 * day and is read as a Japan day as it stands. No creation instant → the
 * typed date as a Japan day. The cancel day is always the Japan day of `at`.
 *
 * Pure: no Deno, no imports. The SQL is the authority; change one, change the
 * other. Twin: src/lib/cancellation-credit.ts.
 */
export type CancellationRule = "same_day" | "after_order_day";
export interface CancellationSplit { rule: CancellationRule; chargePct: 0 | 30; money: number; kept: number; credit: number; orderDay: string | null; cancelDay: string }

export const CANCELLATION_CHARGE_PCT = 30;

/** YYYY-MM-DD of an instant as the PHT calendar day (en-CA formats as ISO). */
export function phtDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(at);
}

/** YYYY-MM-DD of an instant as the Japan calendar day. */
export function jstDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(at);
}

/**
 * The order's Japan day (SQF01): the creation instant's Japan day while
 * order_date is still the PHT day that instant produced; otherwise order_date
 * itself, read as a Japan day.
 */
export function orderJapanDay(orderDate: string | null | undefined, orderAt?: Date | null): string | null {
  if (!orderDate) return null;
  if (orderAt && !Number.isNaN(orderAt.getTime()) && phtDate(orderAt) === orderDate) return jstDate(orderAt);
  return orderDate;
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
  orderAt?: Date | null,
): CancellationSplit {
  const m = roundMoney(Math.max(0, Number(money) || 0), currency);
  const orderDay = orderJapanDay(orderDate, orderAt);
  const cancelDay = jstDate(at);
  const sameDay = !orderDay || cancelDay <= orderDay;
  const kept = sameDay ? 0 : roundMoney((m * CANCELLATION_CHARGE_PCT) / 100, currency);
  return { rule: sameDay ? "same_day" : "after_order_day", chargePct: sameDay ? 0 : 30, money: m, kept, credit: roundMoney(m - kept, currency), orderDay, cancelDay };
}
