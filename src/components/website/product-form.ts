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
  sku: "", slug: "", name: "", name_ja: "", savedName: "", itemKind: "jewelry", metals: ["K18"], weight_g: null, condition: "New",
  origin: "UNKNOWN", brand: "",
  description_en: "", description_ja: "", savedEn: "",
  status: "draft", page365SyncDisabled: false, collectionIds: [], categoryIds: [], variants: [emptyVariant(0)],
});

export const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const yen = (n: number) => `¥ ${Math.round(n).toLocaleString("en-US")}`;
