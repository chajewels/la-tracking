import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Star, Copy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  REVIEW_LINK_BASE, fillReviewMessage, newReviewToken, reviewDb, sha256Hex,
} from "./review-db";

/**
 * Raw tokens exist only in this browser session, keyed by invite id — never
 * stored anywhere. "Copy again" works only while the token is known here.
 */
const sessionMessages = new Map<string, string>();

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  kind: "cash" | "layaway";
  orderId: string;
  customerId: string;
  customerName: string | null | undefined;
  /** item_description (cash) or first line of notes, used when no item line exists. */
  fallbackPiece: string | null | undefined;
}

interface InviteRow {
  id: string; created_at: string; expires_at: string; used_at: string | null;
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
  toast({ title: "Review message copied — paste it in Messenger" });
}

export function ReviewLinkDialog({ open, onOpenChange, kind, orderId, customerId, customerName, fallbackPiece }: Props) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const orderCol = kind === "cash" ? "cash_order_id" : "layaway_account_id";
  const [piece, setPiece] = useState("");
  const [productId, setProductId] = useState<string | null>(null);
  const [productLabel, setProductLabel] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // First item line → prefill piece + website product.
  const { data: firstLine } = useQuery({
    queryKey: ["review-first-line", kind, orderId],
    enabled: open,
    queryFn: async () => {
      const table = kind === "cash" ? "cash_order_items" : "layaway_account_items";
      const col = kind === "cash" ? "cash_order_id" : "account_id";
      const { data, error } = await reviewDb.from(table)
        .select("title, website_product_id")
        .eq(col, orderId).order("created_at", { ascending: true }).limit(1);
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as { title: string; website_product_id: string | null } | null;
    },
  });

  const { data: invites, refetch: refetchInvites } = useQuery({
    queryKey: ["review-invites", kind, orderId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await reviewDb.from("review_invites")
        .select("id, created_at, expires_at, used_at")
        .eq(orderCol, orderId).is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as InviteRow[];
    },
  });

  const { data: products } = useQuery({
    queryKey: ["review-product-search", search],
    enabled: open && search.trim().length >= 2,
    queryFn: async () => {
      const q = search.trim().replace(/[%,()]/g, " ");
      const { data, error } = await supabase.from("website_products")
        .select("id, sku, name").or(`sku.ilike.%${q}%,name.ilike.%${q}%`).limit(10);
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    const firstNote = (fallbackPiece ?? "").split(/\r?\n/)[0]?.trim() ?? "";
    setPiece((firstLine?.title ?? firstNote).slice(0, 200));
    if (firstLine?.website_product_id) {
      setProductId(firstLine.website_product_id);
      supabase.from("website_products").select("sku, name").eq("id", firstLine.website_product_id).maybeSingle()
        .then(({ data }) => { if (data) setProductLabel(`${data.sku} — ${data.name}`); });
    } else { setProductId(null); setProductLabel(""); }
  }, [open, firstLine, fallbackPiece]);

  const used = invites?.find((i) => i.used_at);
  const openInvite = invites?.find((i) => !i.used_at && new Date(i.expires_at).getTime() > Date.now());
  const knownMessage = openInvite ? sessionMessages.get(openInvite.id) : undefined;

  const { data: usedReviewId } = useQuery({
    queryKey: ["review-for-invite", used?.id],
    enabled: !!used,
    queryFn: async () => {
      const { data } = await reviewDb.from("product_reviews").select("id").eq("invite_id", used!.id).maybeSingle();
      return (data?.id as string | undefined) ?? null;
    },
  });

  const create = async () => {
    const pieceName = piece.trim();
    if (!pieceName) { toast({ title: "Piece name is required", variant: "destructive" }); return; }
    if (!user) return;
    setBusy(true);
    try {
      // Any older open (or expired-but-open) invite is revoked first: one open invite per order.
      const stale = (invites ?? []).filter((i) => !i.used_at).map((i) => i.id);
      if (stale.length) {
        const { error } = await reviewDb.from("review_invites")
          .update({ revoked_at: new Date().toISOString() }).in("id", stale);
        if (error) throw error;
      }
      const { data: lines, error: lErr } = await reviewDb.from("message_lines")
        .select("body").eq("message_type", "review_invite").eq("part", "full").eq("active", true);
      if (lErr) throw lErr;
      const pool = (lines ?? []) as { body: string }[];
      if (!pool.length) throw new Error("No active review message lines.");
      const template = pool[Math.floor(Math.random() * pool.length)].body;

      const token = newReviewToken();
      const { data: inserted, error: iErr } = await reviewDb.from("review_invites").insert({
        customer_id: customerId,
        [orderCol]: orderId,
        website_product_id: productId,
        piece_name: pieceName,
        token_hash: await sha256Hex(token),
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        created_by: user.id,
      }).select("id").single();
      if (iErr) throw iErr;

      const firstName = (customerName ?? "").trim().split(/\s+/)[0] || "there";
      const text = fillReviewMessage(template, { first_name: firstName, piece: pieceName, link: REVIEW_LINK_BASE + token });
      sessionMessages.set(inserted.id as string, text);
      setMessage(text);
      await copyText(text);
      await refetchInvites();
      qc.invalidateQueries({ queryKey: ["review-invites", kind, orderId] });
    } catch (e) {
      toast({ title: "Could not create the review link", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const fmt = (d: string) => new Date(d).toLocaleDateString();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Star className="h-4 w-4 text-primary" /> Review link</DialogTitle>
          <DialogDescription>A personal one-order link. The customer needs no sign-in; the review waits for owner approval.</DialogDescription>
        </DialogHeader>

        {used ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            Customer already left a review.{" "}
            <Link className="text-primary underline" to={`/website?tab=reviews${usedReviewId ? `&review=${usedReviewId}` : ""}`}>
              Open it in Website → Reviews
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="review-piece">Piece name</Label>
              <Input id="review-piece" value={piece} maxLength={200} onChange={(e) => setPiece(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="review-product">Website piece (optional)</Label>
              {productId ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="truncate">{productLabel || productId}</span>
                  <Button size="sm" variant="ghost" onClick={() => { setProductId(null); setProductLabel(""); }}>Clear</Button>
                </div>
              ) : (
                <>
                  <Input id="review-product" placeholder="Search by SKU or name" value={search} onChange={(e) => setSearch(e.target.value)} />
                  {!!products?.length && (
                    <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                      {products.map((p) => (
                        <button key={p.id} type="button"
                          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                          onClick={() => { setProductId(p.id); setProductLabel(`${p.sku} — ${p.name}`); setSearch(""); }}>
                          {p.sku} — {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {openInvite && !message && (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm space-y-2">
                <p>An open link exists — created {fmt(openInvite.created_at)}, expires {fmt(openInvite.expires_at)}.</p>
                {knownMessage ? (
                  <Button size="sm" variant="outline" onClick={() => { setMessage(knownMessage); void copyText(knownMessage); }}>
                    <Copy className="h-3.5 w-3.5 mr-1" /> Copy again
                  </Button>
                ) : (
                  <p className="text-muted-foreground">The link cannot be shown again. Make a new link — the old one stops working.</p>
                )}
              </div>
            )}

            {message && (
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 text-xs">{message}</pre>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          {!used && (
            <Button onClick={create} disabled={busy || !piece.trim()}>
              {busy ? "Creating…" : openInvite ? "Make a new link" : "Create link & copy"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
