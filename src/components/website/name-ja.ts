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

/** The outcome the bulk pass reports. `skipped` = already had a Japanese name (or none to translate). */
export interface BulkNameOutcome { filled: number; failed: string[]; skipped: number }

export function bulkNameSummary(total: number, o: BulkNameOutcome): { title: string; description?: string; failed: boolean } {
  const base = `Japanese names filled: ${o.filled}. Skipped: ${o.skipped}. Failed: ${o.failed.length}.`;
  return o.failed.length
    ? { title: base, description: o.failed.join(" · "), failed: true }
    : { title: base, description: total ? undefined : "Nothing to fill.", failed: false };
}

/** PostgREST filter matching a Japanese name that is still empty (null or ""). */
export const NAME_JA_EMPTY = "name_ja.is.null,name_ja.eq.";
