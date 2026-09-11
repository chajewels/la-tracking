/**
 * Website Catalog spreadsheet importer — parsing, mapping and validation.
 *
 * Pure logic, no Supabase calls, so the row rules are unit-testable. The
 * writes live in ProductImportDialog and reuse the same sequence the edit
 * modal uses.
 *
 * Source sheet: cha-jewels-product-upload-template.xlsx, sheet `Upload`.
 * Columns A–X are the Page365 export; Y–AF are the hub_* columns. Row 1 is the
 * header, rows 2–4 are guidance (required/optional, help text, Hub field map)
 * and are skipped — data starts at row 5.
 */

export const SHEET_NAME = "Upload";
/** 1-based worksheet row where data begins. Rows 2-4 are guidance text. */
export const DATA_START_ROW = 5;

export const METAL_VALUES = [
  "K18", "K14", "K10", "PT1000", "PT950", "PT900", "SILVER925",
] as const;
export type MetalValue = (typeof METAL_VALUES)[number];

export const CONDITION_VALUES = ["New", "Preloved"] as const;
export type ConditionValue = (typeof CONDITION_VALUES)[number];

/**
 * Origin is DATA, never an assumption. The storefront claims an origin only
 * when this says JAPAN, shows a brand name (and no origin) when it says BRAND,
 * and says nothing for OTHER or UNKNOWN. Nothing here or downstream guesses an
 * origin from the metal, the name or the description.
 */
export const ORIGIN_VALUES = ["JAPAN", "BRAND", "OTHER", "UNKNOWN"] as const;
export type OriginValue = (typeof ORIGIN_VALUES)[number];

/** What each origin is called in the Hub UI and the upload template. */
export const ORIGIN_LABELS: Record<OriginValue, string> = {
  JAPAN: "Made in Japan",
  BRAND: "Branded",
  OTHER: "Other",
  UNKNOWN: "Unknown",
};

/**
 * Accepts the template's dropdown labels, the enum values, and the obvious
 * shorthands, case-insensitively. Returns null for anything else so the row
 * errors instead of silently landing on UNKNOWN with a typo in the sheet.
 */
export function parseOrigin(raw: string): OriginValue | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return "UNKNOWN";
  if (["japan", "made in japan", "jp", "日本製"].includes(v)) return "JAPAN";
  if (["brand", "branded"].includes(v)) return "BRAND";
  if (v === "other") return "OTHER";
  if (v === "unknown") return "UNKNOWN";
  return null;
}

export type ProductStatus = "draft" | "active" | "archived";

/**
 * Mirrors the reject_forbidden_gold_terms() DB trigger. Slightly wider than the
 * SQL (\s+ vs a single space) so "Japan  gold" is caught here rather than
 * surfacing as an opaque 500 from Postgres. The DB remains authoritative.
 */
const FORBIDDEN_GOLD = /\b(japan(?:ese)?|saudi|italian|dubai|hk|chinese)\s+gold\b/i;

export function hasForbiddenGoldTerm(...parts: (string | null | undefined)[]): boolean {
  return FORBIDDEN_GOLD.test(parts.filter(Boolean).join(" "));
}

export interface CollectionOption { id: string; name: string; slug: string }

export interface ImportRowInput {
  /** 1-based worksheet row, for error messages that match what the user sees. */
  sheetRow: number;
  buy_code: string;
  product_name: string;
  product_description: string;
  price: string;
  cost: string;
  stock_amount: string;
  hub_jewelry_type: string;
  hub_metal: string;
  hub_weight_g: string;
  hub_stone: string;
  hub_size: string;
  hub_condition: string;
  hub_status: string;
  /** Optional in the sheet; blank means UNKNOWN. */
  hub_origin: string;
  /** Required only when hub_origin is Branded. */
  hub_brand: string;
  images: string[];
}

export interface ImportRow {
  sheetRow: number;
  sku: string;
  name: string;
  errors: string[];
  /** Present only when errors is empty. */
  value?: {
    sku: string;
    name: string;
    slug: string;
    collectionId: string;
    karat: MetalValue;
    weight_g: number;
    description_en: string;
    condition: ConditionValue;
    origin: OriginValue;
    brand: string | null;
    status: ProductStatus;
    size: string | null;
    stone: string | null;
    price_jpy: number;
    cost_basis: number | null;
    stock_qty: number;
    /** Empty means "leave the product's existing photos alone". */
    images: string[];
  };
}

export const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The template's jewelry_type list is singular (Ring, Necklace, Anklet) while
 * the Hub's collections are plural (Rings, Necklaces, Anklets). Match on name,
 * then slug, then a naive singular/plural fold so "Ring" finds "Rings" without
 * anyone having to retype the sheet. Earrings/Sets already agree.
 */
export function resolveCollection(
  raw: string,
  collections: CollectionOption[],
): CollectionOption | null {
  const wanted = raw.trim().toLowerCase();
  if (!wanted) return null;

  const variants = new Set<string>([wanted]);
  if (wanted.endsWith("s")) variants.add(wanted.slice(0, -1));
  else variants.add(`${wanted}s`);

  for (const v of variants) {
    const hit = collections.find(
      (c) => c.name.trim().toLowerCase() === v || c.slug.trim().toLowerCase() === v,
    );
    if (hit) return hit;
  }
  return null;
}

/** Accepts "628980", "628,980", " 628980 " and Excel's numeric cells. */
function toNumber(raw: string): number | null {
  const cleaned = String(raw ?? "").replace(/[,\s¥￥]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface ValidateContext {
  collections: CollectionOption[];
  /** cost is only written by admins; a non-admin's cost column is dropped. */
  isAdmin: boolean;
  /** SKUs already in the catalog, uppercased — decides Create vs Update. */
  existingSkus: Set<string>;
}

/** A row is blank when buy_code is empty — every template formula keys off it. */
export function isBlankRow(r: ImportRowInput): boolean {
  return !r.buy_code.trim();
}

export function validateRow(r: ImportRowInput, ctx: ValidateContext): ImportRow {
  const errors: string[] = [];
  const sku = r.buy_code.trim().toUpperCase();
  const name = r.product_name.trim();

  if (!sku) errors.push("buy_code is required");

  if (!name) {
    errors.push(
      "product_name is empty — open the file in Excel or Google Sheets so the name formula calculates, then save and re-upload",
    );
  } else if (name.length > 80) {
    errors.push(`product_name is ${name.length} characters (max 80)`);
  }

  const collection = resolveCollection(r.hub_jewelry_type, ctx.collections);
  if (!r.hub_jewelry_type.trim()) {
    errors.push("hub_jewelry_type is required");
  } else if (!collection) {
    errors.push(
      `hub_jewelry_type "${r.hub_jewelry_type.trim()}" is not a jewelry type in the Hub`,
    );
  }

  const metalRaw = r.hub_metal.trim().toUpperCase();
  const karat = METAL_VALUES.find((m) => m === metalRaw);
  if (!metalRaw) errors.push("hub_metal is required");
  else if (!karat) {
    errors.push(`hub_metal "${r.hub_metal.trim()}" is not one of ${METAL_VALUES.join(", ")}`);
  }

  const weight = toNumber(r.hub_weight_g);
  if (!r.hub_weight_g.trim()) errors.push("hub_weight_g is required");
  else if (weight === null || weight <= 0) errors.push("hub_weight_g must be a number greater than 0");

  const description = r.product_description.trim();
  if (!description) errors.push("product_description is required");
  else if (hasForbiddenGoldTerm(name, description)) {
    errors.push('Forbidden gold terminology — describe purity as "K18 gold", never "<country> gold"');
  }

  const conditionRaw = r.hub_condition.trim().toLowerCase();
  const condition = CONDITION_VALUES.find((c) => c.toLowerCase() === conditionRaw);
  if (!conditionRaw) errors.push("hub_condition is required");
  else if (!condition) errors.push(`hub_condition must be New or Preloved (got "${r.hub_condition.trim()}")`);

  const origin = parseOrigin(r.hub_origin);
  if (origin === null) {
    errors.push(
      `hub_origin must be Made in Japan, Branded, Other or Unknown (got "${r.hub_origin.trim()}")`,
    );
  }
  const brand = r.hub_brand.trim() || null;
  if (origin === "BRAND" && !brand) {
    errors.push("hub_brand is required when hub_origin is Branded");
  }

  const statusRaw = r.hub_status.trim().toLowerCase();
  const statusMap: Record<string, ProductStatus> = { active: "active", draft: "draft" };
  const status = statusMap[statusRaw];
  if (!statusRaw) errors.push("hub_status is required");
  else if (!status) errors.push(`hub_status must be Active or Draft (got "${r.hub_status.trim()}")`);

  const price = toNumber(r.price);
  if (!r.price.trim()) errors.push("price is required");
  else if (price === null || price < 0 || !Number.isInteger(price)) {
    errors.push("price must be a whole number of yen");
  }

  const costRaw = r.cost.trim();
  let cost: number | null = null;
  if (costRaw) {
    const parsed = toNumber(costRaw);
    if (parsed === null || parsed < 0 || !Number.isInteger(parsed)) {
      errors.push("cost must be a whole number of yen");
    } else if (ctx.isAdmin) {
      cost = parsed;
    }
    // Non-admins: the value parses but is dropped, never written.
  }

  const stockRaw = r.stock_amount.trim();
  let stock = 1;
  if (stockRaw) {
    const parsed = toNumber(stockRaw);
    if (parsed === null || parsed < 0 || !Number.isInteger(parsed)) {
      errors.push("stock_amount must be a whole number");
    } else {
      stock = parsed;
    }
  }

  const images: string[] = [];
  r.images.forEach((raw, i) => {
    const u = String(raw ?? "").trim();
    if (!u) return;
    if (!isHttpUrl(u)) errors.push(`image_${i + 1} must be an http(s) URL`);
    else images.push(u);
  });

  const out: ImportRow = { sheetRow: r.sheetRow, sku, name, errors };
  if (!errors.length) {
    out.value = {
      sku,
      name,
      slug: slugify(name),
      collectionId: collection!.id,
      karat: karat!,
      weight_g: weight!,
      description_en: description,
      condition: condition!,
      origin: origin!,
      brand,
      status: status!,
      size: r.hub_size.trim() || null,
      stone: r.hub_stone.trim() || null,
      price_jpy: price!,
      cost_basis: cost,
      stock_qty: stock,
      images,
    };
  }
  return out;
}

export function rowAction(row: ImportRow, existingSkus: Set<string>): "create" | "update" {
  return existingSkus.has(row.sku) ? "update" : "create";
}
