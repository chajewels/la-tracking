import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));

import {
  COMMENT_LAYAWAY_HINT, COMMENT_STATUSES, commentActions, commentFirstName,
  commentMentionsLayaway, filterCommentsByStatus, type CommentRow,
} from "@/components/website/website-comments";
import { CommentItem } from "@/components/website/CommentsCard";
import {
  cleanCommentBody, commentsOpen, firstNameOf, isCommentLang, toPublicComment,
} from "../../supabase/functions/_shared/post-comments.ts";

const row = (over: Partial<CommentRow> = {}): CommentRow => ({
  id: "c1", post_id: "p1", customer_id: "u1", body: "Lovely piece!", lang: "en",
  status: "pending", reply_body: null, reply_at: null, moderated_at: null, deleted_at: null,
  created_at: "2026-10-16T09:00:00Z",
  post: { title_en: "Caring for K18 gold", slug: "k18-care" },
  customer: { full_name: "Maria Santos Cruz", customer_code: "CJ-2026-00008" },
  ...over,
});

describe("article comments — status tabs (C2, C7)", () => {
  it("tabs are Pending / Approved / Hidden / Rejected in that order", () => {
    expect(COMMENT_STATUSES).toEqual(["pending", "approved", "hidden", "rejected"]);
  });

  it("a tab shows only its status and never a soft-deleted comment", () => {
    const rows = [
      row({ id: "a", status: "pending" }),
      row({ id: "b", status: "approved" }),
      row({ id: "c", status: "pending", deleted_at: "2026-10-16T10:00:00Z" }),
      row({ id: "d", status: "hidden" }),
    ];
    expect(filterCommentsByStatus(rows, "pending").map((r) => r.id)).toEqual(["a"]);
    expect(filterCommentsByStatus(rows, "approved").map((r) => r.id)).toEqual(["b"]);
    expect(filterCommentsByStatus(rows, "hidden").map((r) => r.id)).toEqual(["d"]);
    expect(filterCommentsByStatus(rows, "rejected")).toEqual([]);
  });

  it("actions follow pending → approved | rejected and approved ↔ hidden", () => {
    expect(commentActions("pending")).toEqual(["approve", "reject", "reply"]);
    expect(commentActions("approved")).toEqual(["hide", "reply"]);
    expect(commentActions("hidden")).toEqual(["show", "reply"]);
    expect(commentActions("rejected")).toEqual(["reply"]);
  });
});

describe("article comments — layaway hint (C6, hint only)", () => {
  it("matches layaway / レイアウェイ / 分割予約 in the comment text", () => {
    expect(commentMentionsLayaway("Can I buy this on layaway?")).toBe(true);
    expect(commentMentionsLayaway("レイアウェイできますか")).toBe(true);
    expect(commentMentionsLayaway("分割予約は可能ですか")).toBe(true);
    expect(commentMentionsLayaway("素敵です")).toBe(false);
  });

  it("the card shows the grey hint under a matching comment, and not otherwise", () => {
    const noop = vi.fn(async () => true);
    const { rerender } = render(<CommentItem row={row({ body: "Is layaway possible?" })} onAction={noop} onReply={vi.fn()} />);
    expect(screen.getByText(COMMENT_LAYAWAY_HINT)).toBeInTheDocument();
    // The hint never removes a moderation action.
    expect(screen.getByRole("button", { name: /Approve/ })).toBeEnabled();
    rerender(<CommentItem row={row({ body: "Beautiful ring" })} onAction={noop} onReply={vi.fn()} />);
    expect(screen.queryByText(COMMENT_LAYAWAY_HINT)).toBeNull();
  });

  it("shows first name + customer code, never the full name", () => {
    render(<CommentItem row={row()} onAction={vi.fn(async () => true)} onReply={vi.fn()} />);
    expect(screen.getByText(/Maria · CJ-2026-00008/)).toBeInTheDocument();
    expect(screen.queryByText(/Santos/)).toBeNull();
    expect(commentFirstName(null)).toBe("Customer");
  });
});

describe("article comments — website rules (_shared/post-comments.ts)", () => {
  it("C5: body is 1–1000 characters after trimming, text only", () => {
    expect(cleanCommentBody("  hi  ")).toBe("hi");
    expect(cleanCommentBody("   ")).toBeNull();
    expect(cleanCommentBody("x".repeat(1000))).toHaveLength(1000);
    expect(cleanCommentBody("x".repeat(1001))).toBeNull();
    expect(cleanCommentBody(42)).toBeNull();
    expect(isCommentLang("ja")).toBe(true);
    expect(isCommentLang("tl")).toBe(false);
  });

  it("C8: open only on a published article dated today or earlier (PHT)", () => {
    const today = "2026-10-16";
    expect(commentsOpen({ type: "article", published: true, published_at: "2026-10-16" }, today)).toBe(true);
    expect(commentsOpen({ type: "news", published: true, published_at: "2026-10-01" }, today)).toBe(false);
    expect(commentsOpen({ type: "article", published: false, published_at: "2026-10-01" }, today)).toBe(false);
    expect(commentsOpen({ type: "article", published: true, published_at: "2026-10-17" }, today)).toBe(false);
  });

  it("C1/C3: the public shape carries the first name and the reply, never email or ids", () => {
    const out = toPublicComment({
      id: "c1", body: "Nice", created_at: "t0", reply_body: "Thank you!", reply_at: "t1",
      customer_id: "secret", customer: { full_name: "Maria Santos", email: "m@example.com" },
    });
    expect(out).toEqual({ id: "c1", author_first_name: "Maria", body: "Nice", created_at: "t0", reply: { body: "Thank you!", created_at: "t1" } });
    expect(JSON.stringify(out)).not.toMatch(/example\.com|secret/);
    expect(firstNameOf("")).toBe("Customer");
  });
});
