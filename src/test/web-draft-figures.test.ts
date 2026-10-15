import { describe, expect, it } from "vitest";
import { computeWebDraftFigures } from "../../supabase/functions/_shared/web-draft-figures.ts";

/**
 * Website orders PR 4 — the review screen's money (docs/WEB-ORDER-DRAFTS.md).
 * computeWebDraftFigures is what confirm-web-draft uses for BOTH the preview
 * and the confirm. A fake client stands in for the three reads.
 */

type Rec = Record<string, unknown>;

function fakeClient(opts: { tier?: string | null; hours?: number; quote?: (args: Rec) => Rec } = {}) {
  const calls: { rpc: string; args: Rec }[] = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: opts.tier ? { current_tier_id: "t1", current_tier: { name: opts.tier } } : null,
          }),
        }),
      }),
    }),
    rpc: async (name: string, args: Rec) => {
      calls.push({ rpc: name, args });
      if (name === "web_deposit_deadline_hours") return { data: opts.hours ?? 24, error: null };
      if (name === "layaway_quote") return { data: (opts.quote ?? defaultQuote)(args), error: null };
      return { data: null, error: new Error(`unexpected rpc ${name}`) };
    },
  };
  return { client, calls };
}

// The live rule: total = price + shipping + services; deposit 30% of the total.
function defaultQuote(a: Rec): Rec {
  const total = Number(a.p_price) + Number(a.p_shipping) + Number(a.p_services);
  const deposit = Math.round(total * 0.3);
  const term = Number(a.p_term_months);
  const base = Math.floor((total - deposit) / term);
  const rem = total - deposit - base * term;
  return {
    eligible: true, term_downgraded: false, total, deposit, max_term_months: 6,
    schedule: Array.from({ length: term }, (_, i) => ({
      installment_number: i + 1, due_date: `2026-${String(11 + i).padStart(2, "0")}-01`, amount: base + (i === term - 1 ? rem : 0),
    })),
  };
}

const cashDraft: Rec = {
  customer_id: "c1", mode: "full", settlement_currency: "JPY", fx_rate: null,
  subtotal: 20000, subtotal_jpy: 20000, shipping: 800, term_months: null,
};

describe("cash order figures", () => {
  it("pieces + carried shipping + services − discount; loyalty = pieces − discount; the customer's deadline rule", async () => {
    const { client } = fakeClient({ hours: 72 });
    const f = await computeWebDraftFigures(client, cashDraft, {
      discount: 1000, service_lines: [{ title: "Resize", amount: 3000 }],
    });
    expect(f.errors).toEqual([]);
    expect(f.shipping).toBe(800);
    expect(f.shipping_from_checkout).toBe(true);
    expect(f.total).toBe(20000 + 800 + 3000 - 1000);
    expect(f.loyalty_jpy_amount).toBe(19000);
    expect(f.deadline_hours).toBe(72);
    expect(f.transfer_due_at).toBeTruthy();
    expect(f.layaway).toBeNull();
  });

  it("staff can change the shipping; 0 is a real figure", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, cashDraft, { shipping: 0 });
    expect(f.shipping).toBe(0);
    expect(f.total).toBe(20000);
  });

  it("shipping left for confirmation must be entered", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, { ...cashDraft, shipping: null }, {});
    expect(f.errors).toContain("shipping_required");
  });

  it("amounts must be whole and not negative", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, cashDraft, {
      shipping: 800.5, discount: -1, service_lines: [{ title: "", amount: 10 }],
    });
    expect(f.errors).toEqual(expect.arrayContaining([
      "shipping_invalid", "discount_invalid", "service_lines[0].title_required",
    ]));
  });

  it("a discount larger than the pieces is refused", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, cashDraft, { discount: 20001 });
    expect(f.errors).toContain("discount_exceeds_products");
  });

  it("a loyalty member needs a loyalty amount above 0", async () => {
    const { client } = fakeClient({ tier: "Radiant" });
    const f = await computeWebDraftFigures(client, cashDraft, { loyalty_jpy_amount: 0 });
    expect(f.errors).toContain("LOYALTY_AMOUNT_REQUIRED");
    expect(f.loyalty_tier).toBe("Radiant");
    const ok = await computeWebDraftFigures(client, cashDraft, {});
    expect(ok.errors).toEqual([]);
  });

  it("a typed deadline is used as typed, and the rule is not asked", async () => {
    const { client, calls } = fakeClient();
    const f = await computeWebDraftFigures(client, cashDraft, { transfer_due_at: "2026-10-02T09:00:00Z" });
    expect(f.transfer_due_at).toBe("2026-10-02T09:00:00.000Z");
    expect(calls.some((c) => c.rpc === "web_deposit_deadline_hours")).toBe(false);
  });
});

describe("peso orders", () => {
  it("the loyalty basis stays yen: a peso discount is taken off at ÷ rate (JPY = PHP ÷ rate)", async () => {
    const { client } = fakeClient();
    const draft = { ...cashDraft, settlement_currency: "PHP", fx_rate: 0.4, subtotal: 8000, subtotal_jpy: 20000, shipping: null };
    const f = await computeWebDraftFigures(client, draft, { shipping: 1500, discount: 400 });
    expect(f.errors).toEqual([]);
    expect(f.total).toBe(8000 + 1500 - 400);
    expect(f.loyalty_jpy_amount).toBe(20000 - 1000);
  });
});

describe("layaway figures", () => {
  const lay: Rec = { ...cashDraft, mode: "layaway", term_months: 6, subtotal: 400000, subtotal_jpy: 400000, shipping: 0 };

  it("deposit and schedule come from layaway_quote with price = pieces − discount, plus shipping and services", async () => {
    const { client, calls } = fakeClient();
    const f = await computeWebDraftFigures(client, lay, {
      shipping: 1500, discount: 10000, service_lines: [{ title: "Resize", amount: 5000 }],
    });
    const q = calls.find((c) => c.rpc === "layaway_quote")!;
    expect(q.args).toMatchObject({ p_price: 390000, p_term_months: 6, p_currency: "JPY", p_shipping: 1500, p_services: 5000 });
    expect(f.errors).toEqual([]);
    expect(f.total).toBe(396500);
    expect(f.layaway?.deposit).toBe(Math.round(396500 * 0.3));
    expect((f.layaway?.schedule as unknown[]).length).toBe(6);
  });

  it("below the term's minimum (or a downgraded term) is refused", async () => {
    const { client } = fakeClient({ quote: (a) => ({ ...defaultQuote(a), eligible: true, term_downgraded: true }) });
    const f = await computeWebDraftFigures(client, lay, {});
    expect(f.errors).toContain("below_plan_minimum");
  });

  it("a quote that disagrees with the total is never confirmed", async () => {
    const { client } = fakeClient({ quote: (a) => ({ ...defaultQuote(a), total: 1 }) });
    const f = await computeWebDraftFigures(client, lay, {});
    expect(f.errors).toContain("quote_total_mismatch");
  });
});

describe("website coupon (owner 2026-10-15)", () => {
  // The draft stores its figures AFTER the coupon (¥20,000 pieces − ¥2,000).
  const couponDraft: Rec = {
    ...cashDraft, subtotal: 18000, subtotal_jpy: 18000,
    coupon_code: "SAVE10", coupon_discount: 2000, coupon_discount_jpy: 2000,
  };

  it("an empty Discount box defaults to the coupon; products show the full pieces price; the coupon is counted once", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, couponDraft, {});
    expect(f.errors).toEqual([]);
    expect(f.products).toBe(20000);
    expect(f.discount).toBe(2000);
    expect(f.coupon_code).toBe("SAVE10");
    expect(f.coupon_discount).toBe(2000);
    expect(f.total).toBe(20000 + 800 - 2000);
    expect(f.loyalty_jpy_amount).toBe(18000);
  });

  it("a typed discount lower than the coupon is refused", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, couponDraft, { discount: 1500 });
    expect(f.errors).toContain("discount_below_coupon");
  });

  it("staff may add to the coupon: the whole discount comes off once", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, couponDraft, { discount: 3000 });
    expect(f.errors).toEqual([]);
    expect(f.total).toBe(20000 + 800 - 3000);
    expect(f.loyalty_jpy_amount).toBe(17000);
  });

  it("a layaway is priced on pieces − coupon", async () => {
    const { client, calls } = fakeClient();
    const f = await computeWebDraftFigures(client, { ...couponDraft, mode: "layaway", term_months: 3 }, {});
    expect(f.errors).toEqual([]);
    expect(calls.find((c) => c.rpc === "layaway_quote")?.args.p_price).toBe(18000);
  });

  it("without a coupon nothing changes", async () => {
    const { client } = fakeClient();
    const f = await computeWebDraftFigures(client, cashDraft, {});
    expect(f.products).toBe(20000);
    expect(f.discount).toBe(0);
    expect(f.coupon_code).toBeNull();
    expect(f.coupon_discount).toBe(0);
  });
});
