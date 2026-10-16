/**
 * Article comments (owner plan 2026-10-16, C1–C8) — the pure rules the `website` edge
 * function applies. Table, RLS and moderation: migration 20261222100000_website_post_comments.sql.
 * The Hub's CommentsCard imports the status list from here so the two cannot drift.
 */

export const COMMENT_STATUSES = ["pending", "approved", "hidden", "rejected"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/** C5: plain text, 1–1000 characters after trimming (the DB check is the same). */
export const COMMENT_MAX_CHARS = 1000;
/** C5: comments per customer per rolling 24 h (non-deleted rows). */
export const COMMENT_DAILY_LIMIT = 5;
export const COMMENT_LANGS = ["en", "ja"] as const;

/** Trimmed body, or null when it is not 1–1000 characters of text. */
export function cleanCommentBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const body = raw.trim();
  if (body.length < 1 || body.length > COMMENT_MAX_CHARS) return null;
  return body;
}

export function isCommentLang(raw: unknown): raw is "en" | "ja" {
  return raw === "en" || raw === "ja";
}

/** C1: "Maria Santos Cruz" → "Maria" (the review-invite rule); empty → "Customer". */
export function firstNameOf(fullName: unknown): string {
  return String(fullName ?? "").trim().split(/\s+/)[0] || "Customer";
}

/** C8: comments only on a published article dated today or earlier (PHT). */
export function commentsOpen(post: { type?: unknown; published?: unknown; published_at?: unknown }, phtToday: string): boolean {
  return post.type === "article" && post.published === true &&
    typeof post.published_at === "string" && post.published_at.slice(0, 10) <= phtToday;
}

export interface PublicComment {
  id: string;
  author_first_name: string;
  body: string;
  created_at: string;
  reply: { body: string; created_at: string } | null;
}

/** The only shape a comment leaves the Hub in. Never the email, customer id or status. */
export function toPublicComment(row: Record<string, unknown>): PublicComment {
  const customer = row.customer as { full_name?: unknown } | null | undefined;
  return {
    id: String(row.id),
    author_first_name: firstNameOf(customer?.full_name),
    body: String(row.body ?? ""),
    created_at: String(row.created_at),
    reply: row.reply_body ? { body: String(row.reply_body), created_at: String(row.reply_at ?? row.updated_at) } : null,
  };
}
