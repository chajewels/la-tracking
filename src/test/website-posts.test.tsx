import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  POST_SLUG_MAX, emptyPost, isSlugTaken, postSlug, toDraft, toPayload, validatePost,
  type PostDraft, type PostRow,
} from "@/components/website/website-posts";
import { Markdown } from "@/components/website/markdown";

/**
 * Two things in the posts editor fail SILENTLY if they are wrong.
 *
 * The slug becomes a public URL on a NOT NULL UNIQUE column — a rule that can
 * emit "" or a duplicate does not error, it saves a broken address. And the
 * markdown preview is the only thing telling a writer their list is a list
 * before they publish; a renderer that drops a node shows them prose.
 */

const draft = (over: Partial<PostDraft> = {}): PostDraft => ({ ...emptyPost(), ...over });

describe("postSlug", () => {
  it("makes a web address out of an ordinary title", () => {
    expect(postSlug("How to care for pearl jewelry")).toBe("how-to-care-for-pearl-jewelry");
  });

  it("keeps an apostrophe inside the word instead of splitting it", () => {
    expect(postSlug("Japan's finest")).toBe("japans-finest");
    expect(postSlug("Japan’s finest")).toBe("japans-finest");
  });

  it("folds accents rather than dropping the letter", () => {
    expect(postSlug("Café de Paris")).toBe("cafe-de-paris");
  });

  it("collapses punctuation and never leaves a leading or trailing hyphen", () => {
    expect(postSlug("  --- Gold & Pearls: a guide!  ")).toBe("gold-pearls-a-guide");
  });

  it("is idempotent — running it on its own output changes nothing", () => {
    const once = postSlug("K18 / PT900: what the stamps mean");
    expect(postSlug(once)).toBe(once);
  });

  it("caps length without cutting a word in half", () => {
    const long = "the complete and exhaustive guide to caring for fine pearl and diamond jewelry at home";
    const s = postSlug(long);
    expect(s.length).toBeLessThanOrEqual(POST_SLUG_MAX);
    expect(s.endsWith("-")).toBe(false);
    // the cut landed on a word boundary, so the last segment is a whole word
    expect(long).toContain(s.split("-").pop()!);
  });

  it("returns \"\" when there is nothing slug-able, so validation can catch it", () => {
    expect(postSlug("日本語のタイトル")).toBe("");
    expect(postSlug("!!!")).toBe("");
  });
});

describe("slug uniqueness", () => {
  const rows = [{ id: "a", slug: "pearl-care" }, { id: "b", slug: "news-2026" }];

  it("sees another post's slug as taken", () => {
    expect(isSlugTaken("pearl-care", undefined, rows)).toBe(true);
  });

  it("does not see a post's own slug as taken when editing it", () => {
    expect(isSlugTaken("pearl-care", "a", rows)).toBe(false);
  });

  it("reports the clash through validatePost", () => {
    const errs = validatePost(draft({ title_en: "T", body_en: "B", slug: "pearl-care" }), rows);
    expect(errs.some((e) => e.includes("already uses the slug"))).toBe(true);
  });
});

describe("validatePost", () => {
  const ok = draft({ title_en: "Pearl care", body_en: "Body", slug: "pearl-care" });

  it("passes a complete draft", () => {
    expect(validatePost(ok, [])).toEqual([]);
  });

  it("requires the English title, body and slug", () => {
    expect(validatePost(draft(), []).length).toBe(3);
  });

  it("refuses a slug that is not already slug-shaped", () => {
    const errs = validatePost({ ...ok, slug: "Pearl Care" }, []);
    expect(errs.some((e) => e.includes("lowercase"))).toBe(true);
  });

  it("requires a date on a published post but not on a draft", () => {
    expect(validatePost({ ...ok, published: false, published_at: "" }, [])).toEqual([]);
    expect(validatePost({ ...ok, published: true, published_at: "" }, []))
      .toEqual(["A published post needs a date."]);
  });
});

describe("toPayload", () => {
  const ok = draft({ title_en: " Pearl care ", body_en: " Body ", slug: "pearl-care" });

  it("trims required text and sends empty optional text as null, not \"\"", () => {
    const p = toPayload(ok, "user-1");
    expect(p.title_en).toBe("Pearl care");
    expect(p.body_en).toBe("Body");
    expect(p.title_ja).toBeNull();
    expect(p.excerpt_en).toBeNull();
    // published_at is a date column — "" would be rejected outright.
    expect(p.published_at).toBeNull();
    expect(p.updated_by).toBe("user-1");
  });

  it("omits id when creating and carries it when editing", () => {
    expect("id" in toPayload(ok, null)).toBe(false);
    expect(toPayload({ ...ok, id: "abc" }, null).id).toBe("abc");
  });
});

describe("toDraft", () => {
  it("turns every nullable column into a string so no input goes uncontrolled", () => {
    const row: PostRow = {
      id: "1", slug: "s", type: null, title_en: "T", title_ja: null,
      excerpt_en: null, excerpt_ja: null, body_en: "B", body_ja: null,
      cover_media: null, published: null, published_at: null, layaway_only: null, updated_at: null,
    };
    const d = toDraft(row);
    for (const k of ["title_ja", "excerpt_en", "excerpt_ja", "body_ja", "published_at"] as const) {
      expect(typeof d[k], k).toBe("string");
    }
    expect(d.type).toBe("article");      // null falls back, never renders blank
    expect(d.published).toBe(false);
    expect(d.layaway_only).toBe(false);
  });
});

describe("the markdown preview", () => {
  it("renders headings, lists and emphasis as elements, not as text", () => {
    render(<Markdown>{"# Title\n\n- one\n- two\n\n**bold**"}</Markdown>);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("opens links in a new tab with noopener — a preview must not navigate away from an unsaved draft", () => {
    render(<Markdown>{"[shop](https://chajewelsjp.com)"}</Markdown>);
    const link = screen.getByRole("link", { name: "shop" });
    expect(link).toHaveAttribute("href", "https://chajewelsjp.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("says so rather than rendering an empty box when there is nothing to preview", () => {
    render(<Markdown>{"   "}</Markdown>);
    expect(screen.getByText(/nothing to preview/i)).toBeInTheDocument();
  });
});
