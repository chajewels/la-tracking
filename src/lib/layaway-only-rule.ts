/**
 * "Layaway only" hint for website Posts and FAQ questions — a HINT, never a lock.
 *
 * layaway_only is a plain manual switch (owner decision 2026-10-16 17:34 JST): nothing in the
 * database forces it any more (migration 20261221100000_layaway_only_manual.sql dropped the
 * trigger). When the Japanese text mentions layaway, the Hub shows one grey line under the
 * switch so the owner knows the row will reach the Japanese site if the switch is off. The
 * three patterns are the ones the dropped trigger used: 'layaway' (any case), レイアウェイ,
 * 分割予約. English text is not read: the Japanese site never renders it.
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

/** Shown under the switch on Website → Content (Posts and FAQ) when the hint applies. */
export const LAYAWAY_ONLY_JA_HINT =
  "Japanese text mentions layaway — if this switch is off, it appears on the Japanese site.";
