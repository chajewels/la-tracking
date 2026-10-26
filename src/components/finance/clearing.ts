/**
 * Clearing & FX (Expenses Phase 6, owner 2026-10-26 D1–D6). Pure rules, no React.
 * Finance → Ledger → "Clearing & FX": what Square / Paidy / Stripe / the COD courier still owe (the clearing
 * accounts), the payouts and statements finance records, transfers between the company's own accounts, and
 * the month-end peso revaluation the engine posts.
 */

export const CLEARING_KEY = ["finance", "ledger", "clearing"] as const;
export const FX_KEY = ["finance", "ledger", "fx"] as const;
export const RATE_HISTORY_KEY = ["finance", "ledger", "rate-history"] as const;

export type Provider = "square" | "paidy" | "stripe" | "cod_carrier";
export const PROVIDER_LABEL: Record<Provider, string> = { square: "Square", paidy: "Paidy", stripe: "Stripe (konbini)", cod_carrier: "COD courier" };
export const PROVIDERS: Provider[] = ["square", "paidy", "stripe", "cod_carrier"];

export type ProviderRow = {
  provider: Provider; account: string; name: string;
  captured_jpy: number; fees_jpy: number; refunds_jpy: number; payouts_jpy: number; adjustments_jpy: number; balance_jpy: number; oldest_open: string | null;
};
export type Settlement = {
  id: string; provider: Provider; received_on: string; period_from: string | null; period_to: string | null;
  amount_received_jpy: number; fees_jpy: number; adjustments_jpy: number; bank_account: string | null; reference: string | null; note: string | null;
  created_at: string; voided_at: string | null; void_reason: string | null;
};
export type Transfer = {
  id: string; transfer_on: string; from_account: string; from_amount: number; from_currency: "JPY" | "PHP"; to_account: string; to_amount: number; to_currency: "JPY" | "PHP";
  fee_amount: number; fee_currency: "JPY" | "PHP"; fee_account: string; reference: string | null; note: string | null; fx_jpy: number;
  created_at: string; voided_at: string | null; void_reason: string | null;
};
export type MoneyAccount = { code: string; name: string; currency_hint: "JPY" | "PHP" | null };
export type ClearingSummary = {
  ledger_start: string | null; can_post: boolean; providers: ProviderRow[]; settlements: Settlement[]; transfers: Transfer[]; accounts: MoneyAccount[];
};
export type FxRow = {
  account: string; name: string; kind: string; native_php: number; carrying_jpy: number; target_jpy: number; cumulative_jpy: number; previous_cumulative_jpy: number; increment_jpy: number;
};
export type FxRevaluation = { month: string; month_end: string; rate_used: number; posted: boolean; rows: FxRow[] };
export type RateHistory = { current: number | null; can_set: boolean; history: { effective_from: string; rate: number; set_by: string | null; created_at: string }[] };

const num = (v: unknown, d = 0) => (v == null || v === "" ? d : Number(v));

export function normaliseClearing(raw: Record<string, unknown>): ClearingSummary {
  const arr = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as Record<string, unknown>[]) : []);
  return {
    ledger_start: (raw.ledger_start as string | null) ?? null,
    can_post: raw.can_post === true,
    providers: arr("providers").map((p) => ({
      provider: p.provider as Provider, account: String(p.account), name: String(p.name ?? ""),
      captured_jpy: num(p.captured_jpy), fees_jpy: num(p.fees_jpy), refunds_jpy: num(p.refunds_jpy), payouts_jpy: num(p.payouts_jpy),
      adjustments_jpy: num(p.adjustments_jpy), balance_jpy: num(p.balance_jpy), oldest_open: (p.oldest_open as string | null) ?? null,
    })),
    settlements: arr("settlements").map((s) => ({
      ...(s as unknown as Settlement), amount_received_jpy: num(s.amount_received_jpy), fees_jpy: num(s.fees_jpy), adjustments_jpy: num(s.adjustments_jpy),
    })),
    transfers: arr("transfers").map((t) => ({
      ...(t as unknown as Transfer), from_amount: num(t.from_amount), to_amount: num(t.to_amount), fee_amount: num(t.fee_amount), fx_jpy: num(t.fx_jpy),
    })),
    accounts: arr("accounts").map((a) => ({ code: String(a.code), name: String(a.name ?? ""), currency_hint: (a.currency_hint as "JPY" | "PHP" | null) ?? null })),
  };
}

export function normaliseFx(raw: Record<string, unknown>): FxRevaluation {
  return {
    month: String(raw.month ?? ""), month_end: String(raw.month_end ?? ""), rate_used: num(raw.rate_used), posted: raw.posted === true,
    rows: (Array.isArray(raw.rows) ? (raw.rows as Record<string, unknown>[]) : []).map((r) => ({
      account: String(r.account), name: String(r.name ?? ""), kind: String(r.kind ?? ""), native_php: num(r.native_php), carrying_jpy: num(r.carrying_jpy),
      target_jpy: num(r.target_jpy), cumulative_jpy: num(r.cumulative_jpy), previous_cumulative_jpy: num(r.previous_cumulative_jpy), increment_jpy: num(r.increment_jpy),
    })),
  };
}

export function normaliseRateHistory(raw: Record<string, unknown>): RateHistory {
  return {
    current: raw.current == null ? null : Number(raw.current),
    can_set: raw.can_set === true,
    history: (Array.isArray(raw.history) ? (raw.history as Record<string, unknown>[]) : []).map((h) => ({
      effective_from: String(h.effective_from), rate: num(h.rate), set_by: (h.set_by as string | null) ?? null, created_at: String(h.created_at ?? ""),
    })),
  };
}

/** "₱1 = ¥2.38" from a PHP-per-JPY rate. */
export function yenPerPeso(rate: number | null): string {
  if (!rate || rate <= 0) return "rate not set";
  return `₱1 = ¥${(1 / rate).toFixed(2)}`;
}

/** What a provider still owes, in the owner's words. */
export function providerStatus(p: ProviderRow): string {
  if (p.balance_jpy === 0) return "Settled";
  if (p.balance_jpy > 0) return `Owed to us${p.oldest_open ? ` · oldest capture ${p.oldest_open}` : ""}`;
  return "Statement recorded before the captures (negative — check the payout / capture dates)";
}

export type SettlementForm = { provider: Provider; received_on: string; period_from: string; period_to: string; amount_received_jpy: string; fees_jpy: string; adjustments_jpy: string; bank_account: string; reference: string; note: string };
export function emptySettlementForm(today: string, provider: Provider = "square"): SettlementForm {
  return { provider, received_on: today, period_from: "", period_to: "", amount_received_jpy: "", fees_jpy: "", adjustments_jpy: "", bank_account: "", reference: "", note: "" };
}
const yenOk = (v: string) => v.trim() === "" || /^-?\d+$/.test(v.trim().replace(/[¥,\s]/g, ""));
export function settlementProblem(f: SettlementForm, ledgerStart: string | null, today: string): string | null {
  if (!f.received_on) return "Pick the date the money (or statement) arrived.";
  if (f.received_on > today) return "That date is in the future.";
  if (ledgerStart && f.received_on < ledgerStart) return "Before the ledger start.";
  if (!yenOk(f.amount_received_jpy) || !yenOk(f.fees_jpy) || !yenOk(f.adjustments_jpy)) return "Whole yen only.";
  const amt = Number(f.amount_received_jpy.replace(/[¥,\s]/g, "") || 0), fee = Number(f.fees_jpy.replace(/[¥,\s]/g, "") || 0), adj = Number(f.adjustments_jpy.replace(/[¥,\s]/g, "") || 0);
  if (amt < 0 || fee < 0) return "Amount received and fees cannot be negative.";
  if (amt === 0 && fee === 0 && adj === 0) return "Enter the amount received, the fees, or an adjustment.";
  if (amt > 0 && !f.bank_account) return "Which bank account received the money?";
  if (f.period_from && f.period_to && f.period_from > f.period_to) return "The period ends before it starts.";
  return null;
}
export function settlementPayload(f: SettlementForm) {
  const clean = (v: string) => v.trim().replace(/[¥,\s]/g, "");
  return {
    provider: f.provider, received_on: f.received_on, period_from: f.period_from || null, period_to: f.period_to || null,
    amount_received_jpy: clean(f.amount_received_jpy) || "0", fees_jpy: clean(f.fees_jpy) || "0", adjustments_jpy: clean(f.adjustments_jpy) || "0",
    bank_account: f.bank_account || null, reference: f.reference.trim() || null, note: f.note.trim() || null,
  };
}

export type TransferForm = { transfer_on: string; from_account: string; from_amount: string; from_currency: "JPY" | "PHP"; to_account: string; to_amount: string; to_currency: "JPY" | "PHP"; fee_amount: string; fee_currency: "JPY" | "PHP"; reference: string; note: string };
export function emptyTransferForm(today: string): TransferForm {
  return { transfer_on: today, from_account: "", from_amount: "", from_currency: "JPY", to_account: "", to_amount: "", to_currency: "PHP", fee_amount: "", fee_currency: "JPY", reference: "", note: "" };
}
const amountOk = (v: string, cur: "JPY" | "PHP", allowEmpty = false) => {
  const t = v.trim().replace(/[¥₱,\s]/g, "");
  if (t === "") return allowEmpty;
  return cur === "JPY" ? /^\d+$/.test(t) : /^\d+(\.\d{1,2})?$/.test(t);
};
export function transferProblem(f: TransferForm, ledgerStart: string | null, today: string): string | null {
  if (!f.transfer_on) return "Pick the transfer date.";
  if (f.transfer_on > today) return "That date is in the future.";
  if (ledgerStart && f.transfer_on < ledgerStart) return "Before the ledger start.";
  if (!f.from_account || !f.to_account) return "Pick both accounts.";
  if (f.from_account === f.to_account) return "From and to are the same account.";
  if (!amountOk(f.from_amount, f.from_currency) || !amountOk(f.to_amount, f.to_currency)) return f.from_currency === "JPY" && f.to_currency === "JPY" ? "Whole yen only." : "Enter both amounts (whole yen; pesos to 2 decimals).";
  if (!amountOk(f.fee_amount, f.fee_currency, true)) return "Check the fee.";
  if (Number(f.from_amount.replace(/[¥₱,\s]/g, "")) <= 0 || Number(f.to_amount.replace(/[¥₱,\s]/g, "")) <= 0) return "Amounts must be above zero.";
  if (f.from_currency === f.to_currency) {
    const from = Number(f.from_amount.replace(/[¥₱,\s]/g, "")), to = Number(f.to_amount.replace(/[¥₱,\s]/g, "")), fee = Number(f.fee_amount.replace(/[¥₱,\s]/g, "") || 0);
    if (fee > 0 && f.fee_currency !== f.from_currency) return "Same currency: the fee must be in that currency too.";
    if (Math.abs(from - (to + fee)) > 0.001) return "Same currency: the amount sent must equal the amount received plus the fee.";
  }
  return null;
}
export function transferPayload(f: TransferForm) {
  const clean = (v: string) => v.trim().replace(/[¥₱,\s]/g, "");
  return {
    transfer_on: f.transfer_on, from_account: f.from_account, from_amount: clean(f.from_amount), from_currency: f.from_currency,
    to_account: f.to_account, to_amount: clean(f.to_amount), to_currency: f.to_currency,
    fee_amount: clean(f.fee_amount) || "0", fee_currency: f.fee_currency, fee_account: "6300", reference: f.reference.trim() || null, note: f.note.trim() || null,
  };
}

/** Realised FX on a transfer, in words: positive = we received more yen value than we sent. */
export function fxLabel(fxJpy: number): string {
  if (fxJpy === 0) return "no FX difference";
  return fxJpy > 0 ? `FX gain ¥${Math.abs(fxJpy).toLocaleString("en-US")}` : `FX loss ¥${Math.abs(fxJpy).toLocaleString("en-US")}`;
}

export function clearingRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "You don't have permission for this.";
    case "invalid_provider": return "Pick Square, Paidy, Stripe or the COD courier.";
    case "invalid_date": return "Check the date (not in the future, not before the ledger start).";
    case "invalid_amount": return "Whole yen; the settlement needs an amount, fees or an adjustment.";
    case "invalid_account": return "Pick a bank or cash account (not a receivable or a provider clearing account).";
    case "invalid_currency": return "Pick ¥ or ₱ for each leg.";
    case "amounts_differ": return "Same currency: sent must equal received plus the fee (fee in that currency).";
    case "date_after_latest": return "A dated rate must be earlier than the latest rate on record — set today's rate under Settings instead.";
    case "period_closed": return "That month is closed — reopen it first or use the current month.";
    case "reason_required": return "Say why (3 characters or more).";
    case "already_voided": return "Already voided.";
    case "not_found": return "That record is gone.";
    case "invalid_rate": return "Enter the rate as pesos per yen (e.g. 0.42).";
    case "ledger_start_not_set": return "Set the ledger start first.";
    default: return "";
  }
}
