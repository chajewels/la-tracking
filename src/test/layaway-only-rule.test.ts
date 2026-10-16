import { describe, expect, it } from "vitest";
import { LAYAWAY_ONLY_JA_HINT, jaTextMentionsLayaway } from "@/lib/layaway-only-rule";

describe("jaTextMentionsLayaway", () => {
  it("ignores an English-only mention", () => {
    expect(jaTextMentionsLayaway({ title_ja: "新作ジュエリー", body_ja: "ご覧ください" })).toBe(false);
    // English fields are not part of the input at all — the rule never reads them.
    expect(jaTextMentionsLayaway({ question_ja: "", answer_ja: null })).toBe(false);
  });

  it("catches レイアウェイ in body_ja", () => {
    expect(jaTextMentionsLayaway({ title_ja: "お知らせ", body_ja: "レイアウェイのご案内" })).toBe(true);
  });

  it("catches 分割予約 in answer_ja", () => {
    expect(jaTextMentionsLayaway({ question_ja: "支払い方法", answer_ja: "分割予約もご利用いただけます" })).toBe(true);
  });

  it("catches layaway case-insensitively in Japanese fields", () => {
    expect(jaTextMentionsLayaway({ excerpt_ja: "LAYAWAY プラン" })).toBe(true);
  });

  it("is false for empty Japanese text", () => {
    expect(jaTextMentionsLayaway({})).toBe(false);
    expect(jaTextMentionsLayaway({ title_ja: "", excerpt_ja: "", body_ja: "" })).toBe(false);
  });

  it("the hint is a hint, not a lock (owner 2026-10-16 17:34 JST)", () => {
    expect(LAYAWAY_ONLY_JA_HINT).not.toContain("English-site only");
    expect(LAYAWAY_ONLY_JA_HINT).toContain("if this switch is off");
  });
});
