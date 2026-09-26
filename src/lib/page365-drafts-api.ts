import { supabase } from '@/integrations/supabase/client';
import { callUntypedRpc } from '@/lib/untyped-rpc';
import type { LandedProduct, PublishResult } from '@/lib/page365-drafts';

/**
 * RPCs and tables from migrations 20260929100000_page365_inventory_drafts and
 * 20261005100000_page365_auto_land are not in src/integrations/supabase/types.ts
 * until Lovable regenerates it. types.ts is never hand-edited (CLAUDE.md,
 * GENERATED FILES), so the untyped access lives here. RPCs go through
 * callUntypedRpc: never store supabase.rpc in a variable (it loses `this`; see
 * docs/FIXED-BUGS.md).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untyped = supabase as unknown as { from: (table: string) => any };

export async function publishProducts(productIds: string[]): Promise<PublishResult> {
  const data = await callUntypedRpc<PublishResult | null>('website_publish_products', { p_product_ids: productIds });
  return data ?? { ok: false, reason: 'no_response' };
}

/** 2026-09-26: products that landed in the Catalog by themselves, newest first. */
export async function listLandings(limit = 50): Promise<LandedProduct[] | null> {
  const { data, error } = await untyped.from('page365_landings')
    .select('product_id, code, name, item_kind, landed_at, photos_total, photos_done_at, photo_failures, '
      + 'website_products(id, sku, name, status, origin, brand, metals, item_kind, '
      + 'website_category_products(category_id), website_product_variants(price_jpy))')
    .order('landed_at', { ascending: false }).limit(limit);
  if (error) {
    // Before the 2026-09-26 migration there is no page365_landings table.
    if (/page365_landings/.test(error.message)) return null;
    throw error;
  }
  return (data ?? []) as LandedProduct[];
}
