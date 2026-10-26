import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  clearingRefusal, emptySettlementForm, emptyTransferForm, fxLabel, normaliseClearing, normaliseFx, normaliseRateHistory, providerStatus,
  settlementPayload, settlementProblem, transferPayload, transferProblem, yenPerPeso,
} from "@/components/finance/clearing";
import { AUTO_BOOKED_SYSTEM_KEYS, canEnterManually, expenseRefusal, refusalCode } from "@/components/finance/expenses";
import { SOURCE_TYPE_LABEL } from "@/components/finance/ledger";

/**
 * Clearing & FX (Expenses Phase 6, owner 2026-10-26 D1–D6): settlement / transfer forms, the provider status
 * wording, the rate display, fee categories hidden from the manual picker, and the wiring (events, tab, trigger).
 */

describe("clearing — forms", () => {
  const today = "2026-10-26";
  it("settlement: validation and payload", () => {
    const f = emptySettlementForm(today, "square");
    expect(settlementProblem(f, "2026-06-01", today)).toBe("Enter the amount received, the fees, or an adjustment.");
    expect(settlementProblem({ ...f, amount_received_jpy: "¥29,025" }, "2026-06-01", today)).toBe("Which bank account received the money?");
    expect(settlementProblem({ ...f, amount_received_jpy: "29025.5", bank_account: "1101" }, "2026-06-01", today)).toBe("Whole yen only.");
    expect(settlementProblem({ ...f, fees_jpy: "550" }, "2026-06-01", today)).toBeNull();
    expect(settlementProblem({ ...f, fees_jpy: "550", received_on: "2026-05-01" }, "2026-06-01", today)).toBe("Before the ledger start.");
    expect(settlementProblem({ ...f, fees_jpy: "550", received_on: "2026-11-01" }, null, today)).toBe("That date is in the future.");
    expect(settlementProblem({ ...f, fees_jpy: "550", period_from: "2026-07-01", period_to: "2026-06-01" }, null, today)).toBe("The period ends before it starts.");
    expect(settlementPayload({ ...f, amount_received_jpy: "¥29,025", bank_account: "1101", adjustments_jpy: "-100", reference: " SQ-1 " })).toMatchObject({
      provider: "square", amount_received_jpy: "29025", fees_jpy: "0", adjustments_jpy: "-100", bank_account: "1101", reference: "SQ-1", period_from: null, note: null,
    });
  });
  it("transfer: validation and payload", () => {
    const f = { ...emptyTransferForm(today), from_account: "1101", to_account: "1111", from_amount: "100,000", to_amount: "38000", fee_amount: "880" };
    expect(transferProblem(f, "2026-06-01", today)).toBeNull();
    expect(transferProblem({ ...f, to_account: "1101" }, null, today)).toBe("From and to are the same account.");
    expect(transferProblem({ ...f, to_amount: "38000.555" }, null, today)).toBe("Enter both amounts (whole yen; pesos to 2 decimals).");
    expect(transferProblem({ ...f, to_currency: "JPY", to_amount: "99000" }, null, today)).toBe("Same currency: the amount sent must equal the amount received (plus the fee).");
    expect(transferProblem({ ...f, to_currency: "JPY", to_amount: "99120" }, null, today)).toBeNull();
    expect(transferProblem({ ...f, to_currency: "JPY", to_amount: "100000" }, null, today)).toBeNull();
    expect(transferProblem({ ...f, from_amount: "0" }, null, today)).toBe("Amounts must be above zero.");
    expect(transferPayload(f)).toMatchObject({ from_amount: "100000", to_amount: "38000", fee_amount: "880", fee_account: "6300", to_currency: "PHP" });
    expect(fxLabel(0)).toBe("no FX difference");
    expect(fxLabel(-8644)).toBe("FX loss ¥8,644");
    expect(fxLabel(120)).toBe("FX gain ¥120");
  });
  it("normalises and words the provider status", () => {
    const c = normaliseClearing({ ledger_start: "2026-06-01", can_post: true, providers: [{ provider: "square", account: "1130", name: "Square clearing", captured_jpy: "30000", fees_jpy: "975", payouts_jpy: "29025", balance_jpy: "0", oldest_open: null }, { provider: "cod_carrier", account: "1140", name: "COD", balance_jpy: "20000", oldest_open: "2026-06-08" }], settlements: [], transfers: [{ id: "t", fx_jpy: "-8644", from_amount: "100000", to_amount: "38000", fee_amount: "880" }], accounts: [] });
    expect(c.providers[0]).toMatchObject({ balance_jpy: 0, fees_jpy: 975 });
    expect(providerStatus(c.providers[0])).toBe("Settled");
    expect(providerStatus(c.providers[1])).toBe("Owed to us · oldest capture 2026-06-08");
    expect(providerStatus({ ...c.providers[0], balance_jpy: -650 })).toMatch(/negative/);
    expect(c.transfers[0].fx_jpy).toBe(-8644);
    expect(normaliseFx({ month: "2026-07-01", month_end: "2026-07-31", rate_used: "0.4", posted: true, rows: [{ account: "1111", native_php: "118000", carrying_jpy: "280952", target_jpy: "295000", increment_jpy: "14048" }] }).rows[0].increment_jpy).toBe(14048);
    expect(normaliseRateHistory({ current: "0.42", can_set: true, history: [{ effective_from: "2026-03-27", rate: "0.42" }] }).history[0].rate).toBe(0.42);
    expect(yenPerPeso(0.42)).toBe("₱1 = ¥2.38");
    expect(yenPerPeso(null)).toBe("rate not set");
    expect(clearingRefusal("amounts_differ")).toContain("Same currency");
  });
});

describe("clearing — fee categories and wiring", () => {
  it("provider fee categories are automatic now", () => {
    expect(AUTO_BOOKED_SYSTEM_KEYS).toEqual(["payroll", "commission", "square_fees", "paidy_fees", "stripe_fees"]);
    expect(canEnterManually({ active: true, system_key: "square_fees" })).toBe(false);
    expect(canEnterManually({ active: true, system_key: "paidy_fees" })).toBe(false);
    expect(refusalCode({ code: "23514", message: "category_booked_automatically" })).toBe("category_booked_automatically");
    expect(expenseRefusal("category_booked_automatically")).toContain("Clearing");
  });
  it("ledger labels, tab, migration", () => {
    const read = (p: string) => readFileSync(p, "utf8");
    for (const k of ["square_fee", "settlement_payout", "settlement_fee", "settlement_adjustment", "fund_transfer", "fx_revaluation"]) expect(SOURCE_TYPE_LABEL[k]).toBeTruthy();
    const tab = read("src/components/finance/LedgerTab.tsx");
    expect(tab).toContain('<TabsTrigger value="clearing">Clearing &amp; FX</TabsTrigger>');
    expect(tab).toContain("<ClearingFxSection");
    const section = read("src/components/finance/ClearingFxSection.tsx");
    for (const rpc of ["get_clearing_summary", "record_provider_settlement", "void_provider_settlement", "record_fund_transfer", "void_fund_transfer", "get_fx_revaluation", "get_rate_history"]) expect(section).toContain(`"${rpc}"`);
    const sql = read("supabase/migrations/20270105100000_expenses_clearing_fx.sql");
    for (const k of ["'square_fee'", "'settlement_payout'", "'settlement_fee'", "'settlement_adjustment'", "'fund_transfer'", "'fx_revaluation'"]) expect(sql).toContain(k);
    expect(sql).toContain("SELECT * FROM public.gl_clearing_events(p_until)");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.php_jpy_rate_history");
    expect(sql).toContain("system_settings_php_jpy_rate_log");
    expect(sql).toContain("a.kind IN ('asset', 'liability')");
    expect(sql).toContain("expenses_refuse_auto_fee_categories");
    expect(sql).toContain("'5400' ELSE '6300'");
    for (const b of (sql.match(/\$fn\$[\s\S]*?\$fn\$/g) ?? [])) expect(b).not.toMatch(/^\s*--/m);
  });
});
