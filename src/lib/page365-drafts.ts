/**
 * Page365 products that LAND in the Catalog by themselves, and Catalog bulk
 * publish — display logic.
 *
 * 2026-09-26 (owner decision, replaces "Create drafts"): every NEW, in-stock
 * Page365 code of a complete read becomes an UNPUBLISHED Catalog product by
 * itself (SQL page365_inventory_land_run, migration
 * 20261005100000_page365_auto_land.sql). A product missing something still
 * lands and is marked "incomplete — needs …"; publishing is refused on the
 * server until it is filled (website_product_publish_missing is the one
 * definition; publishMissing below is its display twin). Nothing here decides.
 */

export const NEEDS_LABEL: Record<string, string> = {
  origin: 'needs origin',
  category: 'needs category',
  brand: 'needs brand name',
  metal: 'needs metal stamp',
  price: 'needs price',
};


/** A row of the "Landed in Catalog" list (page365_landings + its product). */
export interface LandedProduct {
  product_id: string;
  code: string;
  name: string | null;
  item_kind: string | null;
  landed_at: string;
  photos_total: number;
  photos_done_at: string | null;
  photo_failures: number;
  website_products: {
    id: string; sku: string; name: string | null; status: string; origin: string | null; brand: string | null;
    metals: unknown; item_kind: string | null;
    website_category_products: unknown[] | null;
    website_product_variants: { price_jpy: number | null }[] | null;
  } | null;
}

/** Item types as staff read them (owner decision 2026-09-26: three types). */
export const KIND_LABEL: Record<string, string> = { jewelry: 'Jewelry', watch: 'Watch', accessory: 'Accessory', other: 'Accessory' };

/** "incomplete — needs origin, category" for a landed product still a draft; '' when complete or published. */
export function incompleteText(l: LandedProduct): string {
  const p = l.website_products;
  if (!p || p.status !== 'draft') return '';
  const m = publishMissing(p);
  return m.length ? `incomplete — ${missingText(m)}` : '';
}

/** Photo copy state of a landed product. */
export function photoText(l: LandedProduct): string {
  if (l.photos_total === 0) return 'no photos on Page365';
  if (!l.photos_done_at) return `copying ${l.photos_total} photo(s)…`;
  return l.photo_failures > 0 ? `photos copied, ${l.photo_failures} could not be copied` : `${l.photos_total} photo(s)`;
}

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
