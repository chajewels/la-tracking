import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock, Globe, ImageOff, Loader2, Lock, Play, RefreshCw, Scissors, Upload } from "lucide-react";
import { toast } from "sonner";
import { formatPHTDisplay } from "@/lib/date-utils";
import { storefrontPreview } from "@/theme/tokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  addTestBatch, almostNothingKept, CUTOUT_LIST_KEY as LIST_KEY, CUTOUT_OVERVIEW_KEY as OVERVIEW_KEY, CUTOUT_PAGE_SIZE,
  CUTOUT_PROVIDER_KEY as PROVIDER_KEY, CUTOUT_TABS_KEY as TABS_KEY, type CutoutFilter, type CutoutMode, type CutoutOverview,
  type CutoutProviderSetting, type CutoutRow, type CutoutTabTotals, DEFAULT_PRICE_USD, describeFlag, estimateCost, FILTERS,
  formatUsd, getOverview, getProvider, getTabTotals, hasTransparency, isCapped, isCompleted, isLocked, isPublishable,
  listCutouts, MODE_TEXT, type PaidReopenAction, parseSkus, PROVIDER_LABEL, PROVIDER_TEXT, type ProviderName, publicUrl,
  refusalText, RETURNED_REASON, review, type ReviewAction, runNow, setProvider, setSettings, STATUS_LABEL, uploadOwnCutout,
} from "@/lib/media-cutouts";
import CutoutViewer, { type ViewerImage } from "@/components/website/CutoutViewer";
import CutoutBulkUpload from "@/components/website/CutoutBulkUpload";

/**
 * Website → Photos: automatic background removal (docs/MEDIA-CUTOUTS.md).
 *
 * Every photo of a PUBLISHED product is queued (keyed by its URL, so the
 * Catalog save's delete-and-reinsert of media rows never loses a verdict);
 * photos of unpublished products wait ("Waiting for publish") and are queued
 * once when the product is published (migration 20261011100000, enforced in
 * the database). The worker runs every minute and obeys the switch here —
 * Off / Test / On, failing to Off — and the monthly limit. Each result gets an
 * automatic verdict; only OK / Auto-fixed / Approved will ever be shown on the
 * website (PR 2). Staff approve, re-run, reject, keep the original or upload
 * their own cut-out here. Completed is final. Everything is
 * manage_website_catalog and audited.
 */

const PAGE = CUTOUT_PAGE_SIZE;

function statusVariant(s: CutoutRow["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (s === "ok" || s === "approved") return "default";
  if (s === "needs_review" || s === "failed") return "destructive";
  if (s === "auto_fixed" || s === "kept_original") return "secondary";
  return "outline";
}

// ---------------------------------------------------------------------------
// Settings: switch, monthly limit, usage, last run, test batch.
// ---------------------------------------------------------------------------
export function MediaCutoutSettingsCard() {
  const qc = useQueryClient();
  const overview = useQuery<CutoutOverview>({
    queryKey: OVERVIEW_KEY, queryFn: getOverview, staleTime: 30_000, refetchInterval: 60_000,
  });
  const data = overview.data;
  const [confirmOn, setConfirmOn] = useState(false);
  const [capDraft, setCapDraft] = useState<string>("");
  const [batchName, setBatchName] = useState("Test 30");
  const [skuText, setSkuText] = useState("");
  const [mainOnly, setMainOnly] = useState(false);
  const [priceDraft, setPriceDraft] = useState<string>("");
  // Absent until migration 20261007100000 runs: the card then assumes the
  // code's default (Photoroom at its list price) for the estimate.
  const providerQ = useQuery<CutoutProviderSetting>({
    queryKey: PROVIDER_KEY, queryFn: getProvider, staleTime: 60_000, retry: false,
  });
  const prov = providerQ.data;
  const provider: ProviderName = prov?.provider ?? "photoroom";
  const price = prov ? prov.price_usd : DEFAULT_PRICE_USD.photoroom;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    qc.invalidateQueries({ queryKey: PROVIDER_KEY });
    qc.invalidateQueries({ queryKey: [LIST_KEY] });
    qc.invalidateQueries({ queryKey: TABS_KEY });
  };

  const save = useMutation({
    mutationFn: (v: { mode: CutoutMode | null; cap: number | null }) => setSettings(v.mode, v.cap, data?.mode ?? null),
    onSuccess: out => {
      toast.success(`Background removal: ${out.mode.toUpperCase()}, up to ${out.cap.toLocaleString()} photos a month. Saved to the audit log.`);
      setCapDraft("");
    },
    onError: e => toast.error(refusalText(e)),
    onSettled: refresh,
  });

  const saveProvider = useMutation({
    mutationFn: (v: { provider: ProviderName | null; price: number | null }) => setProvider(v.provider, v.price, prov?.provider ?? null),
    onSuccess: out => {
      toast.success(`Background removal provider: ${PROVIDER_LABEL[out.provider]}, ${out.price_usd == null ? "price unknown" : `$${out.price_usd} a photo`}. Saved to the audit log.`);
      setPriceDraft("");
    },
    onError: e => toast.error(refusalText(e)),
    onSettled: refresh,
  });

  const run = useMutation({
    mutationFn: runNow,
    onSuccess: out => {
      if (out.mode === "off") toast.info("Background removal is Off — nothing was run.");
      else if (out.skipped) toast.info(`Not run: ${String(out.skipped)}.`);
      else toast.success(`Ran: ${Number(out.submitted ?? 0)} sent, ${Number(out.ready ?? 0)} came back, ${(out.processed as unknown[] | undefined)?.length ?? 0} processed.`);
    },
    onError: e => toast.error(e instanceof Error ? e.message : String(e)),
    onSettled: refresh,
  });

  const batch = useMutation({
    mutationFn: () => addTestBatch(parseSkus(skuText), batchName.trim(), mainOnly),
    onSuccess: out => {
      toast.success(`"${out.batch}": ${out.photos} photos in the batch (${out.queued_new} newly queued).`
        + (out.unknown_skus.length ? ` Not found: ${out.unknown_skus.join(", ")}.` : ""));
      setSkuText("");
    },
    onError: e => toast.error(refusalText(e)),
    onSettled: refresh,
  });

  const capValue = capDraft === "" ? null : Number(capDraft);
  const capValid = capValue !== null && Number.isInteger(capValue) && capValue >= 0 && capValue <= 100_000;
  const usedPct = data && data.cap > 0 ? Math.min(100, Math.round((data.used / data.cap) * 100)) : 0;
  const tick = data?.last_tick ?? null;
  const priceValue = priceDraft === "" ? null : Number(priceDraft);
  const priceValid = priceValue !== null && Number.isFinite(priceValue) && priceValue >= 0 && priceValue <= 10;

  return (
    <Card>
      <CardHeader className="hairline-b">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Scissors className="h-4 w-4 text-primary" />
          Automatic background removal
          {data && (
            <Badge variant={data.mode === "off" ? "secondary" : "default"} data-testid="cutout-mode-badge">
              {data.mode === "off" ? "Off" : data.mode === "test" ? "Test" : "On"}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Every photo of a published product gets a transparent cut-out and a uniform chalk-background version for
          the catalogue — photos of unpublished products wait until the product is published. The original is never
          changed. Photos are checked automatically; anything doubtful waits for you below, and only OK, auto-fixed
          and approved photos will be used on the website.
        </p>
      </CardHeader>
      <CardContent className="space-y-5 pt-5 text-sm">
        {overview.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        )}
        {overview.isError && (
          <p className="text-muted-foreground" data-testid="cutout-unavailable">
            Background removal is not available yet. It appears once its migration has been run.
          </p>
        )}
        {data && (
          <>
            <div className="space-y-2">
              <Label>Switch</Label>
              <ToggleGroup
                type="single"
                value={data.mode}
                disabled={save.isPending || !data.can_change}
                onValueChange={v => {
                  if (!v || v === data.mode) return;
                  if (v === "on") setConfirmOn(true);
                  else save.mutate({ mode: v as CutoutMode, cap: null });
                }}
                className="justify-start"
                aria-label="Background removal switch"
              >
                <ToggleGroupItem value="off" aria-label="Off">Off</ToggleGroupItem>
                <ToggleGroupItem value="test" aria-label="Test">Test</ToggleGroupItem>
                <ToggleGroupItem value="on" aria-label="On">On</ToggleGroupItem>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground" data-testid="cutout-mode-text">{MODE_TEXT[data.mode]}</p>
              {data.updated_by_name && (
                <p className="text-xs text-muted-foreground">
                  Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name}.
                </p>
              )}
            </div>

            <div className="space-y-2" data-testid="cutout-provider">
              <Label htmlFor="cutout-provider-select">Provider</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={provider}
                  disabled={!prov || saveProvider.isPending || !data.can_change}
                  onValueChange={v => { if (v !== provider) saveProvider.mutate({ provider: v as ProviderName, price: null }); }}
                >
                  <SelectTrigger id="cutout-provider-select" className="h-8 w-56" aria-label="Background removal provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PROVIDER_LABEL) as ProviderName[]).map(p => (
                      <SelectItem key={p} value={p}>{PROVIDER_LABEL[p]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground tabular-nums" data-testid="cutout-price">
                  {price == null ? "Price per photo unknown" : `$${price} a photo`}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{PROVIDER_TEXT[provider]}</p>
              {prov ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="cutout-price-input" className="text-xs">Price per photo (US$, for the estimate)</Label>
                  <Input
                    id="cutout-price-input" inputMode="decimal" className="h-8 w-24" placeholder={price == null ? "—" : String(price)}
                    value={priceDraft} onChange={e => setPriceDraft(e.target.value.replace(/[^0-9.]/g, ""))}
                    disabled={!data.can_change}
                  />
                  <Button size="sm" variant="outline" disabled={!priceValid || saveProvider.isPending}
                          onClick={() => saveProvider.mutate({ provider: null, price: priceValue })}>
                    Save price
                  </Button>
                </div>
              ) : !providerQ.isLoading && (
                <p className="text-xs text-muted-foreground" data-testid="cutout-provider-missing">
                  The provider setting appears once the Photoroom migration has been run.
                </p>
              )}
              {prov?.updated_by_name && (
                <p className="text-xs text-muted-foreground">
                  Last changed {prov.updated_at ? formatPHTDisplay(prov.updated_at) : ""} by {prov.updated_by_name}.
                </p>
              )}
            </div>

            <div className="space-y-2" data-testid="cutout-usage">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Label>This month ({data.month})</Label>
                <span className="tabular-nums">{data.used.toLocaleString()} of {data.cap.toLocaleString()} photos</span>
              </div>
              <Progress value={usedPct} aria-label="Photos sent this month" />
              <p className="text-xs text-muted-foreground" data-testid="cutout-cost">
                Estimated cost: {formatUsd(estimateCost(data.used, price))} so far this month
                {" "}({data.used.toLocaleString()} × {price == null ? "?" : `$${price}`});
                {" "}at most {formatUsd(estimateCost(data.cap, price))} at the limit. An estimate — the provider's own
                dashboard is the bill.
              </p>
              <p className="text-xs text-muted-foreground">
                A bell rings at 80%. At the limit, sending pauses until next month; nothing is lost.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="cutout-cap" className="text-xs">Monthly limit</Label>
                <Input
                  id="cutout-cap" inputMode="numeric" className="h-8 w-28" placeholder={String(data.cap)}
                  value={capDraft} onChange={e => setCapDraft(e.target.value.replace(/[^0-9]/g, ""))}
                  disabled={!data.can_change}
                />
                <Button size="sm" variant="outline" disabled={!capValid || save.isPending}
                        onClick={() => save.mutate({ mode: null, cap: capValue })}>
                  Save limit
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" data-testid="cutout-last-run">
              <Button size="sm" variant="outline" onClick={() => run.mutate()} disabled={run.isPending || data.mode === "off"}>
                {run.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
                Run now
              </Button>
              <span>
                {data.last_tick_at
                  ? <>Last run {formatPHTDisplay(data.last_tick_at)}{tick ? ` — ${Number(tick.submitted ?? 0)} sent, ${Number(tick.ready ?? 0)} back, ${Number(tick.errors ?? 0)} errors` : ""}.</>
                  : <>Not run yet. It runs every minute while the switch is on.</>}
              </span>
              {data.cpu_ms_p95 !== null && (
                <span>Processing time p95 {Math.round(Number(data.cpu_ms_p95))} ms (limit 2,000){data.cpu_fallbacks ? `; ${data.cpu_fallbacks} stored as cut-out only` : ""}.</span>
              )}
            </div>

            <div className="space-y-2 rounded-md border border-border p-3" data-testid="cutout-test-batch">
              <Label>Test batch</Label>
              <p className="text-xs text-muted-foreground">
                In Test mode only photos in a test batch are sent. Paste SKUs (up to 100), then switch to Test and review
                them under “Test batch”.
              </p>
              <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
                <Input aria-label="Batch name" value={batchName} maxLength={60} onChange={e => setBatchName(e.target.value)} />
                <Textarea aria-label="SKUs" rows={2} placeholder="AL112, AL3, AL123, R3341 …" value={skuText}
                          onChange={e => setSkuText(e.target.value)} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Checkbox id="cutout-main-only" checked={mainOnly} onCheckedChange={v => setMainOnly(v === true)} />
                  <Label htmlFor="cutout-main-only" className="text-xs font-normal">Main photo only</Label>
                </div>
                <Button size="sm" variant="outline" onClick={() => batch.mutate()}
                        disabled={batch.isPending || parseSkus(skuText).length === 0 || !batchName.trim()}>
                  Add to test batch ({parseSkus(skuText).length} SKUs)
                </Button>
              </div>
              {data.test_batches.length > 0 && (
                <ul className="text-xs text-muted-foreground">
                  {data.test_batches.map(b => (
                    <li key={b.name}>“{b.name}”: {b.done} of {b.count} photos finished</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmOn} onOpenChange={setConfirmOn}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn background removal on for every photo?</AlertDialogTitle>
            <AlertDialogDescription>
              Every queued photo of a published product will be sent to {PROVIDER_LABEL[provider]} — main photos first — up to
              {" "}{data?.cap.toLocaleString()} a month (at most about {formatUsd(estimateCost(data?.cap ?? 0, price))}). Doubtful
              results wait here for review; nothing unapproved is shown on the website.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => save.mutate({ mode: "on", cap: null })}>Turn on</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Review: Original → cut-out on the hero stage → ivory catalogue version.
// ---------------------------------------------------------------------------
function Thumb({ src, label, bg, onOpen }: { src: string | null; label: string; bg?: string; onOpen?: () => void }) {
  const box = (
    <div
      className="flex aspect-square items-center justify-center overflow-hidden rounded border border-border"
      style={{ backgroundColor: bg }}
    >
      {src
        ? <img src={src} alt={label} loading="lazy" className="h-full w-full object-contain" />
        : <ImageOff className="h-5 w-5 text-muted-foreground" aria-label={`${label}: none`} />}
    </div>
  );
  return (
    <figure className="min-w-0 space-y-1">
      {src && onOpen
        ? (
          <button type="button" onClick={onOpen} aria-label={`Open ${label} large`}
            className="block w-full cursor-zoom-in rounded transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {box}
          </button>
        )
        : box}
      <figcaption className="truncate text-[11px] text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

function CutoutItem({ row, onAct, busy, isAdmin }: {
  row: CutoutRow;
  onAct: (row: CutoutRow, action: ReviewAction) => void;
  busy: boolean;
  isAdmin: boolean;
}) {
  const inFlight = ["submitted", "ready", "processing"].includes(row.job_state);
  // CUT ONCE (migration 20261010100000) + PUBLISH GATE (20261011100000):
  // Completed (incl. Kept original) is final for everyone; Rejected is locked
  // (an admin can try once more); a photo at its paid-call limit needs the
  // owner; a photo of an unpublished product waits. The database enforces all
  // of it.
  const completed = isCompleted(row.status);
  const kept = row.status === "kept_original";
  const rejected = row.status === "rejected";
  const waiting = row.job_state === "waiting";
  const keepFirst = !completed && !inFlight && almostNothingKept(row.flags);
  const held = !!row.hold_reason;
  // A provider / account error sent it back (migration 20261012100000).
  const returned = !held && row.status !== "failed" && !!row.last_error && !!row.error_kind && row.error_kind !== "photo"
    && ["queued", "submitted", "ready"].includes(row.job_state);
  const capped = isCapped(row);
  const paid = row.paid_calls ?? 0;
  const limit = row.paid_call_limit ?? 2;
  const rerunCut = row.last_rerun?.cutout_path ? publicUrl(String(row.last_rerun.cutout_path)) : null;
  const cutoutUrl = publicUrl(row.cutout_path);
  const catalogUrl = publicUrl(row.catalog_small_path ?? row.catalog_path);
  // The large viewer shows full-size files: the catalogue's big version when
  // there is one, never the small thumbnail.
  const catalogFull = publicUrl(row.catalog_path ?? row.catalog_small_path);
  const [viewer, setViewer] = useState<string | null>(null);
  const results: ViewerImage[] = [
    ...(cutoutUrl ? [{ key: "cutout", label: "Cut-out", src: cutoutUrl, bg: storefrontPreview.heroStage }] : []),
    ...(catalogFull ? [{ key: "catalog", label: "Catalogue", src: catalogFull, bg: storefrontPreview.chalk }] : []),
    ...(rerunCut ? [{ key: "rerun", label: "Parked re-run", src: rerunCut, bg: storefrontPreview.heroStage }] : []),
  ];
  const original: ViewerImage | null = row.source_url ? { key: "original", label: "Original", src: row.source_url } : null;
  const title = row.product ? `${row.product.sku} · ${row.product.name}` : "Photo no longer used by a product";
  return (
    <li className="space-y-3 py-4" data-testid="cutout-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.product ? `${row.product.sku} · ${row.product.name}` : "Photo no longer used by a product"}</span>
        <Badge variant={statusVariant(row.status)}>{STATUS_LABEL[row.status]}</Badge>
        {inFlight && <Badge variant="outline">Processing…</Badge>}
        {waiting && (
          <Badge variant="outline" className="gap-1" data-testid="cutout-waiting"><Clock className="h-3 w-3" /> Waiting for publish</Badge>
        )}
        {row.job_state === "queued" && row.status !== "pending" && <Badge variant="outline">Queued again</Badge>}
        {row.test_batch && <Badge variant="outline">{row.test_batch}</Badge>}
        {isLocked(row.status) && !inFlight && row.job_state !== "queued" && (
          <Badge variant="outline" className="gap-1" data-testid="cutout-locked"><Lock className="h-3 w-3" /> Locked</Badge>
        )}
        {held && <Badge variant="destructive">Needs owner</Badge>}
        {typeof row.published === "boolean" && (
          <Badge variant={row.published ? "secondary" : "outline"} className="gap-1" data-testid="cutout-published">
            <Globe className="h-3 w-3" /> {row.published ? "Product published" : "Product not published"}
          </Badge>
        )}
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="cutout-paid-calls">
          Paid calls: {paid} of {limit}
        </span>
        <span className="text-xs text-muted-foreground">
          {row.source_kind === "page365" ? "Page365 photo" : "Staff photo"}
          {row.source_w && row.source_h ? ` · ${row.source_w} × ${row.source_h} px` : ""}
          {row.product_count > 1 ? ` · used by ${row.product_count} products` : ""}
          {row.priority === 0 ? " · main photo" : ""}
        </span>
      </div>

      <div className="grid max-w-md grid-cols-3 gap-2">
        <Thumb src={row.source_url} label="Original" onOpen={() => setViewer(results[0]?.key ?? "original")} />
        <Thumb src={cutoutUrl} label="Cut-out (hero)" bg={storefrontPreview.heroStage} onOpen={() => setViewer("cutout")} />
        <Thumb src={catalogUrl} label="Catalogue" bg={storefrontPreview.chalk} onOpen={() => setViewer("catalog")} />
      </div>
      <CutoutViewer
        open={viewer !== null}
        onOpenChange={o => { if (!o) setViewer(null); }}
        title={title}
        original={original}
        results={results}
        initialKey={viewer ?? undefined}
      />

      {row.flags.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs" data-testid="cutout-flags">
          {row.flags.map(f => <li key={f}>{describeFlag(f)}</li>)}
        </ul>
      )}
      {row.output_kind === "cutout_only" && (
        <p className="text-xs text-muted-foreground">Stored as cut-out only (the processing limit was reached once); the website draws the chalk background itself.</p>
      )}
      {row.last_rerun && (
        <p className="text-xs text-warning">
          A re-run came back as “{STATUS_LABEL[(row.last_rerun.status as CutoutRow["status"]) ?? "failed"] ?? row.last_rerun.status}”
          {row.last_rerun.flags?.length ? ` (${row.last_rerun.flags.map(describeFlag).join("; ")})` : ""} — the current version is kept.
          {rerunCut && <> <button type="button" className="underline" onClick={() => setViewer("rerun")}>See the re-run</button>.</>}
        </p>
      )}
      {held && <p className="text-xs text-destructive" data-testid="cutout-hold-reason">Needs owner: {row.hold_reason}</p>}
      {waiting && (
        <p className="text-xs text-muted-foreground">
          Not sent: its product is not published. It is cut once, automatically, when the product is published — no cost until then.
        </p>
      )}
      {keepFirst && (
        <p className="text-xs text-warning" data-testid="cutout-keep-hint">
          Almost nothing of the piece was kept. Keeping the original photo is usually the right call.
        </p>
      )}
      {returned && (
        <p className="text-xs text-muted-foreground" data-testid="cutout-returned">
          Sent back automatically — {RETURNED_REASON[row.error_kind as keyof typeof RETURNED_REASON]}. Not the photo&apos;s
          fault; it is tried again by itself. Last error: {row.last_error}
        </p>
      )}
      {row.last_error && row.status === "failed" && !held && <p className="text-xs text-muted-foreground">Last error: {row.last_error}</p>}
      {row.review_note && <p className="text-xs text-muted-foreground">Note: {row.review_note}</p>}

      <div className="flex flex-wrap gap-2" data-testid="cutout-actions">
        {keepFirst && (
          <Button size="sm" disabled={busy} onClick={() => onAct(row, "keep_original")}>
            Keep original
          </Button>
        )}
        {!held && !rejected && !kept && (
          <Button size="sm" variant={keepFirst ? "outline" : "default"}
                  disabled={busy || inFlight || !row.cutout_path || row.status === "approved"}
                  onClick={() => onAct(row, "approve")}>
            Approve
          </Button>
        )}
        {!held && !isLocked(row.status) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy || inFlight || capped}
                      title={capped ? "This photo has used all its paid calls" : undefined}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" /> Re-run <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onAct(row, "rerun")}>Re-run</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAct(row, "rerun_high_detail")}>Re-run in high detail</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!rejected && !kept && !held && (
          <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "reject")}>
            Reject
          </Button>
        )}
        {!completed && !keepFirst && (
          <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "keep_original")}>
            Keep original
          </Button>
        )}
        {(!completed || kept) && (
          <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "own_cutout")}>
            <Upload className="mr-1 h-3.5 w-3.5" /> Upload my own cut-out
          </Button>
        )}
        {row.last_rerun?.cutout_path && !rejected && (
          <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "use_rerun")}>
            Use the re-run
          </Button>
        )}
        {isAdmin && rejected && (
          <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "retry_once")}>
            Try once more
          </Button>
        )}
        {isAdmin && held && !isLocked(row.status) && (
          <Button size="sm" variant="outline" disabled={busy || inFlight} onClick={() => onAct(row, "override_cap")}>
            Allow one more paid call
          </Button>
        )}
      </div>
      {rejected && (
        <p className="text-[11px] text-muted-foreground">
          The website shows the normal photo — nothing more to do. You can upload your own cut-out for free.
        </p>
      )}
      {kept && (
        <p className="text-[11px] text-muted-foreground" data-testid="cutout-kept">
          Kept original — the website shows the normal photo. Completed: it is never cut or sent again. You can still
          upload your own cut-out for free.
        </p>
      )}
      {completed && !kept && (
        <p className="text-[11px] text-muted-foreground" data-testid="cutout-final">Completed is final — it is never sent again.</p>
      )}
      {!isAdmin && (rejected || held) && (
        <p className="text-[11px] text-muted-foreground" data-testid="cutout-admin-only">
          {held ? "Only an admin can allow another paid call." : "Locked. Only an admin can try it once more."}
        </p>
      )}
      {!held && !isLocked(row.status) && capped && (
        <p className="text-[11px] text-muted-foreground">This photo has used all its paid calls; Re-run is off.</p>
      )}
      {isPublishable(row.status) && (
        <p className="text-[11px] text-muted-foreground">Will be used on the website.</p>
      )}
    </li>
  );
}

export function MediaCutoutReviewCard() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<CutoutFilter>("needs_review");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [dialog, setDialog] = useState<{ row: CutoutRow; action: "reject" | "own_cutout" | "keep_original" } | null>(null);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [paidConfirm, setPaidConfirm] = useState<{ row: CutoutRow; action: PaidReopenAction } | null>(null);

  const list = useQuery({
    queryKey: [LIST_KEY, filter, search, page],
    queryFn: () => listCutouts(filter, search, PAGE, page * PAGE),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const overview = useQuery<CutoutOverview>({ queryKey: OVERVIEW_KEY, queryFn: getOverview, staleTime: 30_000 });
  const counts = overview.data?.status_counts ?? {};
  // Absent until migration 20261010100000 runs: tabs fall back to the status counts, nobody is admin here.
  const totals = useQuery<CutoutTabTotals>({ queryKey: TABS_KEY, queryFn: getTabTotals, staleTime: 30_000, retry: false });
  const tabs = totals.data && Object.keys(totals.data.tabs).length > 0 ? totals.data.tabs : undefined;
  const isAdmin = totals.data?.is_admin === true;
  const price = totals.data ? totals.data.price_usd : null;
  const providerName = PROVIDER_LABEL[totals.data?.provider ?? "photoroom"];
  const activeTotals = tabs?.[filter];

  const act = useMutation({
    mutationFn: async (v: { row: CutoutRow; action: ReviewAction; note?: string; file?: File | null }) => {
      let ownUrl: string | undefined;
      if (v.action === "own_cutout") {
        if (!v.file) throw new Error("Choose a PNG or WebP file.");
        if (!(await hasTransparency(v.file))) throw new Error("That file has no transparent background. Upload a PNG or WebP cut-out.");
        ownUrl = await uploadOwnCutout(v.file);
      }
      return review(v.row.source_url, v.action, { note: v.note, ownUrl, expected: v.row.status });
    },
    onSuccess: (out, v) => {
      const words: Record<ReviewAction, string> = {
        approve: "Approved.", reject: "Rejected — the website keeps the original photo.",
        rerun: "Queued again. The current version stays until the new one passes.",
        rerun_high_detail: "Queued again in high detail. The current version stays until the new one passes.",
        use_rerun: "The re-run is now the approved version.",
        own_cutout: "Uploaded. It is processed on the next run (within 2 minutes) and lands approved.",
        keep_original: "Kept the original photo. It is completed and will never be cut — no cost.",
        retry_once: "Queued for one more paid try. The website keeps the normal photo unless the new cut-out passes.",
        override_cap: "One more paid call allowed. It is sent on the next run.",
      };
      toast.success(out.waiting_for_publish
        ? "Saved. Its product is not published, so it waits — it is sent once the product is published."
        : words[v.action]);
      setDialog(null); setPaidConfirm(null); setNote(""); setFile(null);
    },
    onError: e => toast.error(refusalText(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [LIST_KEY] });
      qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      qc.invalidateQueries({ queryKey: TABS_KEY });
    },
  });

  const onAct = (row: CutoutRow, action: ReviewAction) => {
    if (action === "reject" || action === "own_cutout" || action === "keep_original") {
      setNote(""); setFile(null); setDialog({ row, action }); return;
    }
    if (action === "retry_once" || action === "override_cap") {
      setNote(""); setPaidConfirm({ row, action }); return;
    }
    act.mutate({ row, action });
  };
  const costText = price == null ? "unknown — set the price per photo above" : `about $${price}`;
  const PAID_TITLE: Record<PaidReopenAction, string> = {
    retry_once: "Try this rejected photo once more?",
    override_cap: "Allow one more paid call?",
  };
  const paidWhy = (c: { row: CutoutRow; action: PaidReopenAction }) => {
    const paid = c.row.paid_calls ?? 0;
    if (c.action === "retry_once") return "It was rejected. The website keeps the normal photo unless the new cut-out passes.";
    return `It stopped after ${paid} paid call${paid === 1 ? "" : "s"}, the limit for one photo.`;
  };

  const total = list.data?.total ?? 0;
  const rows = list.data?.rows ?? [];

  return (
    <Card>
      <CardHeader className="hairline-b">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">Photos to check</CardTitle>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setBulkOpen(true)}>
            <Upload className="h-3.5 w-3.5" /> Upload from Photoroom
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Original → cut-out on the dark hero stage → uniform catalogue version. Approve to use it, Keep original to
          leave the photo uncut (free, final), Reject, Re-run to try again, or upload your own cut-out. Only photos of
          published products are cut and shown here — a photo of an unpublished product appears once its product is
          published. Every photo is cut once: Completed is final, Rejected is locked, and a photo stops after 2 paid
          calls.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 pt-4 text-sm">
        {overview.data && (
          <p className="text-xs tabular-nums text-muted-foreground" data-testid="cutout-month-usage">
            This month: {overview.data.used.toLocaleString()} of {overview.data.cap.toLocaleString()} paid calls
            {totals.data ? ` · each photo is cut once, at most ${totals.data.per_photo_limit} paid calls` : ""}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter photos">
          {FILTERS.map(f => {
            const n = tabs ? tabs[f.value]?.count : f.value in counts ? counts[f.value as keyof typeof counts] : undefined;
            return (
              <Button key={f.value} size="sm" role="tab" aria-selected={filter === f.value}
                      variant={filter === f.value ? "default" : "outline"}
                      onClick={() => { setFilter(f.value); setPage(0); }}>
                {f.label}{typeof n === "number" ? ` (${n})` : ""}
              </Button>
            );
          })}
        </div>
        {activeTotals && (
          <p className="text-xs tabular-nums text-muted-foreground" data-testid="cutout-tab-totals">
            {FILTERS.find(f => f.value === filter)?.label}: {activeTotals.count.toLocaleString()} photo{activeTotals.count === 1 ? "" : "s"}
            {activeTotals.kept_original ? ` (${activeTotals.kept_original.toLocaleString()} kept original)` : ""}
            {" "}· {activeTotals.paid_calls.toLocaleString()} paid call{activeTotals.paid_calls === 1 ? "" : "s"}
            {price != null ? ` (about $${(Math.round(activeTotals.paid_calls * price * 100) / 100).toFixed(2)})` : ""}
          </p>
        )}
        <Input aria-label="Search by SKU or name" placeholder="Search SKU, name or batch" className="h-8 max-w-xs"
               value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />

        {list.isLoading && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
        {list.isError && <p className="text-muted-foreground">{refusalText(list.error)}</p>}
        {filter === "queue" && (
          <p className="text-xs text-muted-foreground">
            Only photos of published products are in the queue. A photo the provider refused (no credits, rate limit,
            outage) comes back here by itself — it is never marked Failed.
          </p>
        )}
        {filter === "failed" && (
          <p className="text-xs text-muted-foreground" data-testid="cutout-failed-help">
            Only real photo problems. Provider and account errors are never Failed: those photos go back to the queue
            by themselves.
          </p>
        )}
        {list.data && rows.length === 0 && (
          <p className="py-6 text-center text-muted-foreground" data-testid="cutout-empty">Nothing here.</p>
        )}
        <ul className="divide-y divide-border">
          {rows.map(r => <CutoutItem key={r.source_url} row={r} onAct={onAct} busy={act.isPending} isAdmin={isAdmin} />)}
        </ul>
        {total > PAGE && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
              <Button size="sm" variant="outline" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(p => p + 1)}>Next</Button>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={!!dialog} onOpenChange={o => { if (!o) setDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.action === "reject" ? "Reject this cut-out?"
                : dialog?.action === "keep_original" ? "Keep the original photo?" : "Upload your own cut-out"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.action === "reject"
                ? "The website keeps showing the original photo. You can re-run or upload your own later."
                : dialog?.action === "keep_original"
                  ? "The photo stays uncut and the website shows the normal photo. It moves to Completed as “Kept original”, is never sent again, and costs nothing."
                  : "A PNG or WebP with a transparent background. It gets the same chalk catalogue version and is approved."}
            </DialogDescription>
          </DialogHeader>
          {dialog?.action === "own_cutout" && (
            <Input type="file" accept="image/png,image/webp" aria-label="Cut-out file"
                   onChange={e => setFile(e.target.files?.[0] ?? null)} />
          )}
          <Textarea aria-label="Note" placeholder="Note (optional)" rows={2} value={note} onChange={e => setNote(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button disabled={act.isPending || (dialog?.action === "own_cutout" && !file)}
                    onClick={() => dialog && act.mutate({ row: dialog.row, action: dialog.action, note, file })}>
              {act.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {dialog?.action === "reject" ? "Reject" : dialog?.action === "keep_original" ? "Keep original" : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!paidConfirm} onOpenChange={o => { if (!o) setPaidConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{paidConfirm ? PAID_TITLE[paidConfirm.action] : ""}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2" data-testid="cutout-paid-confirm">
                {paidConfirm && <p>{paidWhy(paidConfirm)}</p>}
                <p>
                  This sends it to {providerName} <strong>once</strong>: 1 paid call, {costText}. If that call fails it is
                  not retried; the photo waits under Needs owner.
                </p>
                {paidConfirm && (
                  <p className="tabular-nums">
                    Paid calls for this photo so far: {paidConfirm.row.paid_calls ?? 0}. Recorded in the audit log.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea aria-label="Reason" placeholder="Reason (optional)" rows={2} value={note} onChange={e => setNote(e.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={act.isPending}
                               onClick={() => paidConfirm && act.mutate({ row: paidConfirm.row, action: paidConfirm.action, note })}>
              {paidConfirm?.action === "override_cap" ? "Allow 1 paid call" : "Send once (1 paid call)"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CutoutBulkUpload open={bulkOpen} onOpenChange={setBulkOpen} />
    </Card>
  );
}
