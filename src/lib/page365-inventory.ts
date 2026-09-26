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
 *   increases   pre-ticked too since PR 3c (owner decision 2026-09-26: staff
 *               confirm every website sale in Page365, so Page365 is the full
 *               truth); still sent ONLY in the increase list
 *   notSynced   the product is switched to "Don't sync with Page365": always
 *               skipped — shown, never proposed, never tickable, no photos
 *   excluded    a #195 invoice hold on the variant — only while
 *               page365_stock_mode is 'invoice' (the rollback); none since PR 2
 *   flagged     no code / duplicate / ambiguous / Hub-only: shown, never tickable
 *   new         code not in the Hub: listed only
 *   price       Page365 price differs from the Hub price: reported only
 *   photos      matched products with Page365 photos not yet copied: pre-ticked
 *   hides       PR 3b: a synced product missing from 2 complete reads in a row
 *               (seen before, still published): "Hide on website" (stock 0 +
 *               unpublish) — pre-ticked, applied by page365_inventory_hide
 *   backIn      PR 3b: a product the Hub hid that Page365 lists again:
 *               "re-publish?" — never pre-ticked, never automatic
 */

export type InventoryCategory =
  | 'pending' | 'decrease' | 'increase' | 'no_change' | 'excluded' | 'flagged' | 'new' | 'hub_only' | 'not_synced'
  | 'hide';

export type InventoryRunStatus = 'fetching' | 'ready' | 'partial' | 'failed';

export type InventoryRunSource = 'manual' | 'schedule';

/** PR 3c: quick = the list plus Hub products' pages; full = every page. */
export type InventoryRunKind = 'quick' | 'full';

/** PR 3: what closing a SCHEDULED run did (NULL on manual runs / still open). */
export type AutoApplyState = 'applied' | 'off' | 'not_ready' | 'window_passed' | 'superseded';

export interface InventoryRun {
  id: string;
  /** Absent only on a row read before PR 1's column existed (never in practice). */
  source?: InventoryRunSource;
  status: InventoryRunStatus;
  page365_count: number | null;
  products_total: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  /** PR 3 columns — absent until migration 20260930100000 is applied. */
  auto_apply_state?: AutoApplyState | null;
  auto_applied?: number | null;
  auto_apply_changed?: number | null;
  auto_apply_skipped?: number | null;
  auto_apply_at?: string | null;
  /** PR 3b — absent until migration 20261001100000 is applied. */
  hidden_count?: number | null;
  /** PR 3c — absent until migration 20261002100000 is applied (then every
   *  earlier run is 'full'). */
  kind?: InventoryRunKind;
  listed_total?: number | null;
  auto_increased?: number | null;
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
  /** PR 3b: a matched row whose product the Hub hid and which is still a draft. */
  back_in_page365?: boolean;
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
  /** PR 3b */
  hides: InventoryItem[];
  backIn: InventoryItem[];
  noChange: number;
}

const byCode = (a: InventoryItem, b: InventoryItem) =>
  (a.code ?? a.hub_sku ?? '').localeCompare(b.code ?? b.hub_sku ?? '');

export function groupItems(items: InventoryItem[]): InventoryGroups {
  const g: InventoryGroups = {
    decreases: [], increases: [], excluded: [], notSynced: [], flagged: [], newInPage365: [], priceDiffs: [], photos: [],
    hides: [], backIn: [], noChange: 0,
  };
  for (const it of items) {
    if (it.category === 'decrease') g.decreases.push(it);
    else if (it.category === 'increase') g.increases.push(it);
    else if (it.category === 'excluded') g.excluded.push(it);
    else if (it.category === 'not_synced') g.notSynced.push(it);
    else if (it.category === 'flagged' || it.category === 'hub_only') g.flagged.push(it);
    else if (it.category === 'new') g.newInPage365.push(it);
    else if (it.category === 'no_change') g.noChange++;
    else if (it.category === 'hide') g.hides.push(it);
    if (it.category === 'not_synced') continue;
    // A product back in Page365 also keeps its stock row (usually an increase).
    if (it.back_in_page365 && it.match_result === 'matched' && it.website_product_id) g.backIn.push(it);
    if (it.match_result === 'matched' && it.price_differs) g.priceDiffs.push(it);
    if (it.match_result === 'matched' && it.photos_to_copy > 0) g.photos.push(it);
  }
  for (const k of ['decreases', 'increases', 'excluded', 'notSynced', 'flagged', 'newInPage365', 'priceDiffs', 'photos', 'hides', 'backIn'] as const) {
    g[k].sort(byCode);
  }
  return g;
}

/** Only rows still under review can be ticked for stock. */
export const stockTickable = (it: InventoryItem) =>
  it.status === 'review' && (it.category === 'decrease' || it.category === 'increase');

/** PR 3b: only "Hide on website" rows still under review can be ticked. */
export const hideTickable = (it: InventoryItem) => it.status === 'review' && it.category === 'hide';

/** The owner rule: decreases start ticked, and since PR 3c increases do too;
 *  photos start ticked (every photo of every matched product is copied).
 *  PR 3b: hides start ticked; re-publish NEVER does (it is not even part of
 *  this selection). */
export function defaultSelection(items: InventoryItem[]): { stock: Set<string>; photos: Set<string>; hides: Set<string> } {
  const stock = new Set<string>();
  const photos = new Set<string>();
  const hides = new Set<string>();
  for (const it of items) {
    if (it.category === 'not_synced') continue;
    if (stockTickable(it)) stock.add(it.id);
    if (hideTickable(it)) hides.add(it.id);
    if (it.match_result === 'matched' && it.photos_to_copy > 0) photos.add(it.id);
  }
  return { stock, photos, hides };
}

/** PR 3b: the ticked "Back in Page365" rows as the product ids
 *  website_publish_products takes (one per product). */
export function republishProductIds(items: InventoryItem[], ticked: Set<string>): string[] {
  const out = new Set<string>();
  for (const it of items) {
    if (ticked.has(it.id) && it.back_in_page365 && it.website_product_id) out.add(it.website_product_id);
  }
  return [...out];
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
  hub_only: 'In the Hub but not on Page365',
};

/** PR 3b: why a Hub-only row is NOT a "Hide on website" row, in words. */
export function hubOnlyReason(it: Pick<InventoryItem, 'missing_runs'>): string {
  const n = it.missing_runs ?? 0;
  const row = n ? ` · missing in ${n} complete fetch${n > 1 ? 'es' : ''} in a row` : '';
  return n >= 2
    ? `In the Hub but not on Page365${row}. Not hidden: never seen on Page365 under this code, or not published`
    : `In the Hub but not on Page365${row}. Hidden after 2 complete fetches in a row if it was on Page365 before`;
}

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
  // PR 3 — notes page365_inventory_auto_apply_run leaves on a row
  auto_applied: 'applied automatically (scheduled fetch)',
  not_a_decrease: 'not a decrease; left for staff',
  // PR 3b — notes page365_inventory_hide_item leaves on a row
  hidden: 'hidden on the website',
  auto_hidden: 'hidden automatically (scheduled fetch)',
  not_a_hide: 'not a hide row',
  never_seen: 'never seen on Page365 under this code',
  product_gone: 'the Hub product no longer exists',
};

export function runStatusText(run: Pick<InventoryRun, 'status' | 'error'>): string {
  switch (run.status) {
    case 'fetching': return 'Reading Page365…';
    case 'ready': return 'Complete — ready to review';
    case 'partial': return `Incomplete (${run.error ?? 'some products could not be read'}) — nothing can be applied`;
    case 'failed': return `Failed (${run.error ?? 'Page365 could not be read'}) — nothing was changed`;
  }
}

/** PR 3: "Scheduled" / "Manual" for the run history and the last-fetch line. */
export const runSourceLabel = (run: Pick<InventoryRun, 'source'>): string =>
  run.source === 'schedule' ? 'Scheduled' : 'Manual';

/** PR 3c: "Quick" / "Full". A run without a kind predates PR 3c: full. */
export const runKindLabel = (run: Pick<InventoryRun, 'kind'>): string =>
  run.kind === 'quick' ? 'Quick' : 'Full';

/** PR 3c: how long a read took ("42 s", "3 min 5 s"); "—" while reading. */
export function runDuration(run: Pick<InventoryRun, 'created_at' | 'finished_at'>): string {
  if (!run.finished_at) return '—';
  const s = Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.created_at).getTime()) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** PR 3c: when the nightly full read happens (system_settings
 *  page365_inventory_full_hour_pht, default 2 = 02:00 PHT = 03:00 JST). */
export const NIGHTLY_FULL_TEXT = '02:00 PHT (03:00 JST)';

/** PR 3b: "2 products hidden on the website". */
export const hiddenText = (n: number): string => `${n} product${n === 1 ? '' : 's'} hidden on the website`;

/** PR 3 (PR 3c: with increases): what the automatic updates did on a
 *  scheduled run, in words. Manual runs never auto-apply: they say so. */
export function autoApplyText(run: Pick<InventoryRun, 'source' | 'status' | 'auto_apply_state' | 'auto_applied' | 'hidden_count'
  | 'auto_increased'>): string {
  if (run.source !== 'schedule') return 'Manual fetch — nothing applied automatically';
  if (run.status === 'fetching') return 'Reading Page365…';
  switch (run.auto_apply_state) {
    case 'applied': {
      const n = run.auto_applied ?? 0;
      const up = Math.min(n, run.auto_increased ?? 0);
      const down = n - up;
      const h = run.hidden_count ?? 0;
      const parts: string[] = [];
      if (down > 0) parts.push(`${down} decrease${down === 1 ? '' : 's'}`);
      if (up > 0) parts.push(`${up} increase${up === 1 ? '' : 's'}`);
      const stock = parts.length === 0 ? 'No stock changes to apply' : `${parts.join(' · ')} applied automatically`;
      return h > 0 ? `${stock} · ${hiddenText(h)}` : stock;
    }
    case 'off': return 'Automatic updates off — nothing applied';
    case 'not_ready': return 'Incomplete read — nothing applied';
    case 'window_passed': return 'Finished too late (over 30 minutes) — nothing applied';
    case 'superseded': return 'A newer fetch existed — nothing applied';
    default: return 'Not closed yet';
  }
}

/** PR 3: the scheduled fetch refuses nothing to staff — but the switch RPC
 *  can. Words for its refusals. */
export function autoApplyRefusal(code: string): string {
  switch (code) {
    case 'permission_denied': return 'You need the Website catalog permission to change automatic updates.';
    case 'user_identity_required': return 'Your session has expired. Sign in again.';
    case 'stale': return 'Someone else changed this a moment ago. The card now shows the current state.';
    case 'setting_missing': return 'The switch is missing from system settings. Ask Claude Code to check the PR 3 migration.';
    default: return code || 'Could not change automatic updates.';
  }
}

/** PR 3d — "Check Page365 every" (system_settings.page365_inventory_interval_minutes).
 *  Only these values; the RPC refuses anything else (invalid_interval). */
export const INTERVAL_CHOICES = [5, 10, 20, 30] as const;
export type IntervalMinutes = typeof INTERVAL_CHOICES[number];

/** Words for set_page365_inventory_interval's refusals. */
export function intervalRefusal(code: string): string {
  switch (code) {
    case 'permission_denied': return 'You need the Website catalog permission to change how often Page365 is checked.';
    case 'user_identity_required': return 'Your session has expired. Sign in again.';
    case 'invalid_interval': return 'Choose 5, 10, 20 or 30 minutes.';
    case 'stale': return 'Someone else changed this a moment ago. The card now shows the current interval.';
    case 'setting_missing': return 'The interval is missing from system settings. Ask Claude Code to check the PR 3d migration.';
    default: return code || 'Could not change how often Page365 is checked.';
  }
}

/** "Next check around 14:07 (PHT)" — the time only, in PHT. `reading` is what
 *  is reading Page365 right now ('schedule' | 'manual' | null). */
export function nextCheckText(nextCheckAt: string | null, reading: string | null): string {
  if (reading === 'schedule') return 'Checking Page365 now…';
  if (!nextCheckAt) return '';
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(nextCheckAt));
  const base = `Next check around ${hhmm} (PHT)`;
  return reading === 'manual' ? `${base}, once the staff fetch in progress has finished.` : `${base}.`;
}

/** PR 3: while the browser reads, a { busy } answer means another reader (the
 *  schedule) holds the run's lease — wait, and do not count it as a stall. */
export const FETCH_BUSY_WAIT_MS = 3_000;
export const FETCH_BUSY_MAX_WAITS = 200;

/** PR 3b: the Catalog note on a product the Hub hid because Page365 stopped
 *  listing it. Only while it is still a draft — once staff publish it again
 *  (or archive it) the note no longer describes it. The date is the PHT day. */
export function hiddenByPage365Note(status: string | null | undefined, hiddenAt: string | null | undefined): string | null {
  if (status !== 'draft' || !hiddenAt) return null;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(hiddenAt));
  return `Hidden — no longer on Page365 (${day})`;
}
