import { type FillClient, type FillOutcome, fillMissingJapanese, isMissingJa, japaneseNameMayBeOutdated } from "@/components/website/name-ja";

/**
 * The spreadsheet importer's Japanese rules (owner 2026-10-30), kept apart from
 * the dialog so they can be exercised without a spreadsheet.
 *
 * On an EXISTING product the update payload never carries name_ja or
 * description_ja: an import cannot rewrite or clear Japanese text, whatever the
 * sheet's English says. A Japanese value that is MISSING (null, empty or
 * whitespace-only) is filled afterwards by a guarded write that lands only
 * while it is still missing and the English text is still what was translated.
 * A NEW product simply receives what was generated.
 */

export interface ExistingJa { name?: string | null; name_ja?: string | null; description_ja?: string | null }

/**
 * An import changed an existing product's English name but, by rule, kept its
 * Japanese name (owner 2026-10-31). The import summary lists these so staff
 * regenerate the Japanese name in the editor. A new product is never listed.
 */
export function importKeptOutdatedJapaneseName(existing: ExistingJa | null, v: ImportSource): boolean {
  if (!existing) return false;
  return japaneseNameMayBeOutdated({ name: v.name, nameJa: existing.name_ja, wasName: existing.name, wasJa: existing.name_ja });
}
export interface ImportSource { name: string; description_en: string }
export interface ImportPlan { genName: string; genDesc: string }
export type ImportTranslate = (a: { name?: string; description?: string }) => Promise<{ name_ja: string; description_ja: string }>;

/** What needs translating, and the translation (none when `translate` is null = checkbox off). */
export async function planImportJapanese(
  existing: ExistingJa | null, v: ImportSource, translate: ImportTranslate | null,
): Promise<ImportPlan> {
  const needName = isMissingJa(existing?.name_ja);
  const needDesc = !!v.description_en && isMissingJa(existing?.description_ja);
  const plan: ImportPlan = { genName: "", genDesc: "" };
  if (!translate || (!needName && !needDesc)) return plan;
  const out = await translate({
    name: needName ? v.name : undefined,
    description: needDesc ? v.description_en : undefined,
  });
  if (needName) plan.genName = (out.name_ja ?? "").trim();
  if (needDesc) plan.genDesc = (out.description_ja ?? "").trim();
  return plan;
}

/** Japanese columns for the payload: only a NEW product carries any. */
export function importJapanesePayload(
  existing: ExistingJa | null, plan: ImportPlan,
): { name_ja?: string | null; description_ja?: string | null } {
  return existing ? {} : { name_ja: plan.genName || null, description_ja: plan.genDesc || null };
}

export interface ImportFillResult { column: "name_ja" | "description_ja"; outcome: FillOutcome | "database_error" }

/** After the update of an existing product: fill what was missing, guarded. Never throws. */
export async function fillImportedJapanese(
  client: FillClient, id: string, existing: ExistingJa, v: ImportSource, plan: ImportPlan,
): Promise<ImportFillResult[]> {
  const out: ImportFillResult[] = [];
  const jobs = [
    { column: "name_ja", source: v.name, text: plan.genName, observed: existing.name_ja },
    { column: "description_ja", source: v.description_en, text: plan.genDesc, observed: existing.description_ja },
  ] as const;
  for (const j of jobs) {
    if (!j.text) continue;
    try {
      const outcome = await fillMissingJapanese(client, { id, column: j.column, source: j.source, observed: j.observed, text: j.text });
      if (outcome !== "filled") out.push({ column: j.column, outcome });
    } catch {
      out.push({ column: j.column, outcome: "database_error" });
    }
  }
  return out;
}
