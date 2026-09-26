import { supabase } from '@/integrations/supabase/client';
import { callUntypedRpc } from '@/lib/untyped-rpc';

/**
 * The page365_inventory_* tables and RPCs ship in migration
 * 20260927100000_page365_inventory_fetch and are not in
 * src/integrations/supabase/types.ts until Lovable regenerates it on its next
 * deploy. types.ts is never hand-edited (CLAUDE.md, GENERATED FILES), so the
 * untyped access lives here instead of as a cast at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untyped = supabase as unknown as { from: (table: string) => any };

export const runsTable = () => untyped.from('page365_inventory_runs');
export const itemsTable = () => untyped.from('page365_inventory_items');
export const productsTable = () => untyped.from('page365_inventory_products');

export interface ApplyResult {
  ok: boolean;
  reason?: string;
  applied?: number;
  changed_since_fetch?: number;
  skipped?: number;
  failed?: number;
  skipped_items?: { id: string; reason: string }[];
  failed_items?: { id: string; reason: string }[];
}

export async function applyInventory(runId: string, decreaseIds: string[], increaseIds: string[]): Promise<ApplyResult> {
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string, args: Record<string, unknown>,
  ) => Promise<{ data: ApplyResult | null; error: { message: string } | null }>)(
    'page365_inventory_apply', { p_run_id: runId, p_decrease_ids: decreaseIds, p_increase_ids: increaseIds },
  );
  if (error) throw new Error(error.message);
  return data ?? { ok: false, reason: 'no_response' };
}

export interface FetchProgress {
  run_id: string;
  resumed?: boolean;
  /** PR 3: another reader (the scheduled fetch) holds the run's lease. */
  busy?: boolean;
  run: { status: string; error: string | null; products_total: number; source?: string; kind?: FetchKind } | null;
  fetched: number;
  error: number;
  open: number;
  /** PR 3c: quick runs — on the list, page not opened. */
  listed?: number;
}

/** PR 3c: quick = the list plus Hub products' pages (the default); full =
 *  every product page ("Full fetch", and nightly on the schedule). */
export type FetchKind = 'quick' | 'full';

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    // supabase-js hides the function's JSON body behind a generic message.
    let msg = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      const j = ctx ? await ctx.json() : null;
      if (j?.error) msg = j.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  return data as T;
}

export const startFetch = (kind: FetchKind = 'quick') =>
  invoke<FetchProgress>('page365-inventory-fetch', { action: 'start', kind });
export const continueFetch = (runId: string) =>
  invoke<FetchProgress>('page365-inventory-fetch', { action: 'continue', run_id: runId });

export interface PhotoResult {
  copied: number;
  replaced: number;
  already: number;
  /** PR 2: ticked products skipped because they are switched to "Don't sync with Page365". */
  not_synced?: number;
  failed: { item_id: string; photo_id: number; reason: string }[];
  remaining: number;
}

export const copyPhotos = (runId: string, itemIds: string[], skip: string[]) =>
  invoke<PhotoResult>('page365-inventory-photos', { run_id: runId, item_ids: itemIds, skip });

/** PR 3c — Create drafts reads its ticked listings FRESH first. Call until
 *  remaining is 0; `skip` = listing rows that already failed this press. */
export interface RefreshResult {
  busy: boolean;
  refreshed: number;
  gone: number;
  failed: { product_row_id: string; page365_product_id: number; reason: string }[];
  remaining: number;
}

export const refreshForDrafts = (runId: string, itemIds: string[], skip: string[]) =>
  invoke<RefreshResult>('page365-inventory-fetch', { action: 'refresh', run_id: runId, item_ids: itemIds, skip });

/** PR 3 — the automatic switch (automatic updates: decreases, increases,
 *  hiding since PR 3c; at the chosen interval since PR 3d). Both RPCs ship in
 *  migration 20260930100000_page365_inventory_schedule and are not in
 *  types.ts until Lovable regenerates it — hence the cast. */
export interface AutoApplyState {
  found: boolean;
  enabled: boolean;
  updated_at: string | null;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  can_change: boolean;
}

async function switchRpc(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string, args?: Record<string, unknown>,
  ) => Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }>)(name, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const out = data ?? {};
  if (typeof out.error === 'string') throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

export const getAutoApply = async () =>
  (await switchRpc('get_page365_inventory_auto_apply')) as unknown as AutoApplyState;
export const setAutoApply = (enabled: boolean, expected: boolean | null) =>
  switchRpc('set_page365_inventory_auto_apply', { p_enabled: enabled, p_expected: expected });

/** PR 3d — "Check Page365 every" 5 / 10 / 20 / 30 minutes. Both RPCs ship in
 *  migration 20261003100000_page365_interval and are not in types.ts until
 *  Lovable regenerates it. Always called as a method (callUntypedRpc). */
export interface IntervalState {
  found: boolean;
  minutes: number;
  allowed: number[];
  updated_at: string | null;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  last_scheduled_at: string | null;
  reading: 'schedule' | 'manual' | null;
  next_check_at: string | null;
  can_change: boolean;
}

async function intervalRpc(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = (await callUntypedRpc<Record<string, unknown> | null>(name, args)) ?? {};
  if (typeof out.error === 'string') throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

export const getScheduleInterval = async () =>
  (await intervalRpc('get_page365_inventory_interval')) as unknown as IntervalState;
export const setScheduleInterval = (minutes: number, expected: number | null) =>
  intervalRpc('set_page365_inventory_interval', { p_minutes: minutes, p_expected: expected });

/** PR 3b — "Hide on website" rows (stock 0 + unpublish, compare-and-set).
 *  The RPC ships in migration 20261001100000_page365_hide_follow and is not in
 *  types.ts until Lovable regenerates it. Always called as a method (callUntypedRpc). */
export interface HideResult {
  ok: boolean;
  reason?: string;
  hidden?: number;
  changed_since_fetch?: number;
  skipped?: number;
  failed?: number;
  skipped_items?: { id: string; reason: string }[];
  failed_items?: { id: string; reason: string }[];
}

export async function hideOnWebsite(runId: string, itemIds: string[]): Promise<HideResult> {
  const data = await callUntypedRpc<HideResult | null>('page365_inventory_hide', { p_run_id: runId, p_item_ids: itemIds });
  return data ?? { ok: false, reason: 'no_response' };
}

/** PR 3b — which products the Hub hid because Page365 stopped listing them
 *  (page365_product_presence.hidden_at). Catalog shows the note on drafts. */
export async function fetchHiddenByPage365(): Promise<Map<string, string>> {
  const { data, error } = await untyped.from('page365_product_presence')
    .select('website_product_id, hidden_at').not('hidden_at', 'is', null);
  if (error) throw error;
  return new Map(((data ?? []) as { website_product_id: string; hidden_at: string }[])
    .map(r => [r.website_product_id, r.hidden_at]));
}
