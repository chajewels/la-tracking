/**
 * Page365 "Create drafts" and Catalog bulk publish — review-screen logic.
 *
 * The rules are in SQL (migration 20260929100000_page365_inventory_drafts.sql):
 * page365_inventory_create_drafts decides what is created, skipped or failed,
 * and website_publish_products decides what may go live. This file only
 * filters the "New in Page365" list, counts it, and words the outcomes.
 *
 *   In stock only   ON by default — a sold piece (Page365 available 0) is
 *                   hidden and so never ticked unless staff switch it off.
 *   Select all shown ticks exactly the rows the filters show, nothing hidden.
 *
 * PR 3c: the list comes from the latest FULL fetch (quick fetches open only
 * Hub products' pages), so its quantities are "as of" that fetch. A row whose
 * listing is missing from the latest fetch's list (any kind) is shown but not
 * tickable, and Create drafts re-reads every ticked listing fresh first.
 */
import type { InventoryItem } from '@/lib/page365-inventory';

export interface NewFilters {
  inStockOnly: boolean;
  search: string;
  /** Page365 category name; '' = all, NO_CATEGORY = listings without one. */
  category: string;
  priceMin: number | null;
  priceMax: number | null;
}

export const NO_CATEGORY = '__none__';

export const defaultNewFilters = (): NewFilters => ({
  inStockOnly: true, search: '', category: '', priceMin: null, priceMax: null,
});

/** A "New in Page365" row plus the Page365 category its listing carries.
 *  not_listed (PR 3c): missing from the latest fetch's catalogue list. */
export type NewRow = InventoryItem & {
  inventory_product_id?: string | null; page365_category: string | null; not_listed?: boolean;
};

/** Rows staff can still act on: not yet drafted, still under review, still on
 *  Page365 (PR 3c: not gone at the fresh read, and on the latest list). */
export const draftable = (it: InventoryItem & { not_listed?: boolean }) =>
  it.category === 'new' && it.status === 'review' && it.result_note !== 'draft_created'
  && it.result_note !== 'gone_from_page365' && !it.not_listed;

/** PR 3c: flag rows whose listing is not on the latest catalogue list.
 *  listed = null when the latest list IS the full fetch (nothing to compare). */
export function markNotListed<T extends InventoryItem>(rows: T[], listed: Set<number> | null): (T & { not_listed: boolean })[] {
  return rows.map(r => ({
    ...r,
    not_listed: listed !== null && r.page365_product_id !== null && !listed.has(Number(r.page365_product_id)),
  }));
}

export const isDrafted = (it: InventoryItem) => it.result_note === 'draft_created';

export function filterNewRows(rows: NewRow[], f: NewFilters): NewRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter(r => {
    if (f.inStockOnly && !((r.page365_available ?? 0) > 0)) return false;
    if (q) {
      const hay = `${r.code ?? ''} ${r.page365_name ?? ''} ${r.variant_name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.category === NO_CATEGORY ? r.page365_category !== null : f.category && r.page365_category !== f.category) {
      return false;
    }
    const price = r.page365_price_jpy;
    if (f.priceMin !== null && (price === null || price < f.priceMin)) return false;
    if (f.priceMax !== null && (price === null || price > f.priceMax)) return false;
    return true;
  });
}

export interface NewCounts { total: number; inStock: number; soldOut: number; drafted: number }

export function countNewRows(rows: InventoryItem[]): NewCounts {
  let inStock = 0;
  let drafted = 0;
  for (const r of rows) {
    if ((r.page365_available ?? 0) > 0) inStock++;
    if (isDrafted(r)) drafted++;
  }
  return { total: rows.length, inStock, soldOut: rows.length - inStock, drafted };
}

/** The Page365 categories present, most common first, for the filter. */
export function categoryOptions(rows: NewRow[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) if (r.page365_category) m.set(r.page365_category, (m.get(r.page365_category) ?? 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** "Select all shown": the draftable rows among those shown — never a hidden one. */
export const selectAllShown = (shown: NewRow[]) => new Set(shown.filter(draftable).map(r => r.id));

/** Keep only ticks that are still shown and draftable (a filter change never
 *  leaves a hidden row ticked). */
export const pruneTicks = (ticks: Set<string>, shown: NewRow[]) => {
  const ok = new Set(shown.filter(draftable).map(r => r.id));
  return new Set([...ticks].filter(id => ok.has(id)));
};

/** Parse a yen bound typed by staff: whole, non-negative, or null. */
export function parseYen(v: string): number | null {
  const t = v.replace(/[¥,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export interface DraftOutcomeItem {
  item_id: string;
  code?: string | null;
  product_id?: string | null;
  reason?: string;
  name?: string;
  needs?: string[];
  photos?: number;
}

export interface CreateDraftsResult {
  ok: boolean;
  reason?: string;
  created?: number;
  skipped?: number;
  failed?: number;
  created_items?: DraftOutcomeItem[];
  skipped_items?: DraftOutcomeItem[];
  failed_items?: DraftOutcomeItem[];
}

export const CREATE_REFUSAL: Record<string, string> = {
  forbidden: 'You need the Website catalog permission to create products.',
  nothing_selected: 'Tick at least one row.',
  too_many: 'At most 700 rows at a time.',
  run_not_found: 'This fetch no longer exists. Fetch again.',
  run_not_ready: 'This fetch did not read Page365 completely. Fetch again.',
  run_stale: 'The last full fetch is more than 48 hours old. Press “Full fetch”.',
  superseded: 'A newer full fetch exists. Review that one instead.',
  // PR 3c: New in Page365 always comes from a full fetch.
  not_full_fetch: 'New products come from a full fetch. Press “Full fetch”.',
};

export const DRAFT_REASON: Record<string, string> = {
  code_exists: 'code already in the Hub',
  already_created: 'draft already created',
  not_new: 'no longer new',
  not_in_run: 'not part of this fetch',
  no_price: 'no price on Page365',
  no_metal: 'jewelry with no metal stamp (K18, PT900 …) in the Page365 name or description',
  code_is_a_word: 'the Page365 name does not start with a product code',
  sync_disabled: 'switched to “Don’t sync with Page365” — never created',
  // PR 3c: every draft is made from a fresh read of its Page365 listing.
  not_fresh: 'could not be read fresh from Page365 just now — try again',
  gone_from_page365: 'no longer on Page365',
};

export const NEEDS_LABEL: Record<string, string> = {
  origin: 'needs origin',
  category: 'needs category',
  brand: 'needs brand name',
  metal: 'needs metal stamp',
  price: 'needs price',
};

export const reasonText = (r: string | undefined) => (r ? DRAFT_REASON[r] ?? r : '');

export interface PublishResult {
  ok: boolean;
  reason?: string;
  published?: number;
  blocked?: number;
  skipped?: number;
  published_items?: { id: string; sku: string }[];
  blocked_items?: { id: string; sku: string; name: string; missing: string[] }[];
  skipped_items?: { id: string; sku?: string; reason: string }[];
}

export const PUBLISH_REFUSAL: Record<string, string> = {
  forbidden: 'You need the Website catalog permission to publish.',
  nothing_selected: 'Select at least one draft.',
  too_many: 'At most 1,000 products at a time.',
};

/**
 * Display twin of SQL website_product_publish_missing — shows staff what a
 * draft still needs BEFORE they press Publish. The server decides.
 */
export function publishMissing(p: {
  origin?: string | null; brand?: string | null; metals?: unknown; item_kind?: string | null;
  website_category_products?: unknown[] | null;
  website_product_variants?: { price_jpy?: number | null }[] | null;
}): string[] {
  const out: string[] = [];
  if (!p.origin || p.origin === 'UNKNOWN') out.push('origin');
  if (p.origin === 'BRAND' && !(p.brand ?? '').trim()) out.push('brand');
  if (!(p.website_category_products ?? []).length) out.push('category');
  // A metal stamp is required only for jewelry (owner decision 2026-09-28).
  if ((p.item_kind ?? 'jewelry') === 'jewelry' && (!Array.isArray(p.metals) || p.metals.length === 0)) out.push('metal');
  const vs = p.website_product_variants ?? [];
  if (!vs.length || vs.some(v => !(Number(v.price_jpy ?? 0) > 0))) out.push('price');
  return out;
}

export const missingText = (m: string[]) => m.map(k => NEEDS_LABEL[k] ?? k).join(', ');
