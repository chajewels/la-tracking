import { supabase } from "@/integrations/supabase/client";
import { COMMENT_STATUSES, type CommentStatus } from "../../../supabase/functions/_shared/post-comments.ts";
import { jaTextMentionsLayaway } from "@/lib/layaway-only-rule";

/**
 * Article comments in the Hub (owner plan 2026-10-16, C1–C8). Pure helpers for
 * CommentsCard; the table and the moderation RPC are migration
 * 20261222100000_website_post_comments.sql.
 *
 * website_post_comments and moderate_post_comment are not in the generated
 * types until the migration is applied and types.ts regenerates. types.ts is
 * never hand-edited (CLAUDE.md), so cast at the call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const commentDb = supabase as unknown as { from: (table: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

export { COMMENT_STATUSES, type CommentStatus };

export const COMMENT_STATUS_LABEL: Record<CommentStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  hidden: "Hidden",
  rejected: "Rejected",
};

export type CommentAction = "approve" | "reject" | "hide" | "show" | "reply";

export interface CommentRow {
  id: string;
  post_id: string;
  customer_id: string;
  body: string;
  lang: "en" | "ja";
  status: CommentStatus;
  reply_body: string | null;
  reply_at: string | null;
  moderated_at: string | null;
  deleted_at: string | null;
  created_at: string;
  post: { title_en: string | null; slug: string } | null;
  customer: { full_name: string | null; customer_code: string | null } | null;
}

export const COMMENT_SELECT =
  "id, post_id, customer_id, body, lang, status, reply_body, reply_at, moderated_at, deleted_at, created_at, " +
  "post:website_posts(title_en, slug), customer:customers(full_name, customer_code)";

/** C2: the status moves a row in `status` can make. Reply is always offered. */
export function commentActions(status: CommentStatus): CommentAction[] {
  switch (status) {
    case "pending": return ["approve", "reject", "reply"];
    case "approved": return ["hide", "reply"];
    case "hidden": return ["show", "reply"];
    case "rejected": return ["reply"];
  }
}

/** One tab's rows: that status, the author's soft-deleted ones left out. */
export function filterCommentsByStatus<T extends Pick<CommentRow, "status" | "deleted_at">>(rows: T[], status: CommentStatus): T[] {
  return rows.filter((r) => r.status === status && !r.deleted_at);
}

/** C1: the first word of the customer's full name, as the website shows it. */
export function commentFirstName(fullName: string | null | undefined): string {
  return String(fullName ?? "").trim().split(/\s+/)[0] || "Customer";
}

/** C6: hint only — a comment is shown on both language sites as written. */
export function commentMentionsLayaway(body: string): boolean {
  return jaTextMentionsLayaway({ body_ja: body });
}

export const COMMENT_LAYAWAY_HINT =
  "Mentions layaway — if approved, it shows on both the English and the Japanese site as written.";
