import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, EyeOff, Eye, Loader2, MessageSquare, Reply, X } from "lucide-react";
import { format, parseISO } from "date-fns";
import { toast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  COMMENT_LAYAWAY_HINT, COMMENT_SELECT, COMMENT_STATUSES, COMMENT_STATUS_LABEL,
  commentActions, commentDb, commentFirstName, commentMentionsLayaway, filterCommentsByStatus,
  type CommentAction, type CommentRow, type CommentStatus,
} from "@/components/website/website-comments";

/**
 * Website → Content → Comments (moderate_reviews, the ReviewsCard gate).
 *
 * Customers comment under articles on chajewelsjp.com (owner plan 2026-10-16,
 * C1–C8). Nothing is public until approved here. Every action goes through
 * moderate_post_comment, which writes one audit_logs row (post_comment /
 * <action>). The reply shows on the website as "Cha Jewels".
 */

const ACTION_LABEL: Record<Exclude<CommentAction, "reply">, string> = {
  approve: "Approve", reject: "Reject", hide: "Hide", show: "Show",
};
const ACTION_DONE: Record<CommentAction, string> = {
  approve: "Comment approved", reject: "Comment rejected", hide: "Hidden from website",
  show: "Shown on website", reply: "Reply saved",
};
const ACTION_ICON = { approve: Check, reject: X, hide: EyeOff, show: Eye } as const;

const RPC_ERROR: Record<string, string> = {
  permission_denied: "You do not have permission to moderate comments.",
  invalid_transition: "This comment has already been moderated — refresh the list.",
  comment_deleted: "The customer deleted this comment.",
  reply_invalid: "A reply must be 1–1000 characters.",
  not_found: "This comment no longer exists.",
};

export function CommentsCard() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<CommentStatus>("pending");
  const [replying, setReplying] = useState<CommentRow | null>(null);

  const { data: pendingCount } = useQuery({
    queryKey: ["post-comments-pending-count"],
    queryFn: async () => {
      const { count, error } = await commentDb.from("website_post_comments")
        .select("id", { count: "exact", head: true }).eq("status", "pending").is("deleted_at", null);
      if (error) throw error;
      return (count ?? 0) as number;
    },
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: ["post-comments", status],
    queryFn: async () => {
      const { data, error } = await commentDb.from("website_post_comments")
        .select(COMMENT_SELECT)
        .eq("status", status)
        .is("deleted_at", null)
        .order(status === "pending" ? "created_at" : "moderated_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return filterCommentsByStatus((data ?? []) as CommentRow[], status);
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["post-comments"] });
    qc.invalidateQueries({ queryKey: ["post-comments-pending-count"] });
  };

  /** Returns true on success. */
  const moderate = async (row: CommentRow, action: CommentAction, reply?: string): Promise<boolean> => {
    const { data, error } = await commentDb.rpc("moderate_post_comment", { p_id: row.id, p_action: action, p_reply: reply ?? null });
    const code = error ? null : (data as { error?: string } | null)?.error;
    if (error || code) {
      toast({
        title: "Action failed",
        description: error ? error.message : RPC_ERROR[code!] ?? code!,
        variant: "destructive",
      });
      return false;
    }
    toast({ title: ACTION_DONE[action] });
    refresh();
    return true;
  };

  return (
    <Card id="comments">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><MessageSquare className="h-5 w-5 text-primary" /> Comments</CardTitle>
        <CardDescription>
          Customer comments under articles. Nothing shows on the website until approved. Replies show as “Cha Jewels”.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={status} onValueChange={(v) => setStatus(v as CommentStatus)}>
          <TabsList className="h-auto flex-wrap">
            {COMMENT_STATUSES.map((s) => (
              <TabsTrigger key={s} value={s} className="gap-1.5">
                {COMMENT_STATUS_LABEL[s]}
                {s === "pending" && !!pendingCount && <Badge variant="secondary" className="h-5 px-1.5">{pendingCount}</Badge>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !rows?.length ? (
          <p className="text-sm text-muted-foreground">No {COMMENT_STATUS_LABEL[status].toLowerCase()} comments.</p>
        ) : (
          <div className="space-y-4">
            {rows.map((r) => (
              <CommentItem key={r.id} row={r} onAction={(a) => moderate(r, a)} onReply={() => setReplying(r)} />
            ))}
          </div>
        )}
      </CardContent>
      <ReplyDialog
        key={replying?.id ?? "closed"}
        row={replying}
        onClose={() => setReplying(null)}
        onSave={async (text) => {
          if (replying && await moderate(replying, "reply", text)) setReplying(null);
        }}
      />
    </Card>
  );
}

export function CommentItem({ row, onAction, onReply }: {
  row: CommentRow;
  onAction: (a: Exclude<CommentAction, "reply">) => Promise<boolean>;
  onReply: () => void;
}) {
  const [busy, setBusy] = useState<CommentAction | null>(null);
  const run = async (a: Exclude<CommentAction, "reply">) => {
    setBusy(a);
    try { await onAction(a); } finally { setBusy(null); }
  };
  const actions = commentActions(row.status);

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">{row.post?.title_en ?? "(article removed)"}</span>
        <span className="text-xs text-muted-foreground">{format(parseISO(row.created_at), "MMM d, yyyy HH:mm")}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {commentFirstName(row.customer?.full_name)}
        {row.customer?.customer_code ? ` · ${row.customer.customer_code}` : ""}
        {` · ${row.lang === "ja" ? "Japanese site" : "English site"}`}
      </p>
      <p className="whitespace-pre-wrap break-words text-sm">{row.body}</p>
      {commentMentionsLayaway(row.body) && (
        <p className="text-xs text-muted-foreground">{COMMENT_LAYAWAY_HINT}</p>
      )}
      {row.reply_body && (
        <div className="rounded-md bg-muted/50 p-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Cha Jewels</span>
          <p className="whitespace-pre-wrap break-words">{row.reply_body}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {actions.filter((a): a is Exclude<CommentAction, "reply"> => a !== "reply").map((a) => {
          const Icon = ACTION_ICON[a];
          return (
            <Button key={a} size="sm" variant={a === "approve" || a === "show" ? "default" : "outline"}
              disabled={busy !== null} onClick={() => run(a)}>
              {busy === a ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Icon className="mr-1 h-4 w-4" />}
              {ACTION_LABEL[a]}
            </Button>
          );
        })}
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onReply}>
          <Reply className="mr-1 h-4 w-4" /> {row.reply_body ? "Edit reply" : "Reply"}
        </Button>
      </div>
    </div>
  );
}

function ReplyDialog({ row, onClose, onSave }: {
  row: CommentRow | null;
  onClose: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  // Keyed on the comment id by the parent, so the text starts from that comment's reply.
  const [text, setText] = useState(row?.reply_body ?? "");
  const [saving, setSaving] = useState(false);
  const trimmed = text.trim();

  return (
    <Dialog open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reply as Cha Jewels</DialogTitle>
          <DialogDescription>One reply per comment. It shows under the comment once the comment is approved.</DialogDescription>
        </DialogHeader>
        {row && <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-sm">{row.body}</p>}
        <div className="space-y-1.5">
          <Label htmlFor="comment-reply">Reply</Label>
          <Textarea id="comment-reply" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="text-right text-xs text-muted-foreground">{trimmed.length} / 1000</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={saving || trimmed.length < 1}
            onClick={async () => { setSaving(true); try { await onSave(trimmed); } finally { setSaving(false); } }}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save reply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
