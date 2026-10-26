import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  cleanYen, cogsRefusal, costCoverageLabel, costSourceLabel, coverageFromLedger, importSummary, normaliseRealProfit, normaliseSalesCosts,
  normaliseValuation, parseCostCsv, saleCostProblem, saleDescription, sortForWork, stockAdjustment, type SaleCostRow,
} from "@/components/finance/cogs";
import { SOURCE_TYPE_LABEL } from "@/components/finance/ledger";

/**
 * Real cost of goods (Expenses Phase 5, owner 2026-10-26 D1–D6): the Cost of goods section's rules, the CSV
 * import, the stock-count adjustment, the ledger-based coverage that replaces the 15 % / 0.85 guesses, and the
 * wiring (migration events, dashboard, products nudge).
 */

const row = (over: Partial<SaleCostRow>): SaleCostRow => ({
  sale_type: "layaway", id: "a", invoice_number: "19001", sale_date: "2026-06-03", status: "active", currency: "JPY",
  revenue: 90000, revenue_jpy: 90000, cost_jpy: null, cost_source: null, note: null, items: [], customer_id: null, is_trade: false, ...over,
});

describe("cost of goods — rules", () => {
  it("normalises the RPC shapes", () => {
    const s = normaliseSalesCosts({ month: "2026-06-01", ledger_start: null, can_set: true, missing_count: "1", older_missing_count: 0, revenue_jpy: "90000", cost_jpy: "0",
      sales: [{ sale_type: "cash_order", id: "c", invoice_number: "CO-1", sale_date: "2026-06-10", status: "completed", currency: "JPY", revenue: "25000", revenue_jpy: "25000", cost_jpy: null, cost_source: null, items: [{ title: "Gold chain" }] }] });
    expect(s.sales[0]).toMatchObject({ sale_type: "cash_order", revenue: 25000, cost_jpy: null, cost_source: null });
    expect(s.missing_count).toBe(1);
    const v = normaliseValuation({ stock_units: "5", stock_at_cost_jpy: "36000", ledger_inventory_jpy: "260000", difference_jpy: "-224000" });
    expect(v).toMatchObject({ stock_units: 5, stock_at_cost_jpy: 36000, difference_jpy: -224000, trade_ins_in_stock: 0 });
    expect(normaliseRealProfit({ error: "permission_denied" })).toBeNull();
    expect(normaliseRealProfit({ ledger_started: false })).toEqual({ ledger_started: false });
    expect(normaliseRealProfit({ ledger_started: true, revenue_jpy: "100", cogs_jpy: "40", gross_profit_jpy: "60", sales_total: 4, sales_with_cost: 3, inventory_jpy: "300000" })).toMatchObject({ gross_profit_jpy: 60, sales_with_cost: 3 });
  });
  it("labels, sorts and describes sales — missing first, never a percentage", () => {
    expect(costSourceLabel("manual")).toBe("Set by finance");
    expect(costSourceLabel("items")).toBe("From the product's cost basis");
    expect(costSourceLabel(null)).toBe("Cost missing");
    const sorted = sortForWork([row({ invoice_number: "B", cost_jpy: 1000, cost_source: "manual" }), row({ invoice_number: "C", sale_date: "2026-06-09" }), row({ invoice_number: "A", sale_date: "2026-06-01" })]);
    expect(sorted.map((r) => r.invoice_number)).toEqual(["A", "C", "B"]);
    expect(saleDescription(row({ items: [{ title: "Ring", quantity: 2 }, { title: "Chain", quantity: 1 }] }))).toBe("2 × Ring, Chain");
    expect(saleDescription(row({ sale_type: "cash_order" }))).toBe("Cash order");
    expect(costCoverageLabel(12, 40)).toBe("real cost on 12 of 40 sales");
    expect(costCoverageLabel(0, 0)).toBe("no sales in this range");
    expect(costCoverageLabel(1, 1)).toBe("real cost on 1 of 1 sale");
  });
  it("validates yen input and parses the CSV", () => {
    expect(saleCostProblem("")).toBe("Enter the cost in yen.");
    expect(saleCostProblem("45,000")).toBeNull();
    expect(saleCostProblem("¥ 45000")).toBeNull();
    expect(saleCostProblem("450.5")).toBe("Whole yen only.");
    expect(cleanYen("¥45,000")).toBe("45000");
    const p = parseCostCsv('invoice_number,cost_jpy,note\n19794, 45000, "supplier 77"\n19840\t32000\n\nbad\n19850;1000;two words here');
    expect(p.rows).toEqual([
      { invoice_number: "19794", cost_jpy: "45000", note: "supplier 77" },
      { invoice_number: "19840", cost_jpy: "32000" },
      { invoice_number: "19850", cost_jpy: "1000", note: "two words here" },
    ]);
    expect(p.skipped).toBe(1);
    expect(importSummary({ set: 2, replaced: 1, not_found: ["x"], ambiguous: [], invalid: [] })).toBe("2 set · 1 replaced · 1 not found");
  });
  it("builds the stock-count adjustment the owner confirms", () => {
    const down = stockAdjustment({ difference_jpy: -224000 }, "2026-10-26", "count 26 Oct");
    expect(down.direction).toBe("down");
    expect(down.payload.lines).toEqual([
      { a: "5900", side: "dr", amt: "224000", cur: "JPY", memo: "Stock count" }, { a: "1300", side: "cr", amt: "224000", cur: "JPY", memo: "Stock count" },
    ]);
    expect(down.payload.description).toBe("Stock-count adjustment: count 26 Oct");
    const up = stockAdjustment({ difference_jpy: 5000 }, "2026-10-26", "");
    expect(up.direction).toBe("up");
    expect(up.payload.lines[0]).toMatchObject({ a: "1300", side: "dr" });
    expect(up.payload.reason).toBe("Stock count");
  });
  it("derives cash-flow coverage from the ledger's inventory (no 0.85)", () => {
    expect(coverageFromLedger(1000, null, 500)).toBeNull();
    expect(coverageFromLedger(1000, 0, 500)).toBeNull();
    const c = coverageFromLedger(3_000_000, 2_000_000, 1_000_000)!;
    expect(c).toMatchObject({ inventory_cost: 2_000_000, coverage_ratio: 1.5, status_label: "HEALTHY", funding_gap: 1_000_000, days_covered: 45, projected_coverage_30d: 0.5, projected_funding_gap: 1_000_000 });
    expect(coverageFromLedger(1_000_000, 1_000_000, 0)!.status_label).toBe("WATCH");
    expect(coverageFromLedger(500_000, 1_000_000, 0)!.status_label).toBe("CRITICAL");
    expect(cogsRefusal("invalid_amount")).toBe("Enter the cost in whole yen.");
  });
});

describe("cost of goods — wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("ledger labels, tab, dashboard, products nudge", () => {
    expect(SOURCE_TYPE_LABEL.cogs_sale).toBe("Cost of pieces sold");
    expect(SOURCE_TYPE_LABEL.trade_in_resold).toBe("Trade-in resold");
    const tab = read("src/components/finance/LedgerTab.tsx");
    expect(tab).toContain('<TabsTrigger value="cogs">Cost of goods</TabsTrigger>');
    expect(tab).toContain("<CostOfGoodsSection");
    expect(tab).toContain('callRpc("fc_real_profit"');
    const section = read("src/components/finance/CostOfGoodsSection.tsx");
    expect(section).toContain('callRpc("set_sale_cost"');
    expect(section).toContain('callRpc("import_sale_costs"');
    expect(section).toContain('callRpc("get_inventory_valuation"');
    expect(section).not.toMatch(/0\.15|15 ?%/);
    const dash = read("src/pages/ExecutiveDashboard.tsx");
    expect(dash).not.toContain("15% on");
    expect(dash).not.toContain("Risk-Adj. Profit");
    expect(dash).toContain('label="Gross Profit (ledger)"');
    expect(dash).toContain('label="Inventory at Cost"');
    expect(read("src/hooks/useExecutiveDashboard.ts")).toContain("'fc_real_profit'");
    expect(read("src/components/website/ProductsCard.tsx")).toContain('data-testid="catalog-no-cost"');
  });
  it("migration: events, remap, snapshot trigger, accountant accounts, no comment lines in bodies", () => {
    const sql = read("supabase/migrations/20270104100000_expenses_cost_of_goods.sql");
    for (const k of ["'cogs_sale'", "'cogs_return'", "'trade_in_received'", "'trade_in_resold'"]) expect(sql).toContain(k);
    expect(sql).toContain("ALTER FUNCTION public.gl_current_events(date) RENAME TO gl_base_events");
    expect(sql).toContain("SELECT * FROM public.gl_base_events(p_until)\n  UNION ALL\n  SELECT * FROM public.gl_cogs_events(p_until)");
    expect(sql).toContain("SET gl_account_code = '1300'");
    expect(sql).toContain("SET gl_account_code = '1310'");
    expect(sql).toContain("sale_items_snapshot_cost");
    expect(sql).toContain("('2700', 'Short-term loans'");
    expect(sql).toContain("('1104', 'Kameari Shinkin Bank'");
    expect(sql).not.toMatch(/0\.15|0\.85/);
    for (const b of (sql.match(/\$fn\$[\s\S]*?\$fn\$/g) ?? [])) expect(b).not.toMatch(/^\s*--/m);
    expect(read("supabase/migrations/20270101100000_general_ledger_core.sql")).toContain("('fiscal_year_start_month', '\"4\"'::jsonb)");
  });
});
