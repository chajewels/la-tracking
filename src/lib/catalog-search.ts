/**
 * Website → Catalog → Products: search, filters and product-type counts.
 * Pure functions, so the rules are unit-tested (src/test/catalog-search.test.ts)
 * and the card only wires them to the URL.
 *
 * MATCHING (owner request 2026-09-27). Case-insensitive, ignoring spaces and
 * dashes, against:
 *   - the product CODE: the first word of the name, the same rule Page365 uses
 *     (_shared/page365-inventory.ts firstWord; docs/PAGE365-IMPORT.md);
 *   - the SKU (website_products.sku — the only SKU in the schema: variant rows
 *     carry size / stone / price / stock, no code of their own);
 *   - the English name and the Japanese name.
 * Text is NFKC-normalised first, so full-width input (ＡＬ１２３, full-width
 * spaces and hyphens) matches too. An EXACT code or SKU match is listed first;
 * everything else keeps the list's own order (newest first).
 */

export const NO_PRODUCT_TYPE = "none";
export const STOCK_FILTERS = ["in", "out"] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];

export interface CatalogFilters {
  q: string;
  /** website_collections id, NO_PRODUCT_TYPE, or "" for all. */
  type: string;
  /** website_categories id or "" for all. */
  category: string;
  /** website_products.status or "" for all. */
  status: string;
  stock: StockFilter | "";
}

export const EMPTY_FILTERS: CatalogFilters = { q: "", type: "", category: "", status: "", stock: "" };

/** The fields the search reads from a Catalog row. */
export interface SearchableProduct {
  id: string;
  name?: string | null;
  name_ja?: string | null;
  sku?: string | null;
  status?: string | null;
  stock?: number | null;
  website_collection_products?: Array<{ collection_id: string }> | null;
  website_category_products?: Array<{ category_id: string }> | null;
}

// Spaces (incl. U+3000 after NFKC → U+0020, NBSP) and dash-like characters.
// NOT the katakana prolonged sound mark ー (U+30FC): it is part of Japanese words.
const IGNORED = /[\s\-‐‑‒–—―−﹣]/g;

/** Lower-case, NFKC, spaces and dashes removed. */
export function normalizeSearch(text: string | null | undefined): string {
  return String(text ?? "").normalize("NFKC").toLowerCase().replace(IGNORED, "");
}

/** First word of the name, upper-cased — twin of Page365's firstWord. Null when blank. */
export function productCode(name: string | null | undefined): string | null {
  const m = String(name ?? "").match(/^\s*(\S+)/);
  return m ? m[1].toUpperCase() : null;
}

export function typeIds(p: SearchableProduct): string[] {
  return (p.website_collection_products ?? []).map((c) => c.collection_id);
}

export function categoryIds(p: SearchableProduct): string[] {
  return (p.website_category_products ?? []).map((c) => c.category_id);
}

/**
 * 0 = exact code / SKU match, 1 = contains match, null = no match.
 * An empty query matches everything at rank 1 (the list's own order).
 */
export function matchRank(p: SearchableProduct, q: string): 0 | 1 | null {
  const needle = normalizeSearch(q);
  if (!needle) return 1;
  const code = normalizeSearch(productCode(p.name));
  const sku = normalizeSearch(p.sku);
  if (needle === code || needle === sku) return 0;
  const haystacks = [code, sku, normalizeSearch(p.name), normalizeSearch(p.name_ja)];
  return haystacks.some((h) => h && h.includes(needle)) ? 1 : null;
}

function passesType(p: SearchableProduct, type: string): boolean {
  if (!type) return true;
  const ids = typeIds(p);
  return type === NO_PRODUCT_TYPE ? ids.length === 0 : ids.includes(type);
}

function passesOthers(p: SearchableProduct, f: CatalogFilters): boolean {
  if (f.category && !categoryIds(p).includes(f.category)) return false;
  if (f.status && p.status !== f.status) return false;
  if (f.stock === "in" && !(Number(p.stock ?? 0) > 0)) return false;
  if (f.stock === "out" && Number(p.stock ?? 0) > 0) return false;
  return true;
}

/**
 * Rows that match the search and every filter, exact code/SKU matches first,
 * otherwise in the given order. A product in several types passes the type
 * filter for each of them.
 */
export function filterProducts<T extends SearchableProduct>(rows: T[], f: CatalogFilters): T[] {
  const ranked: Array<{ row: T; rank: 0 | 1; i: number }> = [];
  rows.forEach((row, i) => {
    if (!passesType(row, f.type) || !passesOthers(row, f)) return;
    const rank = matchRank(row, f.q);
    if (rank !== null) ranked.push({ row, rank, i });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return ranked.map((r) => r.row);
}

/**
 * Counts for the type tabs and the type filter: they follow the search and
 * the OTHER filters (never the type filter itself, or every other tab would
 * read 0). `all` counts each product once; a product in several types counts
 * under each; `none` counts products with no type.
 */
export function productTypeCounts<T extends SearchableProduct>(
  rows: T[], f: CatalogFilters,
): { all: number; none: number; byType: Map<string, number> } {
  const base = filterProducts(rows, { ...f, type: "" });
  const byType = new Map<string, number>();
  let none = 0;
  for (const p of base) {
    const ids = [...new Set(typeIds(p))];
    if (ids.length === 0) none += 1;
    for (const id of ids) byType.set(id, (byType.get(id) ?? 0) + 1);
  }
  return { all: base.length, none, byType };
}

/** URL ⇄ filters. Unknown stock values read as "all". */
export function filtersFromParams(sp: URLSearchParams): CatalogFilters {
  const stock = sp.get("stock") ?? "";
  return {
    q: sp.get("q") ?? "",
    type: sp.get("type") ?? "",
    category: sp.get("category") ?? "",
    status: sp.get("status") ?? "",
    stock: (STOCK_FILTERS as readonly string[]).includes(stock) ? (stock as StockFilter) : "",
  };
}

/** Writes the filters into a copy of `sp`, dropping empty ones; other params (view, product, tab) are kept. */
export function withFilters(sp: URLSearchParams, f: Partial<CatalogFilters>): URLSearchParams {
  const n = new URLSearchParams(sp);
  for (const [k, v] of Object.entries(f)) {
    if (v) n.set(k, String(v)); else n.delete(k);
  }
  return n;
}

export function hasActiveFilters(f: CatalogFilters): boolean {
  return !!(f.q.trim() || f.type || f.category || f.status || f.stock);
}
