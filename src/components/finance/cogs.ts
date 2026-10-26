/**
 * Cost of goods (Expenses Phase 5, owner 2026-10-26 D1–D6). Pure rules, no React.
 * Finance → Ledger → "Cost of goods": sales booked in a month with their real cost (finance-set, else the
 * item-line snapshot, else MISSING — never a percentage), CSV import by invoice number, stock at cost vs the
 * ledger's inventory balance, and the real gross-profit figures that replace the Executive Dashboard's 15 %.
 */

export const COGS_KEY = ["finance", "ledger", "cogs"] as const;
export const INVENTORY_KEY = ["finance", "ledger", "inventory"] as const;

export type CostSource = "manual" | "items" | "trade_in" | null;
export type SaleItem = { title: string | null; sku?: string | null; quantity?: number | null; unit_price_jpy?: number | null; cost_jpy?: number | null };
export type SaleCostRow = {
  sale_type: "layaway" | "cash_order"; id: string; invoice_number: string; sale_date: string; status: string;
  currency: "JPY" | "PHP"; revenue: number; revenue_jpy: number; cost_jpy: number | null; cost_source: CostSource;
  note: string | null; items: SaleItem[]; customer_id: string | null; is_trade: boolean;
};
export type SalesCosts = {
  month: string; ledger_start: string | null; can_set: boolean; sales: SaleCostRow[];
  missing_count: number; older_missing_count: number; revenue_jpy: number; cost_jpy: number;
};
export type InventoryValuation = {
  ledger_start: string | null; stock_units: number; stock_units_with_cost: number; variants_in_stock_without_cost: number;
  stock_at_cost_jpy: number; trade_ins_in_stock: number; trade_ins_in_stock_jpy: number;
  ledger_inventory_jpy: number; ledger_trade_in_jpy: number; website_minus_ledger_jpy: number;
};
export type RealProfit =
  | { ledger_started: false }
  | { ledger_started: true; from: string; to: string; revenue_jpy: number; cogs_jpy: number; gross_profit_jpy: number; sales_total: number; sales_with_cost: number; inventory_jpy: number };

const num = (v: unknown, d = 0) => (v == null || v === "" ? d : Number(v));
const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number(v));

export function normaliseSalesCosts(raw: Record<string, unknown>): SalesCosts {
  const sales = Array.isArray(raw.sales) ? (raw.sales as Record<string, unknown>[]) : [];
  return {
    month: String(raw.month ?? ""),
    ledger_start: (raw.ledger_start as string | null) ?? null,
    can_set: raw.can_set === true,
    sales: sales.map((s) => ({
      sale_type: s.sale_type === "cash_order" ? "cash_order" : "layaway",
      id: String(s.id), invoice_number: String(s.invoice_number ?? ""), sale_date: String(s.sale_date ?? ""), status: String(s.status ?? ""),
      currency: s.currency === "PHP" ? "PHP" : "JPY", revenue: num(s.revenue), revenue_jpy: num(s.revenue_jpy),
      cost_jpy: numOrNull(s.cost_jpy), cost_source: (s.cost_source === "manual" || s.cost_source === "items" || s.cost_source === "trade_in" ? s.cost_source : null),
      note: (s.note as string | null) ?? null, items: Array.isArray(s.items) ? (s.items as SaleItem[]) : [],
      customer_id: (s.customer_id as string | null) ?? null, is_trade: s.is_trade === true,
    })),
    missing_count: num(raw.missing_count), older_missing_count: num(raw.older_missing_count),
    revenue_jpy: num(raw.revenue_jpy), cost_jpy: num(raw.cost_jpy),
  };
}

export function normaliseValuation(raw: Record<string, unknown>): InventoryValuation {
  return {
    ledger_start: (raw.ledger_start as string | null) ?? null,
    stock_units: num(raw.stock_units), stock_units_with_cost: num(raw.stock_units_with_cost), variants_in_stock_without_cost: num(raw.variants_in_stock_without_cost),
    stock_at_cost_jpy: num(raw.stock_at_cost_jpy), trade_ins_in_stock: num(raw.trade_ins_in_stock), trade_ins_in_stock_jpy: num(raw.trade_ins_in_stock_jpy),
    ledger_inventory_jpy: num(raw.ledger_inventory_jpy), ledger_trade_in_jpy: num(raw.ledger_trade_in_jpy), website_minus_ledger_jpy: num(raw.website_minus_ledger_jpy),
  };
}

export function normaliseRealProfit(raw: unknown): RealProfit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.error) return null;
  if (r.ledger_started !== true) return { ledger_started: false };
  return {
    ledger_started: true, from: String(r.from ?? ""), to: String(r.to ?? ""),
    revenue_jpy: num(r.revenue_jpy), cogs_jpy: num(r.cogs_jpy), gross_profit_jpy: num(r.gross_profit_jpy),
    sales_total: num(r.sales_total), sales_with_cost: num(r.sales_with_cost), inventory_jpy: num(r.inventory_jpy),
  };
}

export const COST_SOURCE_LABEL: Record<Exclude<CostSource, null> | "missing", string> = {
  manual: "Set by finance", items: "From the product's cost basis", trade_in: "Resold trade-in (cost booked as trade-in)", missing: "Cost missing",
};
export function costSourceLabel(s: CostSource): string { return COST_SOURCE_LABEL[s ?? "missing"]; }

/** Sales still missing a cost first, then by date — what finance works through. */
export function sortForWork(rows: SaleCostRow[]): SaleCostRow[] {
  return [...rows].sort((a, b) => Number(a.cost_jpy != null) - Number(b.cost_jpy != null) || a.sale_date.localeCompare(b.sale_date) || a.invoice_number.localeCompare(b.invoice_number));
}

export function saleDescription(r: SaleCostRow): string {
  const titles = r.items.map((i) => (i.quantity && i.quantity > 1 ? `${i.quantity} × ` : "") + (i.title ?? "")).filter(Boolean);
  if (titles.length) return titles.join(", ");
  return r.sale_type === "layaway" ? "Layaway plan" : "Cash order";
}

/** "real cost on 12 of 40 sales" for the strips and tiles. */
export function costCoverageLabel(withCost: number, total: number): string {
  if (total === 0) return "no sales in this range";
  return `real cost on ${withCost} of ${total} sale${total === 1 ? "" : "s"}`;
}

export function saleCostProblem(v: string): string | null {
  const t = v.trim().replace(/[¥,\s]/g, "");
  if (t === "") return "Enter the cost in yen.";
  if (!/^\d+$/.test(t)) return "Whole yen only.";
  if (Number(t) > 1_000_000_000) return "That cost is too large.";
  return null;
}
export function cleanYen(v: string): string { return v.trim().replace(/[¥,\s]/g, ""); }

/** CSV rows "invoice_number,cost_jpy[,note]" (header optional, quotes tolerated). */
export function parseCostCsv(text: string): { rows: { invoice_number: string; cost_jpy: string; note?: string }[]; skipped: number } {
  const rows: { invoice_number: string; cost_jpy: string; note?: string }[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (/^invoice/i.test(cells[0] ?? "")) continue;
    if (cells.length < 2 || !cells[0] || !cells[1]) { skipped += 1; continue; }
    rows.push({ invoice_number: cells[0], cost_jpy: cells[1], ...(cells[2] ? { note: cells.slice(2).join(" ") } : {}) });
  }
  return { rows, skipped };
}

export function importSummary(r: { set?: number; replaced?: number; not_found?: string[]; ambiguous?: string[]; invalid?: string[] }): string {
  const parts = [`${r.set ?? 0} set`, `${r.replaced ?? 0} replaced`];
  if (r.not_found?.length) parts.push(`${r.not_found.length} not found`);
  if (r.ambiguous?.length) parts.push(`${r.ambiguous.length} ambiguous`);
  if (r.invalid?.length) parts.push(`${r.invalid.length} invalid`);
  return parts.join(" · ");
}

/**
 * The stock-count adjustment from a COUNTED stock value the owner types (yen at cost) against the ledger's 1300:
 * never derived from the website-only figure, which misses supplier / preloved stock without a product line.
 */
export function stockAdjustment(countedJpy: number, ledgerJpy: number, today: string, reason: string) {
  const diff = Math.round(countedJpy) - Math.round(ledgerJpy);
  const amount = Math.abs(diff);
  const up = diff > 0;
  return {
    amount,
    direction: up ? ("up" as const) : ("down" as const),
    label: up ? "Inventory up (count above the books)" : "Inventory write-down (count below the books)",
    payload: {
      kind: "manual", entry_date: today, description: `Stock-count adjustment${reason ? `: ${reason}` : ""}`, reason: reason || "Stock count",
      lines: up
        ? [{ a: "1300", side: "dr", amt: String(amount), cur: "JPY", memo: "Stock count" }, { a: "5900", side: "cr", amt: String(amount), cur: "JPY", memo: "Stock count" }]
        : [{ a: "5900", side: "dr", amt: String(amount), cur: "JPY", memo: "Stock count" }, { a: "1300", side: "cr", amt: String(amount), cur: "JPY", memo: "Stock count" }],
    },
  };
}

/** Cash-flow coverage from the ledger's inventory (the old function used portfolio × 0.85). */
export function coverageFromLedger(cashIn: number, inventoryJpy: number | null, projectedInflow30d: number) {
  if (inventoryJpy == null || inventoryJpy <= 0) return null;
  const ratio = cashIn / inventoryJpy;
  const projected = projectedInflow30d / inventoryJpy;
  return {
    inventory_cost: inventoryJpy,
    coverage_ratio: Math.round(ratio * 10000) / 10000,
    status_label: ratio > 1.2 ? "HEALTHY" : ratio >= 1 ? "WATCH" : "CRITICAL",
    funding_gap: Math.round(cashIn - inventoryJpy),
    days_covered: Math.round((cashIn / (inventoryJpy / 30)) * 10) / 10,
    projected_coverage_30d: Math.round(projected * 10000) / 10000,
    projected_funding_gap: Math.round(inventoryJpy - projectedInflow30d),
  };
}

export function cogsRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "You don't have permission for this.";
    case "invalid_sale": return "That sale could not be identified.";
    case "not_found": return "That sale is not in the Hub.";
    case "invalid_amount": return "Enter the cost in whole yen.";
    case "invalid_note": return "The note is too long.";
    case "invalid_rows": return "The file has no usable rows (max 2,000).";
    case "ledger_start_not_set": return "Set the ledger start in Finance → Ledger first.";
    case "period_closed": return "That month is closed.";
    default: return "";
  }
}
