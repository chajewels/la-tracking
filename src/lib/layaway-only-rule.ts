/**
 * The "Layaway only" rule for website Posts and FAQ questions (owner decision 2026-10-16).
 *
 * A row whose JAPANESE text mentions layaway is forced to layaway_only = true (English site
 * only) by the database trigger function public.force_layaway_english_only(). English text
 * never forces it: the Japanese site never renders English. Keep these three patterns in
 * step with supabase/migrations/20261220100000_layaway_only_ja_text.sql.
 */
export interface LayawayOnlyJaFields {
  title_ja?: string | null;
  excerpt_ja?: string | null;
  body_ja?: string | null;
  question_ja?: string | null;
  answer_ja?: string | null;
}

export function jaTextMentionsLayaway(fields: LayawayOnlyJaFields): boolean {
  const t = [fields.question_ja, fields.answer_ja, fields.title_ja, fields.excerpt_ja, fields.body_ja]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");
  return /layaway/i.test(t) || t.includes("レイアウェイ") || t.includes("分割予約");
}

/** Shown under the locked switch on Website → Content (Posts and FAQ). */
export const LAYAWAY_ONLY_LOCKED_NOTE =
  "The Japanese text mentions layaway, so this is English-site only (owner rule 2026-09-25). Trim the Japanese text to change it.";
