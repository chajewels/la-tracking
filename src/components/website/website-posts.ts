/**
 * Shape and rules for public.website_posts — the storefront's articles and news.
 *
 * Pure: nothing here touches Supabase, so the slug rule and the validation are
 * testable without a database (src/test/website-posts.test.ts).
 */

export const POST_TYPES = ["article", "news"] as const;
export type PostType = (typeof POST_TYPES)[number];

export const POST_TYPE_LABEL: Record<PostType, string> = {
  article: "Article",
  news: "News",
};

/** A row as the table stores it. */
export interface PostRow {
  id: string;
  slug: string;
  type: string | null;
  title_en: string;
  title_ja: string | null;
  excerpt_en: string | null;
  excerpt_ja: string | null;
  body_en: string;
  body_ja: string | null;
  cover_media: string | null;
  published: boolean | null;
  published_at: string | null;
  layaway_only: boolean | null;
  updated_at: string | null;
}

export const POST_SELECT =
  "id, slug, type, title_en, title_ja, excerpt_en, excerpt_ja, body_en, body_ja, " +
  "cover_media, published, published_at, layaway_only, updated_at";

/** The editor's form. Every field is a string or boolean — never null — so an
 *  input is never driven between controlled and uncontrolled. */
export interface PostDraft {
  id?: string;
  slug: string;
  type: PostType;
  title_en: string;
  title_ja: string;
  excerpt_en: string;
  excerpt_ja: string;
  body_en: string;
  body_ja: string;
  cover_media: string | null;
  published: boolean;
  published_at: string;
  layaway_only: boolean;
}

export const emptyPost = (): PostDraft => ({
  slug: "", type: "article", title_en: "", title_ja: "",
  excerpt_en: "", excerpt_ja: "", body_en: "", body_ja: "",
  cover_media: null, published: false, published_at: "", layaway_only: false,
});

const postType = (v: unknown): PostType =>
  (POST_TYPES as readonly string[]).includes(v as string) ? (v as PostType) : "article";

export const toDraft = (r: PostRow): PostDraft => ({
  id: r.id,
  slug: r.slug ?? "",
  type: postType(r.type),
  title_en: r.title_en ?? "",
  title_ja: r.title_ja ?? "",
  excerpt_en: r.excerpt_en ?? "",
  excerpt_ja: r.excerpt_ja ?? "",
  body_en: r.body_en ?? "",
  body_ja: r.body_ja ?? "",
  cover_media: r.cover_media,
  published: !!r.published,
  published_at: r.published_at ?? "",
  layaway_only: !!r.layaway_only,
});

/** Today as a PHT calendar date, the same clock the rest of the Hub reports in. */
export const todayPHT = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

/**
 * A slug from the English title.
 *
 * Deliberately NOT the catalog's `slugify` from product-form.ts: that one may
 * return "" (fine for a product, whose slug falls back to a generated one) and
 * does not truncate. `slug` here is NOT NULL UNIQUE and ends up in a public
 * URL, so this one is capped at 80 characters, never breaks a word in half at
 * the cap, and returns "" only for input with nothing slug-able in it — which
 * validatePost then reports rather than saving.
 */
export const POST_SLUG_MAX = 80;

export function postSlug(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // drop combining accents: "Café" -> "Cafe"
    .toLowerCase()
    .replace(/['’]/g, "")              // "Japan's" -> "japans", not "japan-s"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= POST_SLUG_MAX) return base;
  const cut = base.slice(0, POST_SLUG_MAX);
  const lastDash = cut.lastIndexOf("-");
  // Only fall back to a hard cut if trimming to the last word would gut it.
  return (lastDash > POST_SLUG_MAX / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
}

/**
 * Is this slug already another post's? The DB's UNIQUE index is the real
 * authority — this is the friendly version, so the writer is told before they
 * press Save rather than by a constraint error afterwards. The save path still
 * handles 23505, because two people can pass this check at the same moment.
 */
export function isSlugTaken(slug: string, id: string | undefined, rows: { id: string; slug: string }[]) {
  const s = slug.trim();
  return rows.some((r) => r.slug === s && r.id !== id);
}

export function validatePost(d: PostDraft, rows: { id: string; slug: string }[]): string[] {
  const errs: string[] = [];
  if (!d.title_en.trim()) errs.push("An English title is required.");
  if (!d.body_en.trim()) errs.push("English body text is required.");

  const slug = d.slug.trim();
  if (!slug) {
    errs.push("A slug is required — it is the post's address on the website.");
  } else if (slug !== postSlug(slug)) {
    errs.push("The slug may use lowercase letters, numbers and hyphens only.");
  } else if (isSlugTaken(slug, d.id, rows)) {
    errs.push(`Another post already uses the slug "${slug}".`);
  }

  // A published post with no date sorts last and reads as undated on the site.
  // The editor fills today when Published is switched on, so this only fires
  // if someone clears it by hand.
  if (d.published && !d.published_at.trim()) {
    errs.push("A published post needs a date.");
  }
  if (d.published_at.trim() && Number.isNaN(Date.parse(d.published_at))) {
    errs.push("The publish date is not a date.");
  }
  return errs;
}

/** Draft → the row payload. Empty optional text goes back as NULL, not "". */
export function toPayload(d: PostDraft, userId: string | null) {
  const nullable = (v: string) => v.trim() || null;
  return {
    ...(d.id ? { id: d.id } : {}),
    slug: d.slug.trim(),
    type: d.type,
    title_en: d.title_en.trim(),
    title_ja: nullable(d.title_ja),
    excerpt_en: nullable(d.excerpt_en),
    excerpt_ja: nullable(d.excerpt_ja),
    body_en: d.body_en.trim(),
    body_ja: nullable(d.body_ja),
    cover_media: d.cover_media,
    published: d.published,
    // date column: "" would be rejected, NULL is the honest "no date".
    published_at: nullable(d.published_at),
    layaway_only: d.layaway_only,
    updated_by: userId,
  };
}

/** Postgres unique_violation — the slug raced another save. */
export const isUniqueViolation = (e: unknown) =>
  (e as { code?: string })?.code === "23505";
