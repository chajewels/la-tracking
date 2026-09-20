import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import type { TranslateFn } from "@/lib/website-catalog-import";

/**
 * Formal-retail Japanese from Lovable AI. Server-side — the key never ships.
 * Name and description are translated independently by the edge function;
 * pass only the fields that need refreshing. A field left out comes back "".
 *
 * Shared by the product editor, the importer, the jewelry-types editor, the
 * categories editor and the testimonials editor.
 */
export const translateJa: TranslateFn = async (fields) => {
  const name = fields.name?.trim() ?? "";
  const description = fields.description?.trim() ?? "";
  if (!name && !description) return { name_ja: "", description_ja: "" };
  const { data, error } = await supabase.functions.invoke("translate-product-description", {
    body: { name: name || undefined, description: description || undefined },
  });
  if (error) {
    // invoke() reports a bare "non-2xx status" — the useful message (rate limit,
    // credits exhausted, banned terminology) is in the response body.
    const res = (error as { context?: Response }).context;
    const detail = res ? await res.json().catch(() => null) : null;
    throw new Error(detail?.error ?? error.message);
  }
  const body = (data ?? {}) as { name_ja?: unknown; description_ja?: unknown; error?: unknown };
  const out = {
    name_ja: String(body.name_ja ?? "").trim(),
    description_ja: String(body.description_ja ?? "").trim(),
  };
  if ((name && !out.name_ja) || (description && !out.description_ja)) {
    throw new Error(typeof body.error === "string" ? body.error : "Translation came back empty.");
  }
  return out;
};

export type JaPatch = Partial<{ name_ja: string | null; description_ja: string | null }>;

/**
 * Translation failures never block the English save — the row still lands and
 * Regenerate retries. Returns only the fields that were asked for.
 */
export async function japaneseFor(fields: { name?: string; description?: string }): Promise<JaPatch> {
  try {
    const out = await translateJa(fields);
    const patch: JaPatch = {};
    if (fields.name !== undefined) patch.name_ja = out.name_ja || null;
    if (fields.description !== undefined) patch.description_ja = out.description_ja || null;
    return patch;
  } catch (e) {
    toast({
      title: "Japanese not regenerated",
      description: `${(e as Error).message} The English still saved — use Regenerate to retry.`,
      variant: "destructive",
    });
    return {};
  }
}
