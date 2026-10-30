import type { ProductForm } from "@/components/website/product-form";

/**
 * Product descriptions, English and Japanese, edited independently (owner
 * 2026-10-30). The Japanese description is staff-owned text: nothing here, and
 * nothing in Save, replaces non-empty Japanese on its own. Translation is a
 * deliberate button press, and a product NAME is never touched by it.
 */

const norm = (s: string | null | undefined) => (s ?? "").trim();

export interface DescriptionWrite {
  description_en?: string | null;
  description_ja?: string | null;
}

/**
 * The description columns this Save writes.
 * - New product: both, as typed.
 * - Existing product: only the column that differs from what the editor opened
 *   with. An unrelated edit therefore never rewrites a description, and a stale
 *   form cannot overwrite text changed elsewhere (importer, another tab).
 * Clearing the English no longer clears the Japanese: they are independent.
 */
export function descriptionWrites(f: Pick<ProductForm, "id" | "description_en" | "description_ja" | "loaded">): DescriptionWrite {
  const en = norm(f.description_en);
  const ja = norm(f.description_ja);
  const was = f.id ? f.loaded : null;
  const out: DescriptionWrite = {};
  if (!was || en !== was.description_en) out.description_en = en || null;
  if (!was || ja !== was.description_ja) out.description_ja = ja || null;
  return out;
}

/**
 * Save may fill the Japanese description only for a NEW product that has
 * English and no Japanese yet. An existing product is translated only by the
 * explicit button.
 */
export function needsDescriptionTranslation(f: Pick<ProductForm, "id" | "description_en" | "description_ja">): boolean {
  return !f.id && !!norm(f.description_en) && !norm(f.description_ja);
}

/** What the form looked like when a translation was requested. */
export interface TranslationAsk {
  /** Bumped each time the editor is opened; a reopened editor is a different session. */
  session: number;
  id?: string;
  en: string;
  ja: string;
}

/**
 * Put a finished translation into the form, or return null to discard it.
 * It is discarded when anything changed while it was in flight — another
 * product opened, the editor reopened, the English edited, or the Japanese
 * typed — so a slow response never overwrites newer manual text.
 */
export function applyTranslatedDescription(
  f: ProductForm, ask: TranslationAsk, currentSession: number, text: string,
): ProductForm | null {
  const ja = text.trim();
  if (!ja) return null;
  if (ask.session !== currentSession || f.id !== ask.id) return null;
  if (norm(f.description_en) !== ask.en) return null;
  if (f.description_ja !== ask.ja) return null;
  return { ...f, description_ja: ja, jaSourceEn: ask.en };
}

/** Existing Japanese would be replaced: the editor asks first. */
export const translationNeedsConfirm = (f: Pick<ProductForm, "description_ja">) => !!norm(f.description_ja);
