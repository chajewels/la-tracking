import {
  ConditionValue, MetalValue, OriginValue,
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
 * Metals are shown exactly as stamped (METAL_VALUES is the single source of
 * truth, shared with the importer). A piece can carry several — PT900/K18 —
 * in the order staff pick them. Nothing is merged: 750 is 750, not K18.
 */
export const metalsLabel = (metals: unknown, karat?: string | null) => {
  const list = Array.isArray(metals) && metals.length ? (metals as string[]) : karat ? [karat] : [];
  return list.length ? list.join(" / ") : "—";
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
  price_jpy: number;
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
  /** Generated from `name` on save — never typed by staff. */
  name_ja: string;
  /** English name as last saved — the Japanese name only refreshes when it changes. */
  savedName: string;
  /** Stamps in the order picked; at least one to save. */
  metals: MetalValue[];
  weight_g: number | null;
  condition: ConditionValue;
  /** The only source of any origin claim on the site — see OriginBadge there. */
  origin: OriginValue;
  brand: string;
  description_en: string;
  description_ja: string;
  /** English text as last saved — the translation only refreshes when it changes. */
  savedEn: string;
  status: Status;
  /** "Don't sync with Page365" (website_products.page365_sync_disabled). On =
   *  the Page365 inventory fetch always skips this product and an invoice
   *  import never moves its stock. Default off. */
  page365SyncDisabled: boolean;
  collectionIds: string[];
  /** website_category_products, in the order picked. */
  categoryIds: string[];
  variants: VariantRow[];
}

export const emptyVariant = (sort: number): VariantRow => ({
  size: "", stone: "", price_jpy: 0, cost_basis: null, stock_qty: 0, sort, media: [],
});

export const emptyProduct = (): ProductForm => ({
  sku: "", slug: "", name: "", name_ja: "", savedName: "", metals: ["K18"], weight_g: null, condition: "New",
  origin: "UNKNOWN", brand: "",
  description_en: "", description_ja: "", savedEn: "",
  status: "draft", page365SyncDisabled: false, collectionIds: [], categoryIds: [], variants: [emptyVariant(0)],
});

export const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const yen = (n: number) => `¥ ${Math.round(n).toLocaleString("en-US")}`;
