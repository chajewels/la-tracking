import { callUntypedRpc } from '@/lib/untyped-rpc';

/**
 * Catalog delete (2026-10-29). The ONE delete path is delete_website_product_atomic
 * (migration 20270220100000): it refuses a piece with a live-selling claim,
 * removes the piece's "not in Page365" rows, remembers its reviews by Page365
 * listing and deletes the product. The RPC is not in the generated types yet,
 * so it is called through callUntypedRpc (types.ts is never hand-edited).
 */
export interface DeleteProductResult {
  ok: boolean;
  sku: string | null;
  hub_only_removed: number;
  claims_cleared: number;
  items_unlinked: number;
  order_lines_unlinked: number;
  reviews_detached: number;
}

export function deleteWebsiteProduct(productId: string, reason?: string): Promise<DeleteProductResult> {
  return callUntypedRpc<DeleteProductResult>('delete_website_product_atomic', {
    p_product_id: productId,
    p_reason: reason ?? null,
  });
}

/** The confirm text. A product linked to a Page365 listing is told it can come back. */
export function deleteConfirmText(name: string, linkedToPage365: boolean): string {
  const base = `Remove ${name} from the website catalog? Orders and drafts keep their own copy of the code, name and price.`;
  return linkedToPage365
    ? `${base} If this piece is still in stock on Page365 it will come back as a new unpublished draft.`
    : base;
}

/** The success toast: what the delete cleaned up, in plain words (nothing when there was nothing). */
export function deleteSummary(r: Pick<DeleteProductResult, 'order_lines_unlinked' | 'reviews_detached'>): string | undefined {
  const parts: string[] = [];
  if (r.order_lines_unlinked > 0) parts.push(`${r.order_lines_unlinked} order or draft line${r.order_lines_unlinked === 1 ? '' : 's'} kept their own copy`);
  if (r.reviews_detached > 0) parts.push(`${r.reviews_detached} review${r.reviews_detached === 1 ? '' : 's'} will return if the piece lands again`);
  return parts.length ? parts.join('; ') + '.' : undefined;
}
