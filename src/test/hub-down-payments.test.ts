import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as edge from "../../supabase/functions/_shared/settlement.ts";
import {
  attachDownPayments, planLayawayQuote, variantPricePhp, type FxRate, type RpcClient,
} from "../../supabase/functions/_shared/website-down-payments.ts";
import * as hub from "@/lib/web-settlement";

/**
 * DOWN PAYMENT + CALCULATOR FIGURES FROM THE HUB (H-DP, 2026-09-25).
 *
 * Owner rules this file holds the code to:
 *   - every customer-facing money figure comes from the Hub;
 *   - the 30% down payment is half-up to a whole unit, in yen and in pesos;
 *   - ONE formula, identical to checkout: price_php = HU(price_jpy × rate),
 *     peso down payment = layaway_quote(price_php, term, 'PHP').deposit, yen
 *     down payment = layaway_quote(price_jpy, term, 'JPY').deposit;
 *   - peso term minimums are the Hub's min_amount_php;
 *   - the legacy /layaway/quote shape keeps working until the storefront ships.
 *
 * WRITER below is DATA, not a re-derivation. It was produced in a scratch
 * postgres:15 holding the real layaway_quote body (md5 85bc273c…) and the real
 * create_web_layaway_atomic body (md5 44aa89cf…): one single-piece, ₱0/¥0
 * shipping layaway quote per row, run through create_web_layaway_atomic, and
 * the account it wrote read back (total_amount, downpayment_amount). In the
 * same run, website_down_payments (20260926100000) was called for all 2,519
 * cases (2,016 peso incl. every conversion tie; 503 yen) and returned the
 * stored deposit every time: 0 mismatches. These rows are a sample.
 *
 * The edge functions run under Deno; the logic lives in a Deno-free module
 * (_shared/website-down-payments.ts) imported here directly. The wiring inside
 * website/index.ts is asserted on code with comment lines stripped, so a
 * comment mentioning a rule cannot satisfy it.
 */

const code = (f: string) =>
  readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const sqlCode = (s: string) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

const WEBSITE = "supabase/functions/website/index.ts";
const MODULE = "supabase/functions/_shared/website-down-payments.ts";
const MIGRATION = "supabase/migrations/20260926100000_website_down_payments.sql";
const LAYAWAY_QUOTE = "supabase/migrations/20260914130109_5b8dc95b-221e-45a6-adab-4c589e0df423.sql";
const A1 = "supabase/migrations/20260923140000_reserve_first_a1.sql";

/** scripts/function-drift-audit's comparator: md5 of the body, whitespace collapsed and trimmed. */
const bodyMd5 = (body: string) => createHash("md5").update(body.replace(/\s+/g, " ").trim()).digest("hex");
function lastBody(file: string, name: string): string {
  const s = readFileSync(file, "utf8");
  const re = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`, "g");
  let start = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) start = m.index;
  expect(start, `${file} defines ${name}`).toBeGreaterThan(-1);
  const tag = /AS (\$[a-z_]*\$)/.exec(s.slice(start));
  expect(tag).not.toBeNull();
  const open = start + tag!.index + tag![0].length;
  return s.slice(open, s.indexOf(tag![1], open));
}

/** Half-up of total × 30%, in integers — layaway_quote's round(v_total * 0.30). */
const hu30 = (total: number) => Math.floor((total * 3 + 5) / 10);

// [price_jpy, rate (null = yen plan), plan currency, stored total_amount, stored downpayment_amount]
const WRITER: Array<[number, number | null, "PHP" | "JPY", number, number]> = [
  [1, 0.5, "PHP", 1, 0], // conversion .5
  [31250, 0.397296, "PHP", 12416, 3725], // conversion .5
  [75000, 0.4337, "PHP", 32528, 9758], // conversion .5
  [93750, 0.397296, "PHP", 37247, 11174], // conversion .5
  [100000, 0.308345, "PHP", 30835, 9251], // .5 on both steps
  [156250, 0.397296, "PHP", 62078, 18623], // conversion .5
  [218750, 0.397296, "PHP", 86909, 26073], // conversion .5
  [281250, 0.397296, "PHP", 111740, 33522], // conversion .5
  [343750, 0.397296, "PHP", 136571, 40971], // conversion .5
  [375000, 0.344228, "PHP", 129086, 38726], // conversion .5
  [4115, 1, "PHP", 4115, 1235], // deposit .5
  [8193, 0.425404, "PHP", 3485, 1046], // deposit .5
  [12345, 0.397296, "PHP", 4905, 1472], // deposit .5
  [25000, 0.42, "PHP", 10500, 3150],
  [26428, 0.397296, "PHP", 10500, 3150],
  [72980, 0.397296, "PHP", 28995, 8699], // deposit .5 (N4020; the old calculator showed ₱8,698)
  [129813, 0.308561, "PHP", 40055, 12017], // deposit .5
  [312868, 0.423156, "PHP", 132392, 39718],
  [332073, 0.422482, "PHP", 140295, 42089], // deposit .5
  [390877, 0.447851, "PHP", 175055, 52517], // deposit .5
  [443308, 0.356173, "PHP", 157894, 47368],
  [476715, 0.366351, "PHP", 174645, 52394], // deposit .5
  [580190, 0.358534, "PHP", 208018, 62405],
  [583963, 0.381008, "PHP", 222495, 66749], // deposit .5
  [649920, 0.301286, "PHP", 195812, 58744],
  [679980, 0.397296, "PHP", 270153, 81046], // R7828
  [780192, 0.415866, "PHP", 324455, 97337], // deposit .5
  [835433, 0.439187, "PHP", 366911, 110073],
  [890479, 0.386589, "PHP", 344249, 103275],
  [935568, 0.34404, "PHP", 321873, 96562],
  [970094, 0.396178, "PHP", 384330, 115299],
  [3, null, "JPY", 3, 1],
  [12345, null, "JPY", 12345, 3704], // yen deposit .5
  [60787, null, "JPY", 60787, 18236],
  [72980, null, "JPY", 72980, 21894],
  [300473, null, "JPY", 300473, 90142],
  [616396, null, "JPY", 616396, 184919],
  [682686, null, "JPY", 682686, 204806],
  [788313, null, "JPY", 788313, 236494],
  [944101, null, "JPY", 944101, 283230],
  [964019, null, "JPY", 964019, 289206],
];
const PESO = WRITER.filter((r) => r[2] === "PHP") as Array<[number, number, "PHP", number, number]>;
const YEN = WRITER.filter((r) => r[2] === "JPY");

const fxOf = (rate: number): FxRate => ({ jpy_php: rate, as_of: "2026-09-25" });

describe("displayed peso down payment = what create_web_layaway_atomic stores (₱0 shipping)", () => {
  it.each(PESO)("¥%i at %f: price_php and the /layaway/quote ₱ price are the stored total", (jpy, rate, _c, total) => {
    // Catalog price_php, the ₱ quote's layaway_quote input, and both twin helpers.
    expect(variantPricePhp(jpy, fxOf(rate))).toBe(total);
    expect(edge.jpyToPhpHalfUp(jpy, rate)).toBe(total);
    expect(hub.jpyToPhpHalfUp(jpy, rate)).toBe(total);
  });

  it.each(PESO)("¥%i at %f: the ₱ quote asks layaway_quote for exactly the writer's input", async (jpy, rate, _c, total) => {
    const plan = await planLayawayQuote({ price_jpy: jpy, term_months: 3, currency: "PHP" }, async () => fxOf(rate));
    expect(plan).toEqual({
      args: { p_price: total, p_term_months: 3, p_currency: "PHP" },
      extra: { price_jpy: jpy, fx_rate: rate, fx_as_of: "2026-09-25" },
    });
  });

  it.each(PESO)("¥%i at %f (%s) → total %i, deposit %i: convert first, then 30%%, both half-up", (_jpy, _rate, _c, total, dp) => {
    expect(hu30(total)).toBe(dp);
  });

  it("covers real .5 edges on both steps, where float Math.round lands ₱1 low", () => {
    const convTies = PESO.filter(([jpy, rate]) => (BigInt(jpy) * BigInt(Math.round(rate * 1e6))) % 1_000_000n === 500_000n);
    const dpTies = PESO.filter(([, , , total]) => (total * 3) % 10 === 5);
    expect(convTies.length).toBeGreaterThanOrEqual(10);
    expect(dpTies.length).toBeGreaterThanOrEqual(10);
    // At least one conversion tie the old float code got wrong: the reason for H1/H3.
    expect(convTies.some(([jpy, rate, , total]) => Math.round(jpy * rate) === total - 1)).toBe(true);
    // The old calculator's order (percentage first, then convert) is ₱1 off on N4020.
    const [jpy, rate, , , dp] = PESO.find((r) => r[0] === 72980)!;
    expect(Math.round(Math.round(jpy * 0.3) * rate)).toBe(dp - 1);
  });
});

describe("yen down payment is unchanged", () => {
  it.each(YEN)("¥%i (%s, %s) → total %i, deposit %i", async (jpy, _r, _c, total, dp) => {
    expect(total).toBe(jpy);
    expect(hu30(jpy)).toBe(dp);
    // Same layaway_quote call the yen path always made.
    const plan = await planLayawayQuote({ price_jpy: jpy, term_months: 6, currency: "JPY" }, async () => {
      throw new Error("a yen quote must not read the rate");
    });
    expect(plan).toEqual({ args: { p_price: jpy, p_term_months: 6, p_currency: "JPY" }, extra: { price_jpy: jpy, fx_rate: null, fx_as_of: null } });
  });
});

describe("peso term minimums are min_amount_php, judged on the Hub-converted price", () => {
  // From the same scratch run: layaway_quote(p, 6, 'PHP') with the CLAUDE.md
  // plan_configurations (6M ₱10,500, 8M ₱126,000).
  // [price_jpy, rate, peso price sent, term layaway_quote chose in PHP, in JPY]
  const EDGE: Array<[number, number, number, number, number]> = [
    [26427, 0.397296, 10499, 3, 6], // yen clears ¥25,000; pesos do not clear ₱10,500
    [26428, 0.397296, 10500, 6, 6],
  ];
  it.each(EDGE)("¥%i at %f → ₱%i", async (jpy, rate, php) => {
    const plan = await planLayawayQuote({ price_jpy: jpy, term_months: 6, currency: "PHP" }, async () => fxOf(rate));
    expect("args" in plan && plan.args).toEqual({ p_price: php, p_term_months: 6, p_currency: "PHP" });
  });
  it("layaway_quote reads min_amount_php for a peso quote (not the yen minimum at a rate)", () => {
    const body = lastBody(LAYAWAY_QUOTE, "layaway_quote");
    expect(body).toMatch(/CASE WHEN v_currency = 'JPY' THEN pc\.min_amount_jpy ELSE pc\.min_amount_php END/);
  });
});

describe("POST /layaway/quote", () => {
  const noFx = vi.fn(async () => null);

  it("keeps the legacy { price, currency } shape exactly as before", async () => {
    const neverFx = vi.fn(async () => fxOf(0.4));
    expect(await planLayawayQuote({ price: 28995.4, term_months: 6, currency: "php" }, neverFx))
      .toEqual({ args: { p_price: 28995, p_term_months: 6, p_currency: "PHP" }, extra: null });
    expect(await planLayawayQuote({ price: 72980, term_months: 8.6, currency: "JPY" }, neverFx))
      .toEqual({ args: { p_price: 72980, p_term_months: 9, p_currency: "JPY" }, extra: null });
    expect(await planLayawayQuote({ price: 72980 }, neverFx))
      .toEqual({ args: { p_price: 72980, p_term_months: 3, p_currency: "JPY" }, extra: null });
    expect(await planLayawayQuote({ price: -1 }, neverFx)).toEqual({ status: 400, error: "invalid_price" });
    expect(await planLayawayQuote({}, neverFx)).toEqual({ status: 400, error: "invalid_price" });
    expect(await planLayawayQuote(null, neverFx)).toEqual({ status: 400, error: "invalid_price" });
    expect(await planLayawayQuote({ price: 100, currency: "USD" }, neverFx)).toEqual({ status: 400, error: "invalid_currency" });
    expect(neverFx).not.toHaveBeenCalled();
  });

  it("answers 503 fx_unavailable for a ₱ quote with no rate — never a guessed figure", async () => {
    expect(await planLayawayQuote({ price_jpy: 72980, term_months: 3, currency: "PHP" }, noFx))
      .toEqual({ status: 503, error: "fx_unavailable" });
  });

  it("refuses a price_jpy that is not a whole non-negative yen amount", async () => {
    for (const price_jpy of [-1, 72980.5, "abc", ""]) {
      expect(await planLayawayQuote({ price_jpy, currency: "PHP" }, async () => fxOf(0.4)))
        .toEqual({ status: 400, error: "invalid_price" });
    }
    expect(await planLayawayQuote({ price_jpy: 100, currency: "USD" }, async () => fxOf(0.4)))
      .toEqual({ status: 400, error: "invalid_currency" });
  });

  it("prefers price_jpy when both shapes are sent", async () => {
    const plan = await planLayawayQuote({ price: 1, price_jpy: 72980, currency: "PHP" }, async () => fxOf(0.397296));
    expect("args" in plan && plan.args.p_price).toBe(28995);
  });
});

describe("catalog down payments: one RPC per request, fields omitted when absent", () => {
  const client = (data: unknown, error: unknown = null) => {
    const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data, error }));
    return { rpc } as RpcClient & { rpc: typeof rpc };
  };
  const products = () => [
    { product_variants: [{ price_jpy: 72980 }, { price_jpy: 679980 }] },
    { product_variants: [{ price_jpy: 72980 }] },
    { product_variants: [] },
    null,
  ];

  it("makes ONE call with the distinct prices and today's rate, and attaches the figures", async () => {
    const c = client([
      { price_jpy: 72980, down_payment_jpy: 21894, down_payment_php: 8699, down_payment_pct: 0.3 },
      { price_jpy: 679980, down_payment_jpy: 203994, down_payment_php: 81046, down_payment_pct: "0.30" },
    ]);
    const ps = products();
    await attachDownPayments(c, ps, fxOf(0.397296));
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith("website_down_payments", { p_prices_jpy: [72980, 679980], p_rate: 0.397296 });
    expect(ps[0]!.product_variants[0]).toEqual({ price_jpy: 72980, down_payment_jpy: 21894, down_payment_php: 8699, down_payment_pct: 0.3 });
    expect(ps[0]!.product_variants[1]).toEqual({ price_jpy: 679980, down_payment_jpy: 203994, down_payment_php: 81046, down_payment_pct: 0.3 });
    expect(ps[1]!.product_variants[0]).toEqual(ps[0]!.product_variants[0]);
  });

  it("omits a figure the Hub did not produce (no rate → no peso key at all)", async () => {
    const c = client([{ price_jpy: 72980, down_payment_jpy: 21894, down_payment_php: null, down_payment_pct: 0.3 }]);
    const ps = [{ product_variants: [{ price_jpy: 72980 }, { price_jpy: 5 }] }];
    await attachDownPayments(c, ps, null);
    expect(c.rpc).toHaveBeenCalledWith("website_down_payments", { p_prices_jpy: [72980, 5], p_rate: null });
    expect(ps[0].product_variants[0]).toEqual({ price_jpy: 72980, down_payment_jpy: 21894, down_payment_pct: 0.3 });
    expect("down_payment_php" in ps[0].product_variants[0]).toBe(false);
    expect(ps[0].product_variants[1]).toEqual({ price_jpy: 5 }); // no row for it → nothing added
  });

  it("never takes the catalog down: an RPC error or throw leaves the variants untouched", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const c of [client(null, { message: "function website_down_payments does not exist" }),
      { rpc: vi.fn(async () => { throw new Error("network"); }) } as RpcClient]) {
      const ps = products();
      await expect(attachDownPayments(c, ps, fxOf(0.4))).resolves.toBeUndefined();
      expect(ps[0]!.product_variants[0]).toEqual({ price_jpy: 72980 });
    }
    spy.mockRestore();
  });

  it("makes no call when there is no price", async () => {
    const c = client([]);
    await attachDownPayments(c, [{ product_variants: [] }, null, { product_variants: [{ price_jpy: null }] }], fxOf(0.4));
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("price_php is the exact half-up, null with no rate", () => {
    expect(variantPricePhp(100000, fxOf(0.308345))).toBe(30835);
    expect(Math.round(100000 * 0.308345)).toBe(30834); // what the old float code published
    expect(variantPricePhp(100000, null)).toBeNull();
    expect(variantPricePhp("x", fxOf(0.4))).toBeNull();
  });
});

describe("website/index.ts wiring (comment lines stripped)", () => {
  const src = code(WEBSITE);

  it("every product-shaping catalog route attaches down payments once; the slug list does not", () => {
    // collections/:slug, categories/:slug, products/:slug, products list.
    expect(src.match(/await attachDownPayments\(supabase, /g)?.length).toBe(4);
    expect(src.match(/shapeProduct\(/g)?.length).toBe(5); // 4 callers + the definition
    // The ?fields= branch returns before any shaping.
    const fieldsBranch = src.slice(src.indexOf("if (fields) {"), src.indexOf("return jsonResponse(scrub(data ?? []));", src.indexOf("if (fields) {")));
    expect(fieldsBranch).not.toMatch(/attachDownPayments|shapeProduct/);
  });

  it("the deposit RPC is called from exactly one place, and never per product", () => {
    expect(src).not.toMatch(/website_down_payments/);
    expect(code(MODULE).match(/rpc\("website_down_payments"/g)?.length).toBe(1);
    expect(code(MODULE)).not.toMatch(/\* 0\.3|0\.30/); // no deposit maths in TypeScript
  });

  it("no float peso conversion is left in the website function", () => {
    expect(src).not.toMatch(/Math\.round\([^)]*\* ?(fx\.jpy_php|fxRate)\)/);
    expect(src).toMatch(/v\.price_php = variantPricePhp\(/);
    expect(src.match(/const toSettle = \(jpy: number\) => \(fxRate === null \? jpy : jpyToPhpHalfUp\(jpy, fxRate\)\);/g)?.length).toBe(2);
  });

  it("/layaway/quote goes through planLayawayQuote", () => {
    expect(src).toMatch(/const plan = await planLayawayQuote\(body, \(\) => latestFx\(supabase\)\);/);
    expect(src).toMatch(/supabase\.rpc\("layaway_quote", plan\.args\)/);
  });
});

describe("the migration: guarded, read-only, service_role only", () => {
  const sql = sqlCode(readFileSync(MIGRATION, "utf8"));

  it("guards on the live bodies it was tested against, and those ARE the repo bodies", () => {
    expect(bodyMd5(lastBody(LAYAWAY_QUOTE, "layaway_quote"))).toBe("85bc273c37ce6dfe47ceeeda16891947");
    expect(bodyMd5(lastBody(A1, "create_web_layaway_atomic"))).toBe("44aa89cfbcbd6a155b0db63a1d879f5c");
    expect(sql).toMatch(/v_md5 <> '85bc273c37ce6dfe47ceeeda16891947'/);
    expect(sql).toMatch(/v_md5 <> '44aa89cfbcbd6a155b0db63a1d879f5c'/);
  });

  it("post-checks the md5 of the body it contains", () => {
    const md5 = bodyMd5(lastBody(MIGRATION, "website_down_payments"));
    expect(md5).toBe("4403ea1cd803fb9bb9fd3c94ee6e095f");
    expect(sql.match(new RegExp(`v_md5 <> '${md5}'`, "g"))?.length).toBe(2); // pre-existing body + post-check
  });

  it("produces deposits only through layaway_quote, converting first", () => {
    const body = lastBody(MIGRATION, "website_down_payments");
    expect(body.match(/public\.layaway_quote\(/g)?.length).toBe(2);
    expect(body).toMatch(/public\.layaway_quote\(p\.jpy, t\.months, 'JPY'\)/);
    expect(body).toMatch(/public\.layaway_quote\(round\(p\.jpy \* round\(p_rate, 6\)\)::integer, t\.months, 'PHP'\)/);
    expect(body).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  });

  it("is one transaction, alters nothing existing, and grants EXECUTE to service_role only", () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    expect(sql).not.toMatch(/ALTER TABLE|DROP |CREATE TABLE|CREATE TRIGGER/);
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)?.length).toBe(1);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.website_down_payments\(integer\[\], numeric\) FROM PUBLIC;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.website_down_payments\(integer\[\], numeric\) FROM anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.website_down_payments\(integer\[\], numeric\) TO service_role;/);
  });
});
