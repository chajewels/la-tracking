import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as edge from "../../supabase/functions/_shared/settlement.ts";
import * as hub from "@/lib/web-settlement";

/**
 * PESO FULL PAYMENT ON THE WEBSITE (H1, 2026-09-25).
 *
 * The owner's rules this file holds the code to:
 *   - a peso full-payment quote and the order it becomes agree TO THE PESO,
 *     half-up (Postgres round(numeric));
 *   - the yen branch is unchanged;
 *   - loyalty is always the YEN value, on a peso order too;
 *   - peso layaway is unchanged.
 *
 * The Postgres figures below were produced by running
 * 20260925120000_peso_full_payment.sql's create_web_order_atomic in a scratch
 * postgres:15 (fixture + the reserve_first_a1 body, md5 bcb37311…) and reading
 * the orders it wrote. They are data, not a re-derivation: if the edge maths
 * drifts from what the SQL stores, these fail.
 *
 * The edge functions run under Deno and cannot be imported here, so their
 * WIRING is asserted on code with comment lines stripped (as
 * web-reservations.test.tsx does) — a comment mentioning a rule must not
 * satisfy it.
 */

const code = (f: string) =>
  readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const sqlCode = (s: string) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

const MIGRATION = "supabase/migrations/20260925120000_peso_full_payment.sql";
const A1 = "supabase/migrations/20260923140000_reserve_first_a1.sql";
const WEBSITE = "supabase/functions/website/index.ts";

/** scripts/function-drift-audit's comparator: md5 of the body, whitespace collapsed and trimmed. */
const bodyMd5 = (body: string) => createHash("md5").update(body.replace(/\s+/g, " ").trim()).digest("hex");
function webOrderBody(file: string): string {
  const s = readFileSync(file, "utf8");
  const start = s.search(/CREATE (OR REPLACE )?FUNCTION public\.create_web_order_atomic\(/);
  expect(start, `${file} defines create_web_order_atomic`).toBeGreaterThan(-1);
  const open = s.indexOf("AS $function$", start) + "AS $function$".length;
  return s.slice(open, s.indexOf("$function$", open));
}

// [yen, rate, what Postgres stored as round(yen * rate::numeric(12,6))]
const PG_ROUND: Array<[number, number, number]> = [
  // Exact .5 products — the half-up edge. Float Math.round gives ₱1 LESS on
  // each (the product lands at …4.99999999999 in binary floating point).
  [100000, 0.308345, 30835],
  [75000, 0.4337, 32528],
  [375000, 0.344228, 129086],
  // Ordinary products.
  [48500, 0.371235, 18005],
  [68000, 0.3745, 25466],
  [302977, 0.389999, 118161],
  [1500, 0.308345, 463],
  [1500, 0.4337, 651],
  [2980, 0.389999, 1162],
  [1, 0.5, 1],
  [0, 0.371235, 0],
];

describe("peso full payment — quote and order agree to the peso (half-up)", () => {
  it.each(PG_ROUND)("¥%i × %f → ₱%i, exactly as Postgres stores it", (jpy, rate, pg) => {
    expect(edge.jpyToPhpHalfUp(jpy, rate)).toBe(pg);
    expect(hub.jpyToPhpHalfUp(jpy, rate)).toBe(pg);
  });

  it("is the reason the peso full-payment quote no longer uses Math.round", () => {
    // Proof the edge case is real, not theoretical: float rounding misses all three.
    for (const [jpy, rate, pg] of PG_ROUND.slice(0, 3)) {
      expect(Math.round(jpy * rate)).toBe(pg - 1);
      expect(edge.jpyToPhpHalfUp(jpy, rate)).toBe(pg);
    }
  });

  // The whole order as create_web_order_atomic wrote it in the scratch run:
  // [total_jpy, shipping_jpy, rate, total_amount, shipping_fee]
  const ORDERS: Array<[number, number, number, number, number]> = [
    [100000, 1500, 0.308345, 30835, 463],
    [75000, 1500, 0.4337, 32528, 651],
    [375000, 0, 0.344228, 129086, 0],
    [48500, 1500, 0.371235, 18005, 557],
    [68000, 0, 0.3745, 25466, 0],
    [302977, 2980, 0.389999, 118161, 1162],
  ];
  it.each(ORDERS)("¥%i incl. ¥%i shipping at %f → order ₱%i, shipping ₱%i", (totalJpy, shipJpy, rate, total, ship) => {
    for (const m of [edge, hub]) {
      const q = m.settleFullPaymentInPhp(totalJpy, shipJpy, rate);
      expect(q.total).toBe(total);
      expect(q.shipping).toBe(ship);
      // Items are the remainder, so the three quoted figures always sum.
      expect(q.subtotal + (q.shipping ?? 0)).toBe(q.total);
    }
  });

  it("keeps a null shipping (no published rate) null", () => {
    expect(edge.settleFullPaymentInPhp(10000, null, 0.38)).toEqual({ total: 3800, shipping: null, subtotal: 3800 });
  });

  it("refuses a non-integer yen amount or a bad rate rather than guessing", () => {
    for (const m of [edge, hub]) {
      expect(() => m.jpyToPhpHalfUp(10.5, 0.38)).toThrow("bad_jpy_amount");
      expect(() => m.jpyToPhpHalfUp(-1, 0.38)).toThrow("bad_jpy_amount");
      expect(() => m.jpyToPhpHalfUp(100, 0)).toThrow("bad_fx_rate");
      expect(() => m.jpyToPhpHalfUp(100, Number.NaN)).toThrow("bad_fx_rate");
    }
  });

  it("twin files agree across a sweep of rates and amounts", () => {
    for (let micros = 300000; micros <= 450000; micros += 7919) {
      const rate = micros / 1e6;
      for (const jpy of [1, 99, 1500, 12345, 99999, 250000, 1234567, 99999999]) {
        expect(hub.jpyToPhpHalfUp(jpy, rate)).toBe(edge.jpyToPhpHalfUp(jpy, rate));
      }
    }
  });
});

describe("the migration starts from live and changes only what it says", () => {
  const migration = readFileSync(MIGRATION, "utf8");

  it("guards on the reserve_first_a1 body md5, and that IS the recorded A1 body", () => {
    expect(bodyMd5(webOrderBody(A1))).toBe("bcb37311b07b0935e3c05406083d68bc");
    expect(sqlCode(migration)).toMatch(/v_md5 <> 'bcb37311b07b0935e3c05406083d68bc'/);
  });

  it("post-checks the md5 of the body it actually contains", () => {
    const md5 = bodyMd5(webOrderBody(MIGRATION));
    expect(md5).toBe("38d1396df0eb23e4d2810b722cd51f5e");
    expect(sqlCode(migration)).toMatch(new RegExp(`v_md5 IS DISTINCT FROM '${md5}'`));
  });

  it("keeps the signature (no DROP, no second overload) and re-asserts service_role-only grants", () => {
    const sql = sqlCode(migration);
    expect(sql).not.toMatch(/DROP FUNCTION/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.create_web_order_atomic\(p_customer_id uuid, p_quote_id uuid, p_method text, p_lang text DEFAULT NULL::text, p_reserve boolean DEFAULT false\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.create_web_order_atomic\(uuid, uuid, text, text, boolean\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_web_order_atomic\(uuid, uuid, text, text, boolean\) TO service_role;/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it("does not touch the layaway writer or the layaway quote", () => {
    const sql = sqlCode(migration);
    expect(sql).not.toMatch(/FUNCTION public\.create_web_layaway_atomic/);
    expect(sql).not.toMatch(/FUNCTION public\.layaway_quote/);
    expect(sql).not.toMatch(/ALTER TABLE public\.layaway_accounts/);
  });
});

describe("yen full payment is unchanged", () => {
  const body = sqlCode(webOrderBody(MIGRATION));

  it("the yen branch writes the quote's yen figures, no rate", () => {
    expect(body).toMatch(/ELSE\s+v_currency := 'JPY';\s+v_rate\s+:= NULL;\s+v_total\s+:= v_quote\.total_jpy;\s+v_shipping := coalesce\(v_quote\.shipping_jpy, 0\);\s+END IF;/);
    // total_amount / remaining_balance / shipping_fee come from those variables.
    expect(body).toMatch(/v_currency::account_currency, v_total, 0,\s+v_total, 'pending'::cash_order_status/);
    expect(body).toMatch(/v_reference, v_due, v_due, v_shipping,/);
    expect(body).toMatch(/v_rate, CASE WHEN v_rate IS NULL THEN NULL ELSE v_quote\.fx_rate_date END/);
    // total_jpy stays in the result for storefront builds that read it.
    expect(body).toMatch(/'total_jpy', v_quote\.total_jpy,/);
  });

  it("the website quote converts only a PESO full payment with the integer helper", () => {
    const src = code(WEBSITE);
    expect(src).toMatch(/if \(mode === "full" && fxRate !== null\) \{[\s\S]{0,400}settleFullPaymentInPhp\(total, shipping, fxRate\)/);
    // GET /checkout/quote/:id re-derives the same figures from the saved quote.
    expect(src).toMatch(/if \(String\(row\.mode \?\? "full"\) === "full" && fxRate !== null\) \{\s+\(\{ total: totalSettle, shipping: shippingSettle, subtotal: subtotalSettle \} =\s+settleFullPaymentInPhp\(totalJpy, shippingJpy, fxRate\)\);/);
    // A yen quote never reads a rate, so toSettle is the identity for it.
    expect(src).toMatch(/const toSettle = \(jpy: number\) => \(fxRate === null \? jpy : Math\.round\(jpy \* fxRate\)\);/);
    expect(src).toMatch(/if \(settlement === "PHP"\) \{\s+const fx = await latestFx\(supabase\);\s+if \(!fx\) return jsonResponse\(\{ error: "fx_unavailable" \}, 503\);/);
  });

  it("Manage Invoice leaves a yen order's items subtotal in yen", () => {
    const staffRate = () => { throw new Error("a yen order must not read the staff rate"); };
    expect(hub.itemsSubtotalInOrderCurrency(68000, { currency: "JPY", fx_rate_used: null }, staffRate)).toBe(68000);
  });
});

describe("loyalty is always the YEN value", () => {
  const body = sqlCode(webOrderBody(MIGRATION));

  it("create_web_order_atomic writes loyalty_jpy_amount from the yen product subtotal on every order", () => {
    // The loyalty column is the one after shipping_fee in the INSERT list...
    expect(body).toMatch(/transfer_due_at, expires_at, shipping_fee,\s+loyalty_jpy_amount, item_description,/);
    // ...and its value is the quote's yen subtotal — never v_total or a converted figure.
    expect(body).toMatch(/v_due, v_due, v_shipping,\s+v_quote\.subtotal_jpy, 'Website order ' \|\| v_reference,/);
    expect(body).not.toMatch(/loyalty_jpy_amount\s*:?=\s*v_total/);
  });

  it("item lines stay in yen (the price of record)", () => {
    expect(body).toMatch(/v_qty, v_variant\.price_jpy, v_variant\.price_jpy \* v_qty/);
  });

  it("on a peso order the award basis equals the same order in yen (scratch run)", () => {
    // Scratch run: ¥98,500 × 1 + ¥1,500 shipping at 0.308345 stored
    // total_amount ₱30,835 and loyalty_jpy_amount ¥98,500 — the yen product
    // subtotal, identical to the yen order for the same cart.
    const subtotalJpy = 98500;
    const peso = edge.settleFullPaymentInPhp(subtotalJpy + 1500, 1500, 0.308345);
    expect(peso.total).toBe(30835);
    expect(Math.floor(subtotalJpy / 10000) * 100).toBe(900); // award-loyalty-points basis, Glimmer ×1
  });
});

describe("peso layaway is unchanged", () => {
  const src = code(WEBSITE);

  it("layaway still converts with toSettle and prices through layaway_quote", () => {
    expect(src).toMatch(/\} else \{\s+totalSettle = toSettle\(total\);\s+shippingSettle = shipping === null \? null : toSettle\(shipping\);\s+subtotalSettle = totalSettle - \(shippingSettle \?\? 0\);\s+\}/);
    expect(src).toMatch(/p_price: subtotalSettle,\s+p_term_months: termMonths,\s+p_currency: settlement,/);
    // The GET re-read of a saved layaway quote, likewise.
    expect(src).toMatch(/\} else \{\s+totalSettle = toSettle\(totalJpy\);\s+shippingSettle = shippingJpy === null \? null : toSettle\(shippingJpy\);\s+subtotalSettle = totalSettle - \(shippingSettle \?\? 0\);\s+\}/);
  });

  it("the layaway pay response is untouched (currency and total from the plan)", () => {
    expect(src).toMatch(/mode: "layaway",\s+account_id: plan\.account_id,\s+web_reference: plan\.web_reference,\s+currency,\s+total: plan\.total,/);
  });
});

describe("the website accepts pesos for a full payment", () => {
  const src = code(WEBSITE);

  it("no longer refuses, and still rejects an unknown currency", () => {
    expect(readFileSync(WEBSITE, "utf8")).not.toMatch(/currency_not_supported_for_full/);
    expect(src).toMatch(/if \(!\["JPY", "PHP"\]\.includes\(settlement\)\) return jsonResponse\(\{ error: "bad_currency" \}, 400\);/);
  });

  it("the reserve-first reply is currency-aware and keeps total_jpy", () => {
    expect(src).toMatch(/const placedCurrency = String\(result\.currency \?\? "JPY"\) === "PHP" \? "PHP" : "JPY";/);
    expect(src).toMatch(/currency: placedCurrency,\s+total: placedTotal,\s+total_jpy: result\.total_jpy,\s+transfer_due_at: null,\s+transfer_region: regionForCurrency\(placedCurrency\),/);
    expect(src).not.toMatch(/regionForCurrency\("JPY"\)/);
  });

  it("the placed reply and its email use the order's own currency and total", () => {
    expect(src).toMatch(/currency: orderCurrency,\s+total: orderTotal,\s+total_jpy: result\.total_jpy,/);
    expect(src).toMatch(/totalJpy: orderTotal,\s+currency: orderCurrency === "PHP" \? "PHP" : "JPY",/);
  });
});

describe("order emails print the order's currency (D1)", () => {
  const TEMPLATES = [
    "order-cancelled", "order-confirmation", "order-expired",
    "order-payment-received", "order-reservation-lapsed", "order-reserved",
  ].map((t) => `supabase/functions/_shared/email-templates/${t}.tsx`);

  it("ItemsTable lists peso lines without a price and prints shipping and total in the order's currency", () => {
    const shared = code("supabase/functions/_shared/email-templates/order-shared.tsx");
    expect(shared).toMatch(/v=\{currency === 'PHP' \? '' : formatJpy\(i\.line_total_jpy\)\}/);
    expect(shared).toMatch(/orderMoney\(shippingJpy, currency\)/);
    expect(shared).toMatch(/v=\{orderMoney\(totalJpy, currency\)\} emphasis/);
    // Yen keeps formatJpy, so a yen email is byte-for-byte what it was.
    expect(code("supabase/functions/_shared/storefront-email.ts"))
      .toMatch(/export function orderMoney\([^)]*\): string \{\s+return currency === 'PHP' \? formatMoney\(n, 'PHP'\) : formatJpy\(n\)/);
  });

  it.each(TEMPLATES)("%s passes its currency to ItemsTable", (f) => {
    const src = code(f);
    const uses = src.match(/<ItemsTable [^>]*\/>/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/currency=\{p\.currency\}/);
  });

  it("the payment-received amount is in the order's currency", () => {
    expect(code("supabase/functions/_shared/email-templates/order-payment-received.tsx")).toMatch(/orderMoney\(p\.amountReceivedJpy, p\.currency\)/);
  });

  it.each([
    ["supabase/functions/_shared/reservation-emails.ts", 4],
    ["supabase/functions/auto-expire-cash-orders/index.ts", 1],
    ["supabase/functions/cancel-cash-order/index.ts", 1],
    ["supabase/functions/review-payment-submission/index.ts", 1],
    [WEBSITE, 1],
  ] as const)("%s passes the order currency on every order email (%i)", (f, n) => {
    const src = code(f);
    const sends = src.match(/createElement\(Order[A-Za-z]+Email, \{[\s\S]*?\}\),/g) ?? [];
    expect(sends).toHaveLength(n);
    for (const s of sends) expect(s).toMatch(/currency: /);
  });

  it("cancel-cash-order selects the currency it passes", () => {
    expect(code("supabase/functions/cancel-cash-order/index.ts")).toMatch(/shipping_fee, total_amount, currency, customers\(email, is_test\)/);
  });
});

describe("Manage Invoice uses the rate the customer was charged", () => {
  it("a web peso order converts at fx_rate_used, half-up — never the staff rate", () => {
    const staffRate = () => { throw new Error("must not read the per-browser rate"); };
    // ¥98,500 at 0.308345 = ₱30,371.9825 → ₱30,372 — here also the stored
    // order's total ₱30,835 less its shipping ₱463 (scratch run).
    expect(hub.itemsSubtotalInOrderCurrency(98500, { currency: "PHP", fx_rate_used: "0.308345" }, staffRate)).toBe(30372);
    expect(hub.itemsSubtotalInOrderCurrency(100000, { currency: "PHP", fx_rate_used: 0.308345 }, staffRate)).toBe(30835);
  });

  it("a Hub-arranged peso order (no stored rate) keeps today's behaviour", () => {
    expect(hub.itemsSubtotalInOrderCurrency(10000, { currency: "PHP", fx_rate_used: null }, () => 0.42)).toBe(Math.round(10000 * 0.42));
    expect(hub.itemsSubtotalInOrderCurrency(10000, { currency: "PHP" }, () => 0.42)).toBe(4200);
  });

  it("CashOrderDetail computes the items subtotal through it", () => {
    const src = code("src/pages/CashOrderDetail.tsx");
    expect(src).toMatch(/const manageItemsSubtotalAcct = itemsSubtotalInOrderCurrency\(\s+manageItemsSubtotalJpy,/);
    expect(src).not.toMatch(/Math\.round\(manageItemsSubtotalJpy \* getConversionRate\(\)\)/);
  });
});
