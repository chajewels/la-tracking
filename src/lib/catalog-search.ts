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

/*
 * PUBLISHED / UNPUBLISHED (owner request 2026-09-28).
 *
 * "Published" = website_products.status === "active" — the same definition as
 * the background-removal publish gate (migration 20261011100000,
 * media_cutout_url_published) and the one the website API serves products by
 * (supabase/functions/website/index.ts, .eq("status", "active")). Everything
 * else (draft, archived) is Unpublished. The tab is ?view=published|unpublished
 * (absent = published); ?view=page365-drafts is a narrower Unpublished view.
 */
export const CATALOG_VIEWS = ["published", "unpublished", "page365-drafts"] as const;
export type CatalogView = (typeof CATALOG_VIEWS)[number];
export type CatalogTab = "published" | "unpublished";

export interface ScopedProduct extends SearchableProduct {
  page365_product_id?: string | number | null;
}

export const isPublished = (p: Pick<SearchableProduct, "status">): boolean => p.status === "active";

/** Unknown or missing ?view= reads as the default tab, Published. */
export function viewFromParams(sp: URLSearchParams): CatalogView {
  const v = sp.get("view") ?? "";
  return (CATALOG_VIEWS as readonly string[]).includes(v) ? (v as CatalogView) : "published";
}

/** The top-level tab a view belongs to: the Page365 drafts view is part of Unpublished. */
export const tabOf = (view: CatalogView): CatalogTab => (view === "published" ? "published" : "unpublished");

/** The tab a product lives in. */
export const tabOfProduct = (p: Pick<SearchableProduct, "status">): CatalogTab => (isPublished(p) ? "published" : "unpublished");

/** Rows of one view, in the given order. */
export function scopeToView<T extends ScopedProduct>(rows: T[], view: CatalogView): T[] {
  if (view === "published") return rows.filter(isPublished);
  if (view === "unpublished") return rows.filter((p) => !isPublished(p));
  return rows.filter((p) => p.page365_product_id != null && p.status === "draft");
}

/**
 * Counts on the two tabs: they follow the search and the type / category /
 * stock filters, never the status filter (a status belongs to one tab only).
 */
export function tabCounts<T extends SearchableProduct>(rows: T[], f: CatalogFilters): { published: number; unpublished: number } {
  const hit = filterProducts(rows, { ...f, status: "" });
  const published = hit.filter(isPublished).length;
  return { published, unpublished: hit.length - published };
}

/**
 * Switch tab: writes ?view= (dropping the status filter, which belongs to one
 * tab); search, type, category, stock and every other param are kept.
 */
export function withView(sp: URLSearchParams, view: CatalogView): URLSearchParams {
  const n = new URLSearchParams(sp);
  n.set("view", view);
  n.delete("status");
  return n;
}

/** The statuses a tab can hold, for its Status filter. Published holds one, so it gets none. */
export function statusesForTab(tab: CatalogTab, seen: Iterable<string>): string[] {
  if (tab === "published") return [];
  const out = new Set<string>(["draft", "archived"]);
  for (const s of seen) if (s && s !== "active") out.add(s);
  return [...out];
}

export interface TypeGroup<T> {
  /** website_collections id, or NO_PRODUCT_TYPE. */
  id: string;
  name: string;
  rows: T[];
}

/**
 * Products grouped under their product types, in the given type order
 * (website_collections as the Hub loads them), then "No product type". A
 * product in several types appears under each; order within a group is the
 * list's own (exact code/SKU matches first when searching). Every type is
 * returned, empty ones too — the card decides how to show an empty group.
 */
export function groupByType<T extends SearchableProduct>(rows: T[], types: Array<{ id: string; name: string }>): TypeGroup<T>[] {
  const known = new Set(types.map((t) => t.id));
  const groups: TypeGroup<T>[] = types.map((t) => ({ id: t.id, name: t.name, rows: [] as T[] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const none: TypeGroup<T> = { id: NO_PRODUCT_TYPE, name: "No product type", rows: [] };
  for (const p of rows) {
    // A link to a type the Hub no longer has counts as no type.
    const ids = [...new Set(typeIds(p))].filter((id) => known.has(id));
    if (ids.length === 0) none.rows.push(p);
    for (const id of ids) byId.get(id)!.rows.push(p);
  }
  return [...groups, none];
}
