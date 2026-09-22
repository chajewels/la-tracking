import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Eye, Loader2, Mail, Plus, RefreshCw, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import DataTable, { type DataTableColumn } from "@/components/data-table/DataTable";
import { MultiPick } from "@/components/website/MultiPick";
import { Markdown } from "@/components/website/markdown";
import { translateJa } from "@/components/website/translate";
import { formatPHTDisplay } from "@/lib/date-utils";
import {
  NEWSLETTER_SUBSCRIBER_SELECT, newsletterSubscribers, type NewsletterSubscriberRow,
} from "@/components/website/newsletter-types";
import {
  type CampaignAudience, type CampaignDraft, type CampaignRow,
  AUDIENCE_LABEL, CAMPAIGN_AUDIENCES, CAMPAIGN_SELECT, LAYAWAY_HINT, MAX_CAMPAIGN_PRODUCTS,
  SEND_RATE_PER_HOUR,
  STATUS_LABEL, campaignPayload, emptyCampaign, estimateText, isCancellable, isEditable,
  isInFlight, isLayawayError, progressText, recipientCount, statusOf, toDraft, validateCampaign,
} from "@/components/website/newsletter-campaigns";

/**
 * Newsletter campaigns.
 *
 * The Hub composes and queues; Lovable's edge functions (campaign-queue,
 * process-newsletter-campaigns, campaign-cancel) and their cron do the sending.
 * Nothing here mails anyone directly.
 *
 * A send is the one irreversible thing in this workspace — the mail is gone —
 * so the confirm dialog states the recipient count and the duration BEFORE the
 * button, only drafts are editable, and both send and cancel write audit rows.
 *
 * Gated on manage_website_content, matching newsletter_campaigns' RLS. The
 * recipients table is staff-SELECT only and has no write policy at all: those
 * rows are the queue worker's, not the Hub's.
 *
 * Neither campaign table is in types.ts, so both go through the `as any` cast.
 */

const STATUS_CHIP: Record<string, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  queued: "border-primary/30 bg-primary/10 text-primary",
  sending: "border-primary/30 bg-primary/10 text-primary",
  sent: "border-success/20 bg-success/10 text-success",
  cancelled: "border-border bg-muted text-muted-foreground",
};

export function CampaignsCard() {
  const qc = useQueryClient();
  const { user, roles } = useAuth();
  const { can } = usePermissions();
  const canManage = can("manage_website_content") || !!roles?.includes("admin");

  const campaigns = useQuery<CampaignRow[]>({
    queryKey: ["newsletter-campaigns"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("newsletter_campaigns" as any)
        .select(CAMPAIGN_SELECT)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CampaignRow[];
    },
    // Progress is written by the queue worker, not by anything on this screen,
    // so the only way to see it move is to ask again — but only while
    // something is actually in flight.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c) => isInFlight(statusOf(c.status))) ? 30_000 : false,
  });

  const rows = useMemo(() => campaigns.data ?? [], [campaigns.data]);
  const anySending = rows.some((c) => isInFlight(statusOf(c.status)));

  const subscribers = useQuery<NewsletterSubscriberRow[]>({
    queryKey: ["newsletter-subscribers"],
    queryFn: async () => {
      const { data, error } = await newsletterSubscribers().select(NEWSLETTER_SUBSCRIBER_SELECT);
      if (error) throw error;
      return (data ?? []) as NewsletterSubscriberRow[];
    },
  });

  const products = useQuery({
    queryKey: ["website-products-picker"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_products" as any)
        .select("id, name, sku, status")
        .eq("status", "active")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as { id: string; name: string; sku: string | null }[];
    },
  });

  const posts = useQuery({
    queryKey: ["website-posts-picker"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("website_posts" as any)
        .select("slug, title_en, published")
        .eq("published", true)
        .order("published_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as { slug: string; title_en: string }[];
    },
  });

  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [preview, setPreview] = useState<"en" | "ja" | null>(null);
  const [translating, setTranslating] = useState(false);
  const [layawayBlocked, setLayawayBlocked] = useState(false);
  const [testHtml, setTestHtml] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState<CampaignRow | CampaignDraft | null>(null);

  const open = (d: CampaignDraft | null) => {
    setDraft(d); setPreview(null); setLayawayBlocked(false); setTestHtml(null);
  };
  const patch = (p: Partial<CampaignDraft>) =>
    setDraft((d) => {
      if (!d) return d;
      // The refusal is about the Japanese text as it was; editing it is the
      // fix, so the message goes the moment either Japanese field changes.
      if (p.subject_ja !== undefined || p.body_ja !== undefined) setLayawayBlocked(false);
      return { ...d, ...p };
    });

  const audienceCount = (a: CampaignAudience) => recipientCount(subscribers.data ?? [], a);
  const draftCount = draft ? audienceCount(draft.audience) : 0;

  const audit = (id: string, action: string, value: unknown) =>
    supabase.from("audit_logs").insert([{
      entity_type: "newsletter_campaign",
      entity_id: id,
      action,
      old_value_json: null as never,
      new_value_json: value as never,
      performed_by_user_id: user?.id ?? null,
    }]);

  /** Save the draft, returning its id. Shared by Save, Send test and Send. */
  const persist = async (d: CampaignDraft): Promise<string> => {
    const { data, error } = await supabase
      .from("newsletter_campaigns" as any)
      .upsert(campaignPayload(d, user?.id ?? null) as never, { onConflict: "id" })
      .select("id")
      .single();
    if (error) {
      if (isLayawayError(error)) { setLayawayBlocked(true); throw new Error(LAYAWAY_HINT); }
      throw error;
    }
    return (data as unknown as { id: string }).id;
  };

  const saveDraft = useMutation({
    mutationFn: persist,
    onSuccess: () => {
      toast({ title: "Draft saved" });
      qc.invalidateQueries({ queryKey: ["newsletter-campaigns"] });
      open(null);
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  /**
   * campaign-queue. With test_email it renders and returns the HTML for one
   * address; without, it queues the real send.
   *
   * A non-ok answer is surfaced AS WRITTEN. When the Resend setup is not
   * finished the function says so in its own words, and rewording that into
   * "Could not send" would hide the one sentence that explains why.
   */
  const callQueue = async (campaign_id: string, test_email?: string) => {
    const { data, error } = await supabase.functions.invoke("campaign-queue", {
      body: test_email ? { campaign_id, test_email } : { campaign_id },
    });
    if (error) {
      const res = (error as { context?: Response }).context;
      const detail = res ? await res.json().catch(() => null) : null;
      throw new Error(detail?.error ?? detail?.message ?? error.message);
    }
    const body = (data ?? {}) as { ok?: boolean; error?: string; message?: string; html?: string };
    if (body.ok === false || body.error) {
      throw new Error(body.error ?? body.message ?? "Sending is not available.");
    }
    return body;
  };

  const sendTest = useMutation({
    mutationFn: async (d: CampaignDraft) => {
      const email = user?.email;
      if (!email) throw new Error("Your account has no email address to send the test to.");
      const id = await persist(d);
      const body = await callQueue(id, email);
      qc.invalidateQueries({ queryKey: ["newsletter-campaigns"] });
      return { html: body.html ?? null, email };
    },
    onSuccess: ({ html, email }) => {
      setTestHtml(html);
      toast({ title: `Test sent to ${email}`, description: html ? "The rendered email is shown below." : undefined });
    },
    onError: (e: Error) => toast({ title: "Could not send the test", description: e.message, variant: "destructive" }),
  });

  const sendToList = useMutation({
    mutationFn: async (target: CampaignRow | CampaignDraft) => {
      const isRow = "status" in target;
      const id = isRow ? (target as CampaignRow).id : await persist(target as CampaignDraft);
      const audience = isRow
        ? (((target as CampaignRow).audience ?? "all") as CampaignAudience)
        : (target as CampaignDraft).audience;
      const subject = isRow
        ? (target as CampaignRow).subject_en ?? (target as CampaignRow).subject_ja
        : (target as CampaignDraft).subject_en || (target as CampaignDraft).subject_ja;
      await callQueue(id);
      await audit(id, "send_newsletter_campaign", {
        subject, audience, recipients: audienceCount(audience),
      });
      return id;
    },
    onSuccess: () => {
      toast({ title: "Campaign queued", description: "Sending runs in the background." });
      qc.invalidateQueries({ queryKey: ["newsletter-campaigns"] });
      setConfirmSend(null);
      open(null);
    },
    onError: (e: Error) => {
      setConfirmSend(null);
      toast({ title: "Not sent", description: e.message, variant: "destructive" });
    },
  });

  const cancel = useMutation({
    mutationFn: async (c: CampaignRow) => {
      const { error } = await supabase.functions.invoke("campaign-cancel", { body: { campaign_id: c.id } });
      if (error) {
        const res = (error as { context?: Response }).context;
        const detail = res ? await res.json().catch(() => null) : null;
        throw new Error(detail?.error ?? error.message);
      }
      await audit(c.id, "cancel_newsletter_campaign", {
        subject: c.subject_en ?? c.subject_ja,
        sent_so_far: c.sent_count ?? 0, of: c.total ?? 0,
      });
    },
    onSuccess: () => {
      toast({ title: "Campaign cancelled", description: "Anything already sent has gone." });
      qc.invalidateQueries({ queryKey: ["newsletter-campaigns"] });
    },
    onError: (e: Error) => toast({ title: "Could not cancel", description: e.message, variant: "destructive" }),
  });

  async function regenerate() {
    if (!draft) return;
    const subject = draft.subject_en.trim();
    const body = draft.body_en.trim();
    if (!subject && !body) { toast({ title: "Nothing to translate", description: "Write the English first." }); return; }
    setTranslating(true);
    try {
      const out = await translateJa({ name: subject || undefined, description: body || undefined });
      patch({
        ...(subject ? { subject_ja: out.name_ja } : {}),
        ...(body ? { body_ja: out.description_ja } : {}),
      });
      toast({ title: "Japanese updated" });
    } catch (e) {
      toast({ title: "Could not translate", description: (e as Error).message, variant: "destructive" });
    } finally {
      setTranslating(false);
    }
  }

  const errors = draft ? validateCampaign(draft) : [];
  const busy = saveDraft.isPending || sendTest.isPending || sendToList.isPending;

  const columns = useMemo<DataTableColumn<CampaignRow>[]>(() => [
    {
      key: "subject",
      header: "Subject",
      cell: (r) => (
        <div className="min-w-0">
          <div className="font-medium text-card-foreground">{r.subject_en ?? r.subject_ja}</div>
          {r.subject_en && r.subject_ja && (
            <div className="text-[11px] text-muted-foreground" lang="ja">{r.subject_ja}</div>
          )}
        </div>
      ),
      sortValue: (r) => (r.subject_en ?? r.subject_ja ?? "").toLowerCase(),
      filterValue: (r) => `${r.subject_en ?? ""} ${r.subject_ja ?? ""}`,
      csvValue: (r) => r.subject_en ?? r.subject_ja ?? "",
    },
    {
      key: "audience",
      header: "Audience",
      cell: (r) => <span className="text-xs">{AUDIENCE_LABEL[(r.audience ?? "all") as CampaignAudience]}</span>,
      sortValue: (r) => r.audience ?? "",
      filterValue: (r) => AUDIENCE_LABEL[(r.audience ?? "all") as CampaignAudience],
      csvValue: (r) => r.audience ?? "",
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const s = statusOf(r.status);
        return <Badge variant="outline" className={`text-[10px] ${STATUS_CHIP[s]}`}>{STATUS_LABEL[s]}</Badge>;
      },
      sortValue: (r) => statusOf(r.status),
      filterValue: (r) => STATUS_LABEL[statusOf(r.status)],
      csvValue: (r) => statusOf(r.status),
    },
    {
      key: "progress",
      header: "Progress",
      cell: (r) => {
        const failed = (r.failed_count ?? 0) > 0;
        return (
          <span className={`tabular-nums text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}>
            {progressText(r)}
          </span>
        );
      },
      sortValue: (r) => r.sent_count ?? 0,
      csvValue: (r) => progressText(r),
    },
    {
      key: "dates",
      header: "Queued / sent",
      cell: (r) => (
        <div className="whitespace-nowrap text-[11px] text-muted-foreground">
          <div>{r.queued_at ? formatPHTDisplay(r.queued_at) : "—"}</div>
          {r.sent_at && <div>{formatPHTDisplay(r.sent_at)}</div>}
        </div>
      ),
      sortValue: (r) => r.queued_at ?? "",
      csvValue: (r) => r.queued_at ?? "",
    },
    ...(canManage ? [{
      key: "actions",
      header: "",
      align: "right" as const,
      hideable: false,
      cell: (r: CampaignRow) => {
        const s = statusOf(r.status);
        return (
          <div className="flex items-center justify-end gap-1">
            {isCancellable(s) && (
              <Button
                type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive"
                disabled={cancel.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Cancel "${r.subject_en ?? r.subject_ja}"? ${r.sent_count ?? 0} of ${r.total ?? 0} have already been sent and cannot be recalled.`)) {
                    cancel.mutate(r);
                  }
                }}
              >
                <Ban className="mr-1 h-3.5 w-3.5" /> Cancel
              </Button>
            )}
            {isEditable(s) && (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                onClick={(e) => { e.stopPropagation(); open(toDraft(r)); }}>
                Edit
              </Button>
            )}
          </div>
        );
      },
    }] : []),
  ], [canManage, cancel]);

  return (
    <>
      <Card>
        <CardHeader className="hairline-b">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="h-4 w-4 text-primary" />
                Campaigns {campaigns.data ? `(${rows.length})` : ""}
                {anySending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Newsletters to the subscriber list. The Hub composes and queues; sending runs in the
                background at {SEND_RATE_PER_HOUR} per hour, under the workspace cap the payment
                reminders already use.
              </p>
            </div>
            {canManage && (
              <Button type="button" size="sm" onClick={() => open(emptyCampaign())}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> New campaign
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {campaigns.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : campaigns.isError ? (
            <p className="px-6 py-10 text-sm text-muted-foreground">Couldn't load campaigns.</p>
          ) : rows.length === 0 ? (
            <p className="px-6 py-10 text-sm text-muted-foreground">No campaigns yet.</p>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              searchText={(r) => [r.subject_en ?? "", r.subject_ja ?? ""]}
              csvName="newsletter-campaigns"
              densityKey="cj-newsletter-campaigns-density"
            />
          )}
        </CardContent>
      </Card>

      {/* ── Compose ──────────────────────────────────────────────────── */}
      <Sheet open={!!draft} onOpenChange={(o) => !o && open(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
          {draft && (
            <>
              <SheetHeader className="text-left">
                <SheetTitle>{draft.id ? "Edit campaign" : "New campaign"}</SheetTitle>
              </SheetHeader>

              <div className="mt-4 space-y-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="c-audience">Audience</Label>
                    <Select value={draft.audience} disabled={!canManage}
                      onValueChange={(v) => patch({ audience: v as CampaignAudience })}>
                      <SelectTrigger id="c-audience"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CAMPAIGN_AUDIENCES.map((a) => (
                          <SelectItem key={a} value={a}>
                            {AUDIENCE_LABEL[a]} ({audienceCount(a)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground">
                      {subscribers.isLoading
                        ? "Counting subscribers…"
                        : `Reaches ${draftCount} subscriber${draftCount === 1 ? "" : "s"} — ${estimateText(draftCount)}.`}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="c-post">Featured post (optional)</Label>
                    <Select
                      value={draft.post_slug || "__none"}
                      disabled={!canManage}
                      onValueChange={(v) => patch({ post_slug: v === "__none" ? "" : v })}
                    >
                      <SelectTrigger id="c-post"><SelectValue placeholder="None" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">None</SelectItem>
                        {(posts.data ?? []).map((p) => (
                          <SelectItem key={p.slug} value={p.slug}>{p.title_en}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground">Published posts only.</p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Featured products (optional, up to {MAX_CAMPAIGN_PRODUCTS})</Label>
                  <MultiPick
                    ariaLabel="Featured products"
                    buttonLabel="Add product"
                    placeholder="Search products…"
                    emptyText="No product matches."
                    options={(products.data ?? []).map((p) => ({ id: p.id, label: p.name, hint: p.sku }))}
                    value={draft.product_ids}
                    onChange={(ids) => patch({ product_ids: ids.slice(0, MAX_CAMPAIGN_PRODUCTS) })}
                  />
                  {draft.product_ids.length >= MAX_CAMPAIGN_PRODUCTS && (
                    <p className="text-[11px] text-muted-foreground">
                      That is the maximum — remove one to pick another.
                    </p>
                  )}
                </div>

                {/* ── English ─────────────────────────────────────── */}
                <div className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold">English</h4>
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                      aria-pressed={preview === "en"}
                      onClick={() => setPreview(preview === "en" ? null : "en")}>
                      <Eye className="mr-1 h-3.5 w-3.5" />{preview === "en" ? "Write" : "Preview"}
                    </Button>
                  </div>
                  <Input
                    aria-label="Subject (English)" placeholder="Subject" disabled={!canManage}
                    value={draft.subject_en} onChange={(e) => patch({ subject_en: e.target.value })}
                  />
                  {preview === "en" ? (
                    <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/20 px-3 py-2">
                      <Markdown>{draft.body_en}</Markdown>
                    </div>
                  ) : (
                    <Textarea
                      aria-label="Body (English)" rows={8} className="font-mono text-xs" disabled={!canManage}
                      value={draft.body_en} onChange={(e) => patch({ body_en: e.target.value })}
                      placeholder="**Bold**, - lists, [links](https://…). Blank line between paragraphs."
                    />
                  )}
                </div>

                {/* ── Japanese ────────────────────────────────────── */}
                <div className={`space-y-2 rounded-lg border p-3 ${layawayBlocked ? "border-destructive" : "border-border"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold">Japanese</h4>
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="outline" size="sm" disabled={!canManage || translating}
                        onClick={regenerate}>
                        {translating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                        Regenerate
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"
                        aria-pressed={preview === "ja"}
                        onClick={() => setPreview(preview === "ja" ? null : "ja")}>
                        <Eye className="mr-1 h-3.5 w-3.5" />{preview === "ja" ? "Write" : "Preview"}
                      </Button>
                    </div>
                  </div>
                  <Input
                    aria-label="Subject (Japanese)" lang="ja" placeholder="件名" disabled={!canManage}
                    aria-invalid={layawayBlocked || undefined}
                    value={draft.subject_ja} onChange={(e) => patch({ subject_ja: e.target.value })}
                  />
                  {preview === "ja" ? (
                    <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/20 px-3 py-2">
                      <Markdown>{draft.body_ja}</Markdown>
                    </div>
                  ) : (
                    <Textarea
                      aria-label="Body (Japanese)" lang="ja" rows={8} className="font-mono text-xs"
                      disabled={!canManage} aria-invalid={layawayBlocked || undefined}
                      value={draft.body_ja} onChange={(e) => patch({ body_ja: e.target.value })}
                    />
                  )}
                  {layawayBlocked && (
                    <p role="alert" className="text-xs text-destructive">{LAYAWAY_HINT}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Leave both Japanese fields empty to send in English only.
                  </p>
                </div>

                {errors.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-destructive">
                    {errors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                )}

                {testHtml && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Test email as it was sent</Label>
                    {/* sandbox="" — no scripts, no same-origin. This is rendered
                        email from the function; it is displayed, never trusted. */}
                    <iframe
                      title="Test email preview" sandbox="" srcDoc={testHtml}
                      className="h-80 w-full rounded-md border border-border bg-white"
                    />
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pb-2">
                  <Button type="button" disabled={!canManage || errors.length > 0 || busy}
                    onClick={() => saveDraft.mutate(draft)}>
                    {saveDraft.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save draft
                  </Button>
                  <Button type="button" variant="outline" disabled={!canManage || errors.length > 0 || busy}
                    onClick={() => sendTest.mutate(draft)}>
                    {sendTest.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Eye className="mr-1.5 h-4 w-4" />}
                    Send test to me
                  </Button>
                  <Button type="button" variant="default" className="ml-auto"
                    disabled={!canManage || errors.length > 0 || busy || draftCount === 0}
                    onClick={() => setConfirmSend(draft)}>
                    <Send className="mr-1.5 h-4 w-4" /> Send to list
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => open(null)}>Close</Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Confirm the one irreversible action ──────────────────────── */}
      <AlertDialog open={!!confirmSend} onOpenChange={(o) => !o && setConfirmSend(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this campaign?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {(() => {
                  if (!confirmSend) return null;
                  const audience = ("status" in confirmSend
                    ? ((confirmSend.audience ?? "all") as CampaignAudience)
                    : confirmSend.audience);
                  const n = audienceCount(audience);
                  return (
                    <>
                      <p>
                        It goes to <span className="font-medium text-foreground">{n} subscriber{n === 1 ? "" : "s"}</span>
                        {" "}({AUDIENCE_LABEL[audience]}), taking {estimateText(n)}.
                      </p>
                      <p className="text-muted-foreground">
                        Sending starts in the background. It can be cancelled while it runs, but
                        anything already delivered cannot be recalled.
                      </p>
                    </>
                  );
                })()}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sendToList.isPending}>Keep as draft</AlertDialogCancel>
            <AlertDialogAction
              disabled={sendToList.isPending}
              onClick={(e) => { e.preventDefault(); if (confirmSend) sendToList.mutate(confirmSend); }}
            >
              {sendToList.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
