import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WEB_METHODS, WEB_METHOD_LABEL, webMethodOf } from "@/lib/web-payment-method";
import { parseCodTable, codEffect } from "@/components/settings/cod-settings";
import { computeWebDraftFigures } from "../../supabase/functions/_shared/web-draft-figures.ts";

/**
 * Cash on delivery (代金引換) in the Hub — owner plan 2026-10-10, docs/COD.md.
 * Labels, the settings card's table check, the review screen's figures (fee
 * re-bracketed by the SQL rule, no deadline), and the page wiring.
 */

type Rec = Record<string, unknown>;
const TABLE = [[10000, 1040], [30000, 1150], [100000, 1370], [300000, 1810]] as const;
const sqlFee = (c: number) => (c <= 0 ? null : TABLE.find(([max]) => c <= max)?.[1] ?? null);

function fakeClient() {
  const calls: string[] = [];
  return {
    calls,
    client: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      rpc: async (name: string, args: Rec) => {
        calls.push(name);
        if (name === "cod_fee_jpy") return { data: sqlFee(Number(args.p_collected)), error: null };
        if (name === "web_deposit_deadline_hours") return { data: 72, error: null };
        return { data: null, error: new Error(`unexpected rpc ${name}`) };
      },
    },
  };
}
const codDraft: Rec = {
  customer_id: "c1", mode: "full", settlement_currency: "JPY", fx_rate: null, payment_method: "cod",
  subtotal: 20000, subtotal_jpy: 20000, shipping: 0, term_months: null, points_value: 0,
};

describe("labels", () => {
  it("cod is its own method, never transfer", () => {
    expect(webMethodOf("cod")).toBe("cod");
    expect(WEB_METHOD_LABEL.cod).toMatch(/Cash on delivery/);
    expect(WEB_METHODS).toContain("cod");
    expect(webMethodOf(null)).toBe("transfer");
  });
});

describe("settings card table check (mirrors cod_fee_table_valid)", () => {
  it("accepts the owner's table and refuses bad rows", () => {
    expect(parseCodTable(TABLE.map(([m, f]) => ({ max: String(m), fee: String(f) })))).toEqual({
      rows: TABLE.map(([max_jpy, fee_jpy]) => ({ max_jpy, fee_jpy })),
    });
    expect(parseCodTable([{ max: "30000", fee: "1" }, { max: "10000", fee: "1" }])).toHaveProperty("problem");
    expect(parseCodTable([{ max: "10000", fee: "1.5" }])).toHaveProperty("problem");
    expect(parseCodTable([])).toHaveProperty("problem");
    expect(codEffect("off")).toMatch(/not offered/);
  });
});

describe("review screen figures for a COD draft", () => {
  it("adds the bracketed fee to the total, no deadline, loyalty excludes the fee", async () => {
    const { client, calls } = fakeClient();
    const f = await computeWebDraftFigures(client, codDraft, {});
    expect(f.errors).toEqual([]);
    expect(f.cod_fee).toBe(1150);
    expect(f.total).toBe(21150);
    expect(f.due_now).toBe(21150);
    expect(f.transfer_due_at).toBeNull();
    expect(calls).not.toContain("web_deposit_deadline_hours");
    expect(f.loyalty_jpy_amount).toBe(20000);
  });
  it("re-brackets after staff edits (discount moves it down a bracket)", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, codDraft, { discount: 10500 });
    expect(f.cod_fee).toBe(1040);
    expect(f.total).toBe(9500 + 1040);
  });
  it("refuses over the limit and when points leave nothing to collect", async () => {
    const { client } = fakeClient();
    expect((await computeWebDraftFigures(client, { ...codDraft, subtotal: 300001, subtotal_jpy: 300001 }, {})).errors).toContain("over_cod_limit");
    expect((await computeWebDraftFigures(client, { ...codDraft, points_value: 20000 }, {})).errors).toContain("cod_nothing_to_collect");
  });
  it("a transfer draft is unchanged (no fee, a deadline)", async () => {
    const { client, calls } = fakeClient();
    const f = await computeWebDraftFigures(client, { ...codDraft, payment_method: "transfer" }, {});
    expect(f.cod_fee).toBe(0);
    expect(f.total).toBe(20000);
    expect(f.transfer_due_at).not.toBeNull();
    expect(calls).not.toContain("cod_fee_jpy");
  });
});

describe("page wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("Website → Settings shows the COD card to admins only", () => {
    expect(read("src/pages/Website.tsx")).toMatch(/\{isAdmin && \(\s*<section id=\{WEBSITE_SETTINGS_SECTIONS\.cod\}[^>]*>\s*<CodSettingsCard \/>/);
  });
  it("cash order: fee row, no Expires tile and no deadline card for COD", () => {
    const s = read("src/pages/CashOrderDetail.tsx");
    expect(s).toContain('data-testid="cash-order-cod-fee"');
    expect(s).toContain("webMethodOf(order.payment_method) !== 'cod') || order.status === 'expired'");
    expect(s).toContain('data-testid="cash-order-cod-no-deadline"');
  });
  it("review screen: fee row and no deadline input for COD; the dialog warns that the total changes", () => {
    expect(read("src/pages/WebOrderReview.tsx")).toContain('data-testid="web-review-cod-fee"');
    expect(read("src/pages/WebOrderReview.tsx")).toContain('data-testid="web-review-cod-no-deadline"');
    expect(read("src/components/web-orders/ChangePaymentMethodDialog.tsx")).toContain('data-testid="cod-fee-warning"');
  });
});
