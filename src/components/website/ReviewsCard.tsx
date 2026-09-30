import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Star, Languages, Check, X, EyeOff, Eye, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { reviewDb, type ProductReviewRow, type ReviewStatus } from "@/components/reviews/review-db";

/**
 * Website → Reviews (moderate_reviews). Nothing a customer writes is public
 * until approved here. Approve copies photos from the private review-uploads
 * bucket to the public review-photos bucket; Hide removes the public copies.
 * Every approve / reject / hide / show writes audit_logs.
 */

type Row = ProductReviewRow & {
  customer: { full_name: string | null } | null;
  product: { slug: string; name: string } | null;
};

const STATUSES: ReviewStatus[] = ["pending", "approved", "rejected", "hidden"];
const LABEL: Record<ReviewStatus, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", hidden: "Hidden" };

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex" aria-label={`${n} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`h-4 w-4 ${i <= n ? "fill-primary text-primary" : "text-muted-foreground"}`} />
      ))}
    </span>
  );
}

export function ReviewsCard() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<ReviewStatus>("pending");
  const focusId = params.get("review");

  const { data: pendingCount } = useQuery({
    queryKey: ["product-reviews-pending-count"],
    queryFn: async () => {
      const { count, error } = await reviewDb.from("product_reviews")
        .select("id", { count: "exact", head: true }).eq("status", "pending");
      if (error) throw error;
      return (count ?? 0) as number;
    },
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: ["product-reviews", status],
    queryFn: async () => {
      const { data, error } = await reviewDb.from("product_reviews")
        .select("*, customer:customers(full_name), product:website_products(slug, name)")
        .eq("status", status)
        .order(status === "pending" ? "created_at" : "reviewed_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  // Invoice numbers for the order links (order ids carry no FK embed).
  const { data: invoices } = useQuery({
    queryKey: ["product-reviews-invoices", status, rows?.map((r) => r.id).join(",")],
    enabled: !!rows?.length,
    queryFn: async () => {
      const cashIds = rows!.map((r) => r.cash_order_id).filter(Boolean) as string[];
      const layIds = rows!.map((r) => r.layaway_account_id).filter(Boolean) as string[];
      const out = new Map<string, string>();
      if (cashIds.length) {
        const { data } = await supabase.from("cash_orders").select("id, invoice_number").in("id", cashIds);
        (data ?? []).forEach((o) => out.set(o.id, o.invoice_number));
      }
      if (layIds.length) {
        const { data } = await supabase.from("layaway_accounts").select("id, invoice_number").in("id", layIds);
        (data ?? []).forEach((o) => out.set(o.id, o.invoice_number));
      }
      return out;
    },
  });

  useEffect(() => {
    if (!focusId || !rows?.length) return;
    document.getElementById(`review-${focusId}`)?.scrollIntoView({ block: "center" });
  }, [focusId, rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Star className="h-5 w-5 text-primary" /> Reviews</CardTitle>
        <CardDescription>Customer reviews from personal review links. Nothing shows on the website until approved.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={status} onValueChange={(v) => setStatus(v as ReviewStatus)}>
          <TabsList className="h-auto flex-wrap">
            {STATUSES.map((s) => (
              <TabsTrigger key={s} value={s} className="gap-1.5">
                {LABEL[s]}
                {s === "pending" && !!pendingCount && <Badge variant="secondary" className="h-5 px-1.5">{pendingCount}</Badge>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !rows?.length ? (
          <p className="text-sm text-muted-foreground">No {LABEL[status].toLowerCase()} reviews.</p>
        ) : (
          <div className="space-y-4">
            {rows.map((r) => (
              <ReviewItem key={r.id} row={r} invoice={invoices?.get(r.cash_order_id ?? r.layaway_account_id ?? "")} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function extOf(path: string) { return path.split(".").pop() ?? "jpg"; }

function ReviewItem({ row, invoice }: { row: Row; invoice?: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [ja, setJa] = useState(row.body_ja ?? "");
  const [en, setEn] = useState(row.body_en ?? "");
  const [lang, setLang] = useState(row.original_language);
  const [translating, setTranslating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const autoTried = useRef(false);

  const { data: signed } = useQuery({
    queryKey: ["review-upload-urls", row.id, row.upload_paths.join(",")],
    enabled: row.upload_paths.length > 0,
    staleTime: 50 * 60_000,
    queryFn: async () => {
      const out: string[] = [];
      for (const p of row.upload_paths) {
        const { data } = await supabase.storage.from("review-uploads").createSignedUrl(p, 3600);
        if (data?.signedUrl) out.push(data.signedUrl);
      }
      return out;
    },
  });

  const translate = async () => {
    setTranslating(true);
    try {
      const { data, error } = await supabase.functions.invoke("translate-review", { body: { review_id: row.id } });
      if (error) {
        const res = (error as { context?: Response }).context;
        const detail = res ? await res.json().catch(() => null) : null;
        throw new Error(detail?.error ?? error.message);
      }
      setJa(String(data?.body_ja ?? ""));
      setEn(String(data?.body_en ?? ""));
      setLang(data?.original_language ?? null);
    } catch (e) {
      toast({ title: "Translation failed", description: (e as Error).message, variant: "destructive" });
    } finally { setTranslating(false); }
  };

  useEffect(() => {
    if (row.status === "pending" && !row.body_ja && !autoTried.current) {
      autoTried.current = true;
      void translate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["product-reviews"] });
    qc.invalidateQueries({ queryKey: ["product-reviews-pending-count"] });
  };

  const audit = (action: string, newValue: unknown) =>
    supabase.from("audit_logs").insert([{
      entity_type: "product_review", entity_id: row.id, action,
      new_value_json: newValue as never, performed_by_user_id: user?.id ?? null,
    }]);

  /** Copy every private upload to the public bucket; returns the public URLs. */
  const publishPhotos = async (): Promise<string[]> => {
    const urls: string[] = [];
    for (let i = 0; i < row.upload_paths.length; i++) {
      const src = row.upload_paths[i];
      const { data: blob, error: dErr } = await supabase.storage.from("review-uploads").download(src);
      if (dErr || !blob) throw dErr ?? new Error("Photo download failed");
      const dest = `${row.id}/${i + 1}.${extOf(src)}`;
      const { error: uErr } = await supabase.storage.from("review-photos").upload(dest, blob, { upsert: true, contentType: blob.type || undefined });
      if (uErr) throw uErr;
      urls.push(supabase.storage.from("review-photos").getPublicUrl(dest).data.publicUrl);
    }
    return urls;
  };

  const unpublishPhotos = async () => {
    const paths = row.upload_paths.map((p, i) => `${row.id}/${i + 1}.${extOf(p)}`);
    if (paths.length) await supabase.storage.from("review-photos").remove(paths);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); refresh(); } catch (e) {
      toast({ title: "Action failed", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const approve = () => run(async () => {
    if (!ja.trim()) throw new Error("Japanese text is empty — translate or write it first.");
    if (lang === "ja" && !en.trim()) throw new Error("English text is empty — translate or write it first.");
    const photo_urls = await publishPhotos();
    const patch = {
      body_ja: ja.trim(), body_en: en.trim() || null, original_language: lang,
      photo_urls, status: "approved", reviewed_by: user?.id ?? null, reviewed_at: new Date().toISOString(),
    };
    const { error } = await reviewDb.from("product_reviews").update(patch).eq("id", row.id);
    if (error) throw error;
    await audit(row.status === "hidden" ? "show" : "approve", patch);
    toast({ title: "Review approved" });
  });

  const reject = () => run(async () => {
    if (!reason.trim()) throw new Error("A reason is required.");
    const patch = { status: "rejected", reject_reason: reason.trim(), reviewed_by: user?.id ?? null, reviewed_at: new Date().toISOString() };
    const { error } = await reviewDb.from("product_reviews").update(patch).eq("id", row.id);
    if (error) throw error;
    await audit("reject", patch);
    toast({ title: "Review rejected" });
  });

  const hide = () => run(async () => {
    await unpublishPhotos();
    const patch = { status: "hidden", photo_urls: [], reviewed_by: user?.id ?? null, reviewed_at: new Date().toISOString() };
    const { error } = await reviewDb.from("product_reviews").update(patch).eq("id", row.id);
    if (error) throw error;
    await audit("hide", patch);
    toast({ title: "Hidden from website" });
  });

  const orderPath = row.cash_order_id ? `/cash-orders/${row.cash_order_id}` : `/accounts/${row.layaway_account_id}`;
  const editable = row.status === "pending" || row.status === "hidden";

  return (
    <div id={`review-${row.id}`} className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Stars n={row.rating} />
        <span className="font-medium">{row.piece_name}</span>
        {row.product && <Badge variant="outline">{row.product.name}</Badge>}
        <Link className="text-primary underline" to={`/customers/${row.customer_id}`}>{row.customer?.full_name ?? row.display_name}</Link>
        <Link className="text-primary underline" to={orderPath}>Inv #{invoice ?? "—"}</Link>
        <span className="text-muted-foreground">{new Date(row.created_at).toLocaleString()}</span>
        <span className="text-muted-foreground">shown as “{row.display_name}”</span>
      </div>

      <div className="rounded-md bg-muted/40 p-3 text-sm whitespace-pre-wrap">{row.body_original}</div>

      {!!signed?.length && (
        <div className="flex flex-wrap gap-2">
          {signed.map((u) => (
            <a key={u} href={u} target="_blank" rel="noopener noreferrer">
              <img src={u} alt="Customer photo" className="h-24 w-24 rounded-md border border-border object-cover" />
            </a>
          ))}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Japanese (shown on the Japanese site)</Label>
          <Textarea rows={4} value={ja} onChange={(e) => setJa(e.target.value)} disabled={!editable || translating} />
        </div>
        {lang === "ja" && (
          <div className="space-y-1.5">
            <Label>English (shown on the English site)</Label>
            <Textarea rows={4} value={en} onChange={(e) => setEn(e.target.value)} disabled={!editable || translating} />
          </div>
        )}
      </div>
      {lang && <p className="text-xs text-muted-foreground">Original language: {lang}</p>}
      {row.status === "rejected" && row.reject_reason && (
        <p className="text-sm text-muted-foreground">Rejected: {row.reject_reason}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {editable && (
          <Button size="sm" variant="outline" onClick={translate} disabled={translating || busy}>
            {translating ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Languages className="h-3.5 w-3.5 mr-1" />}
            Re-translate
          </Button>
        )}
        {row.status === "pending" && (
          <>
            <Button size="sm" onClick={approve} disabled={busy || translating || !ja.trim()}>
              <Check className="h-3.5 w-3.5 mr-1" /> Approve
            </Button>
            {!rejecting ? (
              <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={busy}>
                <X className="h-3.5 w-3.5 mr-1" /> Reject
              </Button>
            ) : (
              <div className="flex w-full flex-col gap-2 sm:flex-row">
                <Textarea rows={2} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button size="sm" variant="destructive" onClick={reject} disabled={busy || !reason.trim()}>Confirm reject</Button>
              </div>
            )}
          </>
        )}
        {row.status === "approved" && (
          <Button size="sm" variant="outline" onClick={hide} disabled={busy}>
            <EyeOff className="h-3.5 w-3.5 mr-1" /> Hide from website
          </Button>
        )}
        {row.status === "hidden" && (
          <Button size="sm" variant="outline" onClick={approve} disabled={busy || !ja.trim()}>
            <Eye className="h-3.5 w-3.5 mr-1" /> Show again
          </Button>
        )}
      </div>
    </div>
  );
}
