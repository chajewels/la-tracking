import { supabase } from '@/integrations/supabase/client';

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
  run: { status: string; error: string | null; products_total: number } | null;
  fetched: number;
  error: number;
  open: number;
}

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

export const startFetch = () => invoke<FetchProgress>('page365-inventory-fetch', { action: 'start' });
export const continueFetch = (runId: string) =>
  invoke<FetchProgress>('page365-inventory-fetch', { action: 'continue', run_id: runId });

export interface PhotoResult {
  copied: number;
  replaced: number;
  already: number;
  failed: { item_id: string; photo_id: number; reason: string }[];
  remaining: number;
}

export const copyPhotos = (runId: string, itemIds: string[], skip: string[]) =>
  invoke<PhotoResult>('page365-inventory-photos', { run_id: runId, item_ids: itemIds, skip });
