import type { ProductForm } from "@/components/website/product-form";

/**
 * The Japanese product NAME (owner 2026-10-30). A name in Japanese that exists
 * is staff-owned: nothing automatic ever replaces it. Three paths touch it, and
 * only the middle one may replace a non-empty value:
 *   1. Save fills a MISSING Japanese name (new or existing product).
 *   2. "Regenerate Japanese name" — one product, explicit, confirmed, unsaved
 *      until staff press Save.
 *   3. The bulk pass fills missing names only.
 * The English name, SKU and slug are never written from here, and a
 * description is never touched by a name operation.
 */

const norm = (s: string | null | undefined) => (s ?? "").trim();

/** Save generates the Japanese name only when there is an English name and no Japanese one. */
export function needsNameTranslation(f: Pick<ProductForm, "name" | "name_ja">): boolean {
  return !!norm(f.name) && !norm(f.name_ja);
}

/** Existing Japanese would be replaced: the editor asks first. */
export const nameRegenerationNeedsConfirm = (f: Pick<ProductForm, "name_ja">) => !!norm(f.name_ja);

/** What the form looked like when a name regeneration was requested. */
export interface NameAsk {
  /** Bumped each time the editor is opened; a reopened editor is a different session. */
  session: number;
  id?: string;
  name: string;
  nameJa: string;
}

/**
 * Put a finished Japanese name into the form, or return null to discard it.
 * Discarded when anything changed while it was in flight — another product
 * opened, the editor reopened, the English name edited, or the Japanese name
 * changed — so a slow response never lands on newer text. Only `name_ja` is
 * written; every other field, saved or unsaved, is returned as it was.
 */
export function applyRegeneratedName(
  f: ProductForm, ask: NameAsk, currentSession: number, text: string,
): ProductForm | null {
  const ja = text.trim();
  if (!ja) return null;
  if (ask.session !== currentSession || f.id !== ask.id) return null;
  if (norm(f.name) !== ask.name) return null;
  if (f.name_ja !== ask.nameJa) return null;
  return { ...f, name_ja: ja };
}

/** A row of the product list, as far as the bulk pass needs it. */
export interface NameRow { id: string; sku?: string | null; name?: string | null; name_ja?: string | null }

/** Products the bulk pass may fill: an English name and NO Japanese name. */
export function missingNameTargets<T extends NameRow>(rows: readonly T[]): T[] {
  return rows.filter((p) => !!norm(p.name) && !norm(p.name_ja));
}

/** Sorts every product the bulk pass sees: a target, or the reason it is not one. */
export function classifyNameRows<T extends NameRow>(rows: readonly T[]) {
  const targets: T[] = [];
  let hadJapanese = 0;
  let noEnglish = 0;
  for (const p of rows) {
    if (!isMissingJa(p.name_ja)) hadJapanese += 1;
    else if (!norm(p.name)) noEnglish += 1;
    else targets.push(p);
  }
  return { targets, hadJapanese, noEnglish };
}

/**
 * What the bulk pass reports. Every product it saw lands in exactly one bucket,
 * so the buckets add up to `total`:
 * - filled
 * - hadJapanese: had a Japanese name when the pass started, or got one meanwhile
 * - noEnglish: nothing to translate (no English name)
 * - englishChanged: the English name changed while it was translating
 * - gone: the product was removed meanwhile
 * - notEligible: changed in a way that matched neither reason (nothing written)
 * - translationFailed / databaseFailed: named per product
 */
export interface BulkNameOutcome {
  filled: number;
  hadJapanese: number;
  noEnglish: number;
  englishChanged: number;
  gone: number;
  notEligible: number;
  translationFailed: string[];
  databaseFailed: string[];
}

export const bulkNameAccounted = (o: BulkNameOutcome) =>
  o.filled + o.hadJapanese + o.noEnglish + o.englishChanged + o.gone + o.notEligible
  + o.translationFailed.length + o.databaseFailed.length;

export function bulkNameSummary(total: number, o: BulkNameOutcome): { title: string; description?: string; failed: boolean } {
  const failedN = o.translationFailed.length + o.databaseFailed.length;
  const base = `Japanese names filled: ${o.filled} of ${total} products. Already had one: ${o.hadJapanese}. `
    + `No English name: ${o.noEnglish}. English changed meanwhile: ${o.englishChanged}. `
    + `Product removed: ${o.gone}. Not eligible: ${o.notEligible}. `
    + `Translation failed: ${o.translationFailed.length}. Database failed: ${o.databaseFailed.length}.`;
  return failedN
    ? { title: base, description: [...o.translationFailed, ...o.databaseFailed].join(" · "), failed: true }
    : { title: base, description: total ? undefined : "Nothing to fill.", failed: false };
}

/** A Japanese value counts as missing when it is null, empty or only whitespace. */
export const isMissingJa = (v: string | null | undefined) => !norm(v);

export type JaColumn = "name_ja" | "description_ja";
const SOURCE_COLUMN: Record<JaColumn, "name" | "description_en"> = {
  name_ja: "name",
  description_ja: "description_en",
};

/**
 * PostgREST `or` filter for a Japanese column that is still missing. PostgREST
 * cannot trim, so null and "" are matched structurally and a whitespace-only
 * value only when it is exactly the one this write SAW (`observed`): the
 * application and the database agree on "missing" without the database ever
 * matching a different whitespace value someone typed since.
 */
export function jaMissingFilter(column: JaColumn, observed?: string | null): string {
  const base = `${column}.is.null,${column}.eq.`;
  const seen = observed ?? "";
  if (seen !== "" && !norm(seen)) {
    return `${base},${column}.eq."${seen.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return base;
}

/** PostgREST filter matching a Japanese name that is still empty (null or ""). */
export const NAME_JA_EMPTY = jaMissingFilter("name_ja");

/** The slice of the Supabase client the guarded fill needs (mockable in tests). */
interface FillResult<T> { data: T | null; error: { message: string } | null }
export interface FillFilter {
  eq(column: string, value: string): FillFilter;
  or(filter: string): FillFilter;
  select(columns: string): PromiseLike<FillResult<{ id: string }[]>> & FillFilter;
  maybeSingle(): PromiseLike<FillResult<Record<string, string | null> | null>>;
}
export interface FillClient {
  from(table: "website_products"): {
    update(values: Record<string, unknown>): FillFilter;
    select(columns: string): FillFilter;
  };
}

/**
 * Why a generated Japanese value was or was not written.
 * - filled: the row was updated.
 * - has_value: another Japanese value exists now (nothing replaced).
 * - source_changed: the English text it was translated from changed meanwhile.
 * - gone: the product no longer exists.
 * - not_eligible: the row matched neither reason (e.g. a different whitespace value).
 */
export type FillOutcome = "filled" | "has_value" | "source_changed" | "gone" | "not_eligible";

/**
 * Write a generated Japanese value ONLY while the column is still missing AND
 * the English text it was translated from is still the stored text. A database
 * error throws; a zero-row result is classified by re-reading the product, so
 * "nothing updated" is never reported as success.
 */
export async function fillMissingJapanese(
  client: FillClient,
  a: { id: string; column: JaColumn; source: string; observed?: string | null; text: string },
): Promise<FillOutcome> {
  const srcCol = SOURCE_COLUMN[a.column];
  const { data, error } = await client.from("website_products")
    .update({ [a.column]: a.text })
    .eq("id", a.id)
    .eq(srcCol, a.source)
    .or(jaMissingFilter(a.column, a.observed))
    .select("id");
  if (error) throw new Error(error.message);
  if (data?.length) return "filled";
  const { data: row, error: readErr } = await client.from("website_products")
    .select(`${srcCol}, ${a.column}`).eq("id", a.id).maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (!row) return "gone";
  if (!isMissingJa(row[a.column])) return "has_value";
  if (row[srcCol] !== a.source) return "source_changed";
  return "not_eligible";
}

/** Customer-readable reason for a generated value that was not written. */
export function fillSkipReason(o: Exclude<FillOutcome, "filled">, what: string): string {
  switch (o) {
    case "has_value": return `${what} was filled in meanwhile, so the existing one was kept.`;
    case "source_changed": return `The English text changed while it was translating, so the ${what.toLowerCase()} was not written.`;
    case "gone": return `The product no longer exists, so the ${what.toLowerCase()} was not written.`;
    default: return `The ${what.toLowerCase()} could not be written because the product changed.`;
  }
}
