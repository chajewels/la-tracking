/**
 * Page365 inventory fetch — review-screen logic (Website -> Page365 stock).
 *
 * The rules are in SQL (migrations 20260927100000_page365_inventory_fetch.sql
 * and 20260928100000_page365_inventory_pr2.sql): page365_inventory_finish
 * decides each row's category and proposal, and page365_inventory_apply writes
 * stock with compare-and-set. This file only groups what the run recorded,
 * decides what is PRE-TICKED, and splits the ticks into the two lists apply
 * takes. It decides nothing about stock.
 *
 *   decreases   pre-ticked (owner rule)
 *   increases   never pre-ticked: a staff tick is required
 *   notSynced   the product is switched to "Don't sync with Page365": always
 *               skipped — shown, never proposed, never tickable, no photos
 *   excluded    a #195 invoice hold on the variant — only while
 *               page365_stock_mode is 'invoice' (the rollback); none since PR 2
 *   flagged     no code / duplicate / ambiguous / Hub-only: shown, never tickable
 *   new         code not in the Hub: listed only
 *   price       Page365 price differs from the Hub price: reported only
 *   photos      matched products with Page365 photos not yet copied: pre-ticked
 */

export type InventoryCategory =
  | 'pending' | 'decrease' | 'increase' | 'no_change' | 'excluded' | 'flagged' | 'new' | 'hub_only' | 'not_synced';

export type InventoryRunStatus = 'fetching' | 'ready' | 'partial' | 'failed';

export interface InventoryRun {
  id: string;
  status: InventoryRunStatus;
  page365_count: number | null;
  products_total: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface InventoryItem {
  id: string;
  run_id: string;
  kind: 'page365' | 'hub_only';
  page365_product_id: number | null;
  page365_variant_id: number | null;
  page365_name: string | null;
  variant_name: string | null;
  code: string | null;
  page365_price_jpy: number | null;
  page365_full_price_jpy: number | null;
  page365_available: number | null;
  match_result: string;
  website_product_id: string | null;
  variant_id: string | null;
  hub_sku: string | null;
  hub_price_jpy: number | null;
  seen_stock: number | null;
  web_holds: number | null;
  invoice_holds: number | null;
  proposed_stock: number | null;
  category: InventoryCategory;
  price_differs: boolean;
  photos_total: number;
  photos_to_copy: number;
  photos_removed: number;
  missing_runs: number | null;
  status: 'review' | 'applied' | 'changed_since_fetch' | 'failed';
  result_note: string | null;
}

export interface InventoryGroups {
  decreases: InventoryItem[];
  increases: InventoryItem[];
  excluded: InventoryItem[];
  notSynced: InventoryItem[];
  flagged: InventoryItem[];
  newInPage365: InventoryItem[];
  priceDiffs: InventoryItem[];
  photos: InventoryItem[];
  noChange: number;
}

const byCode = (a: InventoryItem, b: InventoryItem) =>
  (a.code ?? a.hub_sku ?? '').localeCompare(b.code ?? b.hub_sku ?? '');

export function groupItems(items: InventoryItem[]): InventoryGroups {
  const g: InventoryGroups = {
    decreases: [], increases: [], excluded: [], notSynced: [], flagged: [], newInPage365: [], priceDiffs: [], photos: [], noChange: 0,
  };
  for (const it of items) {
    if (it.category === 'decrease') g.decreases.push(it);
    else if (it.category === 'increase') g.increases.push(it);
    else if (it.category === 'excluded') g.excluded.push(it);
    else if (it.category === 'not_synced') g.notSynced.push(it);
    else if (it.category === 'flagged' || it.category === 'hub_only') g.flagged.push(it);
    else if (it.category === 'new') g.newInPage365.push(it);
    else if (it.category === 'no_change') g.noChange++;
    if (it.category === 'not_synced') continue;
    if (it.match_result === 'matched' && it.price_differs) g.priceDiffs.push(it);
    if (it.match_result === 'matched' && it.photos_to_copy > 0) g.photos.push(it);
  }
  for (const k of ['decreases', 'increases', 'excluded', 'notSynced', 'flagged', 'newInPage365', 'priceDiffs', 'photos'] as const) {
    g[k].sort(byCode);
  }
  return g;
}

/** Only rows still under review can be ticked for stock. */
export const stockTickable = (it: InventoryItem) =>
  it.status === 'review' && (it.category === 'decrease' || it.category === 'increase');

/** The owner rule: decreases start ticked, increases never do; photos start
 *  ticked (every photo of every matched product is copied). */
export function defaultSelection(items: InventoryItem[]): { stock: Set<string>; photos: Set<string> } {
  const stock = new Set<string>();
  const photos = new Set<string>();
  for (const it of items) {
    if (it.category === 'not_synced') continue;
    if (it.category === 'decrease' && it.status === 'review') stock.add(it.id);
    if (it.match_result === 'matched' && it.photos_to_copy > 0) photos.add(it.id);
  }
  return { stock, photos };
}

/** Split the ticks into the two lists page365_inventory_apply takes. An
 *  increase goes ONLY in the increase list: that is the explicit tick. */
export function splitStockSelection(items: InventoryItem[], ticked: Set<string>): {
  decreaseIds: string[]; increaseIds: string[];
} {
  const decreaseIds: string[] = [];
  const increaseIds: string[] = [];
  for (const it of items) {
    if (!ticked.has(it.id) || !stockTickable(it)) continue;
    (it.category === 'increase' ? increaseIds : decreaseIds).push(it.id);
  }
  return { decreaseIds, increaseIds };
}

export const MATCH_REASON: Record<string, string> = {
  no_code: 'No product code in the Page365 name',
  duplicate_in_page365: 'The same code appears on two Page365 listings',
  ambiguous_sku: 'Two Hub products share this code',
  no_variant: 'The Hub product has no variant',
  ambiguous_variant: 'The Hub product has several sizes/stones — never guessed',
  hub_only: 'In the Hub but not on Page365 — never zeroed automatically',
};

export const APPLY_REFUSAL: Record<string, string> = {
  forbidden: 'You need the Website catalog permission to apply stock.',
  nothing_selected: 'Tick at least one row.',
  id_in_both_lists: 'A row was sent as both a decrease and an increase.',
  run_not_found: 'This fetch no longer exists. Fetch again.',
  run_not_ready: 'This fetch did not read Page365 completely, so nothing can be applied. Fetch again.',
  run_stale: 'This fetch is more than 24 hours old. Fetch again.',
  superseded: 'A newer fetch exists. Review that one instead.',
};

export const SKIP_REASON: Record<string, string> = {
  not_in_run: 'not part of this fetch',
  already_applied: 'already applied',
  already_changed_since_fetch: 'stock had changed; fetch again',
  already_failed: 'failed earlier',
  invoice_hold: 'a Page365 invoice hold is on this piece',
  sync_disabled: 'switched to “Don’t sync with Page365”',
  not_a_stock_change: 'not a stock change',
  direction_mismatch: 'an increase must be ticked as an increase',
};

export function runStatusText(run: Pick<InventoryRun, 'status' | 'error'>): string {
  switch (run.status) {
    case 'fetching': return 'Reading Page365…';
    case 'ready': return 'Complete — ready to review';
    case 'partial': return `Incomplete (${run.error ?? 'some products could not be read'}) — nothing can be applied`;
    case 'failed': return `Failed (${run.error ?? 'Page365 could not be read'}) — nothing was changed`;
  }
}
