import { supabase } from '@/integrations/supabase/client';
import { callUntypedRpc } from '@/lib/untyped-rpc';
import type { CreateDraftsResult, PublishResult } from '@/lib/page365-drafts';

/**
 * RPCs and columns from migration 20260929100000_page365_inventory_drafts are
 * not in src/integrations/supabase/types.ts until Lovable regenerates it.
 * types.ts is never hand-edited (CLAUDE.md, GENERATED FILES), so the untyped
 * access lives here. RPCs go through callUntypedRpc: never store supabase.rpc
 * in a variable (it loses `this`; see docs/FIXED-BUGS.md).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untyped = supabase as unknown as { from: (table: string) => any };

export async function createDrafts(runId: string, itemIds: string[]): Promise<CreateDraftsResult> {
  const data = await callUntypedRpc<CreateDraftsResult | null>('page365_inventory_create_drafts', {
    p_run_id: runId, p_item_ids: itemIds,
  });
  return data ?? { ok: false, reason: 'no_response' };
}

export async function publishProducts(productIds: string[]): Promise<PublishResult> {
  const data = await callUntypedRpc<PublishResult | null>('website_publish_products', { p_product_ids: productIds });
  return data ?? { ok: false, reason: 'no_response' };
}

/** Page365 category of each listing in a run (id of the products row -> name). */
export async function listCategories(runId: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await untyped.from('page365_inventory_products')
      .select('id, list_category').eq('run_id', runId).range(from, from + 999);
    if (error) {
      // Before the PR 4 migration the column does not exist: no categories.
      if (/list_category/.test(error.message)) return out;
      throw error;
    }
    for (const r of (data ?? []) as { id: string; list_category: string | null }[]) out.set(r.id, r.list_category);
    if (!data || data.length < 1000) break;
  }
  return out;
}
