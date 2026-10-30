import {
  ConditionValue, METAL_VALUES, OriginValue,
} from "@/lib/website-catalog-import";

/**
 * The product editor's form shape and the pure helpers the card and the dialog
 * both need.
 *
 * Split out for one reason: ProductsCard owns the state and the mutations,
 * ProductDialog renders the form, and a type cannot live in only one of them.
 * Same arrangement as newsletter-types.ts next door. Nothing here talks to
 * Supabase, and none of it changed in the split.
 */

/** Served from public/ — the Page365 upload sheet with the hub_* columns. */
export const TEMPLATE_PATH = "/templates/cha-jewels-product-upload-template.xlsx";

export type Status = "draft" | "active" | "archived";

/**
 * What the piece is (website_products.item_kind): exactly three types (owner
 * decision 2026-09-26). A metal stamp is required ONLY for jewelry, and only to
 * PUBLISH (DB CHECK website_products_metals_jewelry applies to status active;
 * a draft may be saved without one and shows "needs metal stamp"). Watches and
 * accessories (JA 小物: wallets, bags, cases, belts …) never need one.
 */
export const ITEM_KINDS = ["jewelry", "watch", "accessory"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABEL: Record<ItemKind, string> = { jewelry: "Jewelry", watch: "Watch", accessory: "Accessory" };
/** 'other' was renamed 'accessory' (2026-09-26); anything unknown reads as jewelry. */
export const itemKindFrom = (v: unknown): ItemKind =>
  v === "other" ? "accessory" : (ITEM_KINDS as readonly string[]).includes(v as string) ? (v as ItemKind) : "jewelry";
/** The one client-side twin of the DB rule: jewelry needs a stamp to be published. */
export const metalRequired = (kind: ItemKind) => kind === "jewelry";

/**
 * Metal values a product can carry: the importer's list plus SILVER (2026-09-26,
 * a piece Page365 marks only "SV"). The upload template keeps METAL_VALUES.
 */
export const PRODUCT_METAL_VALUES = [...METAL_VALUES, "SILVER"] as const;
export type ProductMetal = (typeof PRODUCT_METAL_VALUES)[number];
/** Display names where the stored value is not how staff say it. */
export const METAL_LABEL: Partial<Record<ProductMetal, string>> = { SILVER: "Silver", SILVER925: "Silver 925" };
export const metalLabel = (m: string) => METAL_LABEL[m as ProductMetal] ?? m;

/**
 * Metals are shown exactly as stamped (METAL_VALUES is the single source of
 * truth, shared with the importer). A piece can carry several — PT900/K18 —
 * in the order staff pick them. Nothing is merged: 750 is 750, not K18.
 */
export const metalsLabel = (metals: unknown, karat?: string | null) => {
  const list = Array.isArray(metals) && metals.length ? (metals as string[]) : karat ? [karat] : [];
  return list.length ? list.map(metalLabel).join(" / ") : "—";
};

export interface MediaRow {
  id?: string;
  url: string;
  alt: string | null;
  sort: number;
  /** Set on photos copied from Page365 (Website -> Page365 stock). Carried
   *  through every save: the editor rewrites a variant's media rows, and a row
   *  that lost its Page365 id would be copied AGAIN by the next fetch — a
   *  duplicate photo. Null / absent = uploaded by staff. */
  page365_photo_id?: number | null;
  page365_photo_version?: string | null;
}
export interface VariantRow {
  id?: string;
  size: string | null;
  stone: string | null;
  /** The FULL price of record (Page365, imports and the publish guard read it). */
  price_jpy: number;
  /** Optional sale price, whole yen, always below price_jpy; null = not on
   *  sale. The website charges and shows it (website_variant_price_jpy). */
  sale_price_jpy: number | null;
  cost_basis: number | null;
  stock_qty: number;
  sort: number;
  media: MediaRow[];
}
export interface ProductForm {
  id?: string;
  sku: string;
  slug: string;
  name: string;
  /** Generated when missing (Save) or by the explicit "Regenerate Japanese name"
   *  button — never typed by staff, never replaced automatically (name-ja.ts). */
  name_ja: string;
  /** jewelry | watch | other. Decides whether a metal stamp is required. */
  itemKind: ItemKind;
  /** Stamps in the order picked; at least one to save JEWELRY, optional otherwise. */
  metals: ProductMetal[];
  weight_g: number | null;
  condition: ConditionValue;
  /** The only source of any origin claim on the site — see OriginBadge there. */
  origin: OriginValue;
  brand: string;
  description_en: string;
  /** Typed by staff, independent of description_en. Saved as written, except that spaces at the start and end are trimmed. */
  description_ja: string;
  /** The English description the current Japanese one was written against.
   *  Display only (the "English changed" hint) — Save never translates from it. */
  jaSourceEn: string;
  status: Status;
  /** "Don't sync with Page365" (website_products.page365_sync_disabled). On =
   *  the Page365 inventory fetch always skips this product and an invoice
   *  import never moves its stock. Default off. */
  page365SyncDisabled: boolean;
  /** The piece's MP4 (website_products.video_url), shown in the website gallery. Null = none. */
  videoUrl: string | null;
  /** A still from the clip, taken on upload (website_products.video_poster_url). */
  videoPosterUrl: string | null;
  /** The loaded row carries the video columns (migration 20261015100000 applied).
   *  Until then the save leaves them out, so a release ahead of the apply cannot
   *  break saving products. */
  videoColumns: boolean;
  collectionIds: string[];
  /** website_category_products, in the order picked. */
  categoryIds: string[];
  variants: VariantRow[];
  /** What the product looked like when the editor opened it (not rendered).
   *  Save skips the variant, photo and link-table rewrites that would not
   *  change anything — every one of those writes fires a website refresh.
   *  Null for a new product: everything is written. */
  loaded: LoadedSnapshot | null;
}

/** A variant as it was read, in the same shape the save writes it. */
export interface LoadedVariant {
  id: string;
  size: string | null;
  stone: string | null;
  price_jpy: number;
  sale_price_jpy: number | null;
  cost_basis: number | null;
  stock_qty: number;
  sort: number;
  media: Array<Pick<MediaRow, "url" | "alt" | "sort" | "page365_photo_id" | "page365_photo_version">>;
}
export interface LoadedSnapshot {
  /** The descriptions as read, trimmed. Save writes a description column only
   *  when the form differs from these (description-ja.ts). */
  description_en: string;
  description_ja: string;
  /** Identity fields as stored. Save sends one only when staff changed it. */
  sku: string;
  slug: string;
  name: string;
  name_ja: string;
  /** The Japanese columns exactly as stored when the editor opened (null stays null).
   *  A Save that changes one updates it only while the database still holds this value. */
  storedJa: { name_ja: string | null; description_ja: string | null };
  variants: LoadedVariant[];
  collectionIds: string[];
  categoryIds: string[];
}

/** Same ids in the same order. */
export const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** The variant row the save would write equals the one that was loaded. */
export const sameVariantRow = (
  row: Pick<LoadedVariant, "size" | "stone" | "price_jpy" | "sale_price_jpy" | "cost_basis" | "stock_qty" | "sort">,
  was: LoadedVariant,
) =>
  row.size === was.size && row.stone === was.stone && row.price_jpy === was.price_jpy &&
  row.sale_price_jpy === was.sale_price_jpy && row.cost_basis === was.cost_basis &&
  row.stock_qty === was.stock_qty && row.sort === was.sort;

/** The photo rows the save would write (url, alt, order, Page365 ids) equal the loaded ones. */
export const sameMedia = (
  rows: ReadonlyArray<Pick<MediaRow, "url" | "alt" | "sort" | "page365_photo_id" | "page365_photo_version">>,
  was: LoadedVariant["media"],
) =>
  rows.length === was.length && rows.every((m, i) =>
    m.url === was[i].url && (m.alt ?? null) === (was[i].alt ?? null) && m.sort === was[i].sort &&
    (m.page365_photo_id ?? null) === (was[i].page365_photo_id ?? null) &&
    (m.page365_photo_version ?? null) === (was[i].page365_photo_version ?? null));

export const emptyVariant = (sort: number): VariantRow => ({
  size: "", stone: "", price_jpy: 0, sale_price_jpy: null, cost_basis: null, stock_qty: 0, sort, media: [],
});

/**
 * Why a variant's sale price cannot be saved, or null when it can (blank = no
 * sale). Mirrors the DB CHECK website_variants_sale_below_price: a whole yen
 * amount above 0 and below the full price.
 */
export function saleError(v: Pick<VariantRow, "price_jpy" | "sale_price_jpy">): string | null {
  if (v.sale_price_jpy === null || v.sale_price_jpy === undefined) return null;
  const sale = Number(v.sale_price_jpy);
  const full = Number(v.price_jpy);
  if (!Number.isInteger(sale) || sale <= 0) return "Sale price must be a whole yen amount above 0.";
  if (!(sale < full)) return `Sale price must be below the full price (¥${full.toLocaleString("en-US")}).`;
  return null;
}

export const emptyProduct = (): ProductForm => ({
  sku: "", slug: "", name: "", name_ja: "", itemKind: "jewelry", metals: ["K18"], weight_g: null, condition: "New",
  origin: "UNKNOWN", brand: "",
  description_en: "", description_ja: "", jaSourceEn: "",
  status: "draft", page365SyncDisabled: false, videoUrl: null, videoPosterUrl: null, videoColumns: false, collectionIds: [], categoryIds: [], variants: [emptyVariant(0)],
  loaded: null,
});

/**
 * The identity columns (SKU, web address, English and Japanese name) a Save
 * sends. A new product sends all of them. An existing product sends only the
 * ones staff changed, so an edit to anything else — a description, a price —
 * cannot rewrite a protected name, SKU or slug, not even by trimming it.
 */
export function identityWrites(
  f: Pick<ProductForm, "id" | "sku" | "slug" | "name" | "name_ja" | "loaded">, slug: string,
): { sku?: string; slug?: string; name?: string; name_ja?: string | null } {
  const now = { sku: f.sku.trim(), slug, name: f.name.trim(), name_ja: f.name_ja.trim() || null };
  const was = f.id ? f.loaded : null;
  if (!was) return now;
  const out: { sku?: string; slug?: string; name?: string; name_ja?: string | null } = {};
  if (now.sku !== was.sku.trim()) out.sku = now.sku;
  // Compared on what staff TYPED, not on the generated fallback: an existing
  // product whose saved slug is empty and untouched must not get one invented
  // from its name by an unrelated save. Clearing a saved slug still falls back
  // to slugify(name) — that policy is unchanged.
  if (f.slug.trim() !== was.slug.trim()) out.slug = now.slug;
  if (now.name !== was.name.trim()) out.name = now.name;
  if (now.name_ja !== (was.name_ja.trim() || null)) out.name_ja = now.name_ja;
  return out;
}

export const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const yen = (n: number) => `¥ ${Math.round(n).toLocaleString("en-US")}`;
