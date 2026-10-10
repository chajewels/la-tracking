/**
 * CASH ON DELIVERY (代金引換) — the fee rule and who is offered COD (owner plan
 * claude/cod-plan-2026-10-10.md; docs/COD.md).
 *
 * The TS MIRROR of public.cod_fee_jpy / cod_limit_jpy / cod_fee_table_valid /
 * cod_mode (migration 20261202100000_cod_checkout.sql). Pure: no Deno globals,
 * no Supabase client, so vitest / deno test run the same file the edge
 * functions do. The SQL is the authority at every write (create_web_draft_atomic,
 * materialize_web_draft_atomic, both method switches); this file decides what
 * the storefront is OFFERED and the figure it is shown. Change one, change the
 * other — development/cod-checkout.test.ts proves they agree.
 *
 *   Amount collected = pieces after points + shipping (+ services − discount
 *   once staff edit at Confirm). The fee is NOT part of it.
 *   Brackets are inclusive ("up to and including max_jpy").
 *   COD is offered only while the amount collected ≤ the top bracket (the
 *   limit); the courier may therefore collect up to limit + top fee.
 */

export interface CodBracket {
  max_jpy: number;
  fee_jpy: number;
}

/** The owner's table (2026-10-10), also the seed of system_settings.cod_fee_table. */
export const DEFAULT_COD_FEE_TABLE: readonly CodBracket[] = [
  { max_jpy: 10_000, fee_jpy: 1_040 },
  { max_jpy: 30_000, fee_jpy: 1_150 },
  { max_jpy: 100_000, fee_jpy: 1_370 },
  { max_jpy: 300_000, fee_jpy: 1_810 },
];

export type CodMode = "off" | "on";

/** Fail-closed, as public.cod_mode(): only the exact string "on" is on. */
export function codModeFrom(raw: unknown): CodMode {
  return raw === "on" ? "on" : "off";
}

/** public.cod_fee_table_valid: 1–10 brackets, whole yen, max strictly ascending, 0 ≤ fee ≤ 100,000. */
export function codFeeTableValid(raw: unknown): raw is CodBracket[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) return false;
  let prev = 0;
  for (const e of raw) {
    if (!e || typeof e !== "object") return false;
    const max = (e as Record<string, unknown>).max_jpy;
    const fee = (e as Record<string, unknown>).fee_jpy;
    if (typeof max !== "number" || typeof fee !== "number") return false;
    if (!Number.isInteger(max) || !Number.isInteger(fee)) return false;
    if (max <= prev || max > 10_000_000 || fee < 0 || fee > 100_000) return false;
    prev = max;
  }
  return true;
}

/** The table, or null when the stored value is not a valid table (COD then offered to nobody). */
export function codFeeTable(raw: unknown): CodBracket[] | null {
  return codFeeTableValid(raw) ? raw.map((b) => ({ max_jpy: b.max_jpy, fee_jpy: b.fee_jpy })) : null;
}

/** public.cod_limit_jpy: the top bracket, or null. */
export function codLimitJpy(table: readonly CodBracket[] | null): number | null {
  if (!table || !codFeeTableValid(table as unknown)) return null;
  return table[table.length - 1].max_jpy;
}

/**
 * public.cod_fee_jpy: the fee for an amount collected, or null when COD is not
 * possible (nothing to collect, over the limit, or no valid table).
 */
export function codFeeJpy(collectedJpy: number, table: readonly CodBracket[] | null): number | null {
  if (!table || !codFeeTableValid(table as unknown)) return null;
  if (!Number.isFinite(collectedJpy) || collectedJpy <= 0) return null;
  for (const b of table) if (collectedJpy <= b.max_jpy) return b.fee_jpy;
  return null;
}

export interface CodOfferInput {
  mode: "full" | "layaway";
  currency: string;
  /** Delivery country, upper-case ISO. */
  country: string | null | undefined;
  codMode: CodMode;
  /** Amount the courier would collect, before the fee, in yen. */
  collectedJpy: number;
  table: readonly CodBracket[] | null;
}

/**
 * Why COD is greyed, or null when it is offered. One reason, the first that
 * fails, in the same order as the checkout's other methods:
 *   layaway | currency_not_yen | off | address_not_jp | nothing_to_collect | over_cod_limit
 */
export function codNotOfferedReason(i: CodOfferInput): string | null {
  if (i.mode === "layaway") return "layaway";
  if (i.currency !== "JPY") return "currency_not_yen";
  if (i.codMode !== "on" || !i.table || !codFeeTableValid(i.table as unknown)) return "off";
  if (String(i.country ?? "").trim().toUpperCase() !== "JP") return "address_not_jp";
  if (!(i.collectedJpy > 0)) return "nothing_to_collect";
  if (codFeeJpy(i.collectedJpy, i.table) === null) return "over_cod_limit";
  return null;
}

/**
 * A customer may never file a cash-on-delivery payment herself: the courier
 * collects it and STAFF record the full amount, with the courier's remittance
 * statement as proof (owner plan 2026-10-10). Nor may she file any payment on
 * an order she is paying on delivery. null = she may; otherwise the refusal code.
 */
export function customerFilingRefusal(submittedMethod: unknown, orderMethod: unknown): string | null {
  if (isCodMethod(submittedMethod)) return "cod_staff_only";
  if (String(orderMethod ?? "").trim().toLowerCase() === "cod") return "cod_paid_on_delivery";
  return null;
}

/** A payment method that means cash on delivery, in any of the spellings staff or the registry use. */
export function isCodMethod(method: unknown): boolean {
  const m = String(method ?? "").trim().toLowerCase().replace(/[\s-]+/g, " ");
  return m === "cod" || m === "cash on delivery" || m === "代金引換" || m === "代引";
}

/**
 * Owner decision 2026-10-10 (QA reassessment F2): the courier remits the FULL
 * amount collected, so a cash-on-delivery payment is recorded only as the
 * order's whole remaining balance — never part of it. A partly paid order
 * accepts exactly what remains. Other methods keep partial payments.
 * null = allowed; otherwise "cod_full_amount_only".
 */
export function codAmountRefusal(submittedMethod: unknown, submittedAmount: number, remainingBalance: number): string | null {
  if (!isCodMethod(submittedMethod)) return null;
  return Math.abs(Number(submittedAmount) - Number(remainingBalance)) > 0.005 ? "cod_full_amount_only" : null;
}
