import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageOff, Lock } from "lucide-react";
import { toast } from "sonner";
import { formatPHTDisplay } from "@/lib/date-utils";
import { storefrontPreview } from "@/theme/tokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  describeHeroFlag, getHeroOverview, HERO_FILTERS, HERO_LIST_KEY, HERO_MODE_TEXT, HERO_OVERVIEW_KEY, HERO_PAGE_SIZE,
  HERO_STATUS_LABEL, heroActions, heroCutoutUrl, heroRefusalText, type HeroFilter, type HeroMode, type HeroOverview,
  type HeroRow, listHeroCutouts, reviewHeroCutout, setHeroMode,
} from "@/lib/hero-cutouts";
import { HeroCutoutViewer } from "@/components/website/HeroCutoutViewer";

/**
 * Website → Photos → Hero cut-outs (docs/HERO-CUTOUTS.md).
 *
 * The storefront hero shows only cut-outs made by the original tool
 * (BiRefNet-general via rembg), cut by the storefront's scheduled workflow
 * and kept here, apart from Photoroom's product cut-outs (the cards above).
 * Every new one waits for an admin's approval; the automatic go-live switch
 * exists and ships Off ("Approve first"). An admin can reject any cut-out at
 * any time, including a live one. Staff with the catalogue permission see the
 * list; the buttons are an admin's only (checked again in SQL, audited).
 */

function statusVariant(s: HeroRow["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (s === "approved") return "default";
  if (s === "needs_review" || s === "failed") return "destructive";
  if (s === "ok" || s === "auto_fixed") return "secondary";
  return "outline";
}

function Thumb({ src, label, bg, onOpen, openLabel }: {
  src: string | null; label: string; bg?: string; onOpen?: () => void; openLabel?: string;
}) {
  const inner = src
    ? <img src={src} alt={label} loading="lazy" className="h-full w-full object-contain" />
    : <ImageOff className="h-5 w-5 text-muted-foreground" aria-label={`${label}: none`} />;
  const box = "flex aspect-square w-full items-center justify-center overflow-hidden rounded border border-border";
  return (
    <figure className="min-w-0 space-y-1">
      {onOpen ? (
        // Click, tap or Enter opens the zoom viewer (HeroCutoutViewer).
        <button type="button" onClick={onOpen} aria-label={openLabel} data-testid="hero-thumb-open"
                className={`${box} cursor-zoom-in transition-shadow hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                style={{ backgroundColor: bg }}>
          {inner}
        </button>
      ) : (
        <div className={box} style={{ backgroundColor: bg }}>{inner}</div>
      )}
      <figcaption className="truncate text-[11px] text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

function HeroItem({ row, canReview, busy, onAct, onOpen }: {
  row: HeroRow;
  canReview: boolean;
  busy: boolean;
  onAct: (row: HeroRow, action: "approve" | "reject") => void;
  onOpen: () => void;
}) {
  const can = heroActions(row);
  return (
    <li className="space-y-3 py-4" data-testid="hero-cutout-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.product ? `${row.product.sku} · ${row.product.name}` : "Photo no longer used by a product"}</span>
        <Badge variant={statusVariant(row.status)}>{HERO_STATUS_LABEL[row.status]}</Badge>
        {row.auto_approved && <Badge variant="outline">Went live automatically</Badge>}
        <span className="text-xs text-muted-foreground">
          {row.source_width && row.source_height ? `${row.source_width} × ${row.source_height} px` : ""}
        </span>
      </div>
      <div className="grid max-w-xs grid-cols-2 gap-2">
        <Thumb src={row.source_url} label="Original" onOpen={onOpen}
               openLabel={`Open the original of ${row.product?.sku ?? "this photo"} in the zoom viewer`} />
        <Thumb src={heroCutoutUrl(row)} label="Hero cut-out" bg={storefrontPreview.heroStage} onOpen={onOpen}
               openLabel={`Open the hero cut-out of ${row.product?.sku ?? "this photo"} in the zoom viewer`} />
      </div>
      {row.flags.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs" data-testid="hero-cutout-flags">
          {row.flags.map(f => <li key={f}>{describeHeroFlag(f)}</li>)}
        </ul>
      )}
      {row.review_note && <p className="text-xs text-muted-foreground">Note: {row.review_note}</p>}
      {canReview ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !can.approve} onClick={() => onAct(row, "approve")}>Approve</Button>
          <Button size="sm" variant="outline" disabled={busy || !can.reject} onClick={() => onAct(row, "reject")}>
            {row.status === "approved" ? "Reject (take off the hero)" : "Reject"}
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="hero-cutout-readonly">
          <Lock className="h-3 w-3" /> Only an admin can approve or reject.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {row.status === "approved" ? "On the website hero." : "Not on the website: the hero shows the whole photo."}
      </p>
    </li>
  );
}

export function HeroCutoutsCard() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<HeroFilter>("waiting");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [confirm, setConfirm] = useState<null | { kind: "mode"; mode: HeroMode } | { kind: "reject-live"; row: HeroRow; fromViewer: boolean }>(null);
  // The zoom viewer: the photo it shows, or "the first/last row of the page
  // being loaded" while prev/next crosses a page.
  const [viewer, setViewer] = useState<null | { url: string } | { edge: "first" | "last" }>(null);
  const lastShown = useRef<HeroRow | null>(null);

  const overview = useQuery<HeroOverview>({ queryKey: HERO_OVERVIEW_KEY, queryFn: getHeroOverview, staleTime: 30_000 });
  const list = useQuery({
    queryKey: [HERO_LIST_KEY, filter, search, page],
    queryFn: () => listHeroCutouts(filter, search, HERO_PAGE_SIZE, page * HERO_PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: HERO_OVERVIEW_KEY }),
    qc.invalidateQueries({ queryKey: [HERO_LIST_KEY] }),
  ]);

  const act = useMutation({
    mutationFn: (v: { row: HeroRow; action: "approve" | "reject" }) => reviewHeroCutout(v.row, v.action),
    // Awaited, so a viewer decision moves on from the refreshed list.
    onSuccess: async (_o, v) => {
      toast.success(v.action === "approve" ? "Approved — it goes on the hero. Saved to the audit log." : "Rejected — the hero shows the whole photo. Saved to the audit log.");
      await refresh();
    },
    onError: e => { toast.error(heroRefusalText(e)); refresh(); },
  });
  const mode = useMutation({
    mutationFn: (m: HeroMode) => setHeroMode(m, overview.data?.mode ?? "approve"),
    onSuccess: out => {
      toast.success(out.mode === "auto" ? "Hero cut-outs now go live automatically. Saved to the audit log." : "Hero cut-outs now wait for approval. Saved to the audit log.");
      refresh();
    },
    onError: e => { toast.error(heroRefusalText(e)); refresh(); },
  });

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const hasNextPage = (page + 1) * HERO_PAGE_SIZE < total;

  /**
   * After a decision in the viewer, show the next item of the (refreshed)
   * list: the row after the decided one if it is still listed, else the row
   * that moved into its place (it left the filter), else the next page.
   */
  const advanceFrom = (acted: HeroRow, oldIndex: number) => {
    const now = qc.getQueryData<{ total: number; rows: HeroRow[] }>([HERO_LIST_KEY, filter, search, page]);
    const fresh = now?.rows ?? [];
    const more = (page + 1) * HERO_PAGE_SIZE < (now?.total ?? 0);
    const j = fresh.findIndex(r => r.source_url === acted.source_url);
    const next = j >= 0 ? fresh[j + 1] : fresh[oldIndex];
    if (next) { setViewer({ url: next.source_url }); return; }
    if (more) { setPage(p => p + 1); setViewer({ edge: "first" }); return; }
    if (j >= 0) return; // the last one, still listed: stay on it
    if (fresh.length) { setViewer({ url: fresh[fresh.length - 1].source_url }); return; }
    if (page > 0) { setPage(p => p - 1); setViewer({ edge: "last" }); return; }
    setViewer(null); // nothing left to check
  };
  const run = (row: HeroRow, action: "approve" | "reject", fromViewer: boolean) => {
    const oldIndex = rows.findIndex(r => r.source_url === row.source_url);
    act.mutate({ row, action }, fromViewer ? { onSuccess: () => advanceFrom(row, oldIndex) } : undefined);
  };
  const perform = (row: HeroRow, action: "approve" | "reject", fromViewer: boolean) => {
    if (action === "reject" && row.status === "approved") setConfirm({ kind: "reject-live", row, fromViewer });
    else run(row, action, fromViewer);
  };
  const onAct = (row: HeroRow, action: "approve" | "reject") => perform(row, action, false);

  // Prev/next crossed a page: once that page has loaded, show its first/last row.
  useEffect(() => {
    if (!viewer || !("edge" in viewer) || !list.data || list.isPlaceholderData || list.isFetching) return;
    const r = viewer.edge === "first" ? list.data.rows[0] : list.data.rows[list.data.rows.length - 1];
    setViewer(r ? { url: r.source_url } : null);
  }, [viewer, list.data, list.isPlaceholderData, list.isFetching]);

  const viewIndex = viewer && "url" in viewer ? rows.findIndex(r => r.source_url === viewer.url) : -1;
  const viewRow = viewIndex >= 0 ? rows[viewIndex] : null;
  if (viewRow) lastShown.current = viewRow;
  // While a page loads (or a decided row leaves the list) keep showing the last one.
  const shownRow = viewRow ?? (viewer ? lastShown.current : null);
  const canPrev = viewIndex > 0 || (viewIndex === 0 && page > 0);
  const canNext = viewIndex >= 0 && (viewIndex < rows.length - 1 || hasNextPage);
  const goPrev = () => {
    if (viewIndex > 0) setViewer({ url: rows[viewIndex - 1].source_url });
    else if (page > 0) { setPage(p => p - 1); setViewer({ edge: "last" }); }
  };
  const goNext = () => {
    if (viewIndex >= 0 && viewIndex < rows.length - 1) setViewer({ url: rows[viewIndex + 1].source_url });
    else if (hasNextPage) { setPage(p => p + 1); setViewer({ edge: "first" }); }
  };

  const o = overview.data;
  const counts = o?.status_counts ?? {};
  const n = (...s: (keyof typeof counts)[]) => s.reduce((a, k) => a + (counts[k] ?? 0), 0);
  const canReview = !!o?.can_review;

  return (
    <Card data-testid="hero-cutouts-card">
      <CardHeader className="hairline-b">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Hero cut-outs
          {o && (
            <Badge variant={o.mode === "auto" ? "default" : "secondary"} data-testid="hero-mode-badge">
              {o.mode === "auto" ? "Automatic go-live: ON" : "Automatic go-live: OFF"}
            </Badge>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          The website hero uses only cut-outs made by the original tool (BiRefNet), cut by the website's scheduled job. Product pages keep using the Photoroom cut-outs above. The two never mix.
        </p>
      </CardHeader>
      <CardContent className="space-y-5 pt-5 text-sm">
        {overview.isError && <p className="text-destructive">{heroRefusalText(overview.error)}</p>}
        {o && (
          <>
            <section className="space-y-2" aria-labelledby="hero-golive">
              <h3 id="hero-golive" className="font-medium">Go live</h3>
              <ToggleGroup
                type="single"
                value={o.mode}
                disabled={!canReview || mode.isPending}
                onValueChange={v => { if (v && v !== o.mode) setConfirm({ kind: "mode", mode: v as HeroMode }); }}
                className="justify-start"
                data-testid="hero-mode-toggle"
              >
                <ToggleGroupItem value="approve" variant="outline" size="sm">Approve first</ToggleGroupItem>
                <ToggleGroupItem value="auto" variant="outline" size="sm">Automatic</ToggleGroupItem>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">{HERO_MODE_TEXT[o.mode]}</p>
              {!canReview && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3 w-3" /> Only an admin can change this.</p>
              )}
              {o.updated_at && (
                <p className="text-xs text-muted-foreground">
                  Last changed {formatPHTDisplay(o.updated_at)}{o.updated_by_name ? ` by ${o.updated_by_name}` : ""}.
                </p>
              )}
            </section>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="hero-counts">
              {[
                ["Waiting", n("ok", "auto_fixed")],
                ["Held", n("needs_review", "failed")],
                ["Live", n("approved")],
                ["Rejected", n("rejected")],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded border border-border p-2">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="text-lg font-medium tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            {o.last_recorded_at && (
              <p className="text-xs text-muted-foreground">Last cut-out recorded {formatPHTDisplay(o.last_recorded_at)}.</p>
            )}
          </>
        )}

        <section className="space-y-3" aria-labelledby="hero-list">
          <h3 id="hero-list" className="font-medium">Hero cut-outs to check</h3>
          <div className="flex flex-wrap gap-2">
            <Select value={filter} onValueChange={v => { setFilter(v as HeroFilter); setPage(0); }}>
              <SelectTrigger className="w-56" aria-label="Show"><SelectValue /></SelectTrigger>
              <SelectContent>
                {HERO_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input className="w-56" placeholder="Search SKU or name" value={search}
                   onChange={e => { setSearch(e.target.value); setPage(0); }} aria-label="Search SKU or name" />
          </div>
          {list.isError && <p className="text-destructive">{heroRefusalText(list.error)}</p>}
          {list.data && total === 0 && <p className="text-muted-foreground">Nothing here.</p>}
          <ul className="divide-y divide-border">
            {rows.map(r => (
              <HeroItem key={r.source_url} row={r} canReview={canReview} busy={act.isPending} onAct={onAct}
                        onOpen={() => setViewer({ url: r.source_url })} />
            ))}
          </ul>
          {total > HERO_PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
              <span className="text-xs text-muted-foreground">
                {page * HERO_PAGE_SIZE + 1}–{Math.min(total, (page + 1) * HERO_PAGE_SIZE)} of {total}
              </span>
              <Button size="sm" variant="outline" disabled={(page + 1) * HERO_PAGE_SIZE >= total} onClick={() => setPage(p => p + 1)}>Next</Button>
            </div>
          )}
        </section>
      </CardContent>

      <HeroCutoutViewer
        open={viewer !== null}
        row={shownRow}
        onClose={() => setViewer(null)}
        position={viewIndex >= 0 ? `${page * HERO_PAGE_SIZE + viewIndex + 1} of ${total}` : ""}
        canPrev={canPrev}
        canNext={canNext}
        onPrev={goPrev}
        onNext={goNext}
        canReview={canReview}
        busy={act.isPending}
        onAct={(row, action) => perform(row, action, true)}
      />

      <AlertDialog open={confirm !== null} onOpenChange={v => { if (!v) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "mode"
                ? (confirm.mode === "auto" ? "Let hero cut-outs go live automatically?" : "Wait for approval again?")
                : "Take this cut-out off the hero?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "mode"
                ? (confirm.mode === "auto"
                  ? "From now on, a new cut-out that passes every check goes on the website hero without anyone looking at it first. Held ones still wait. Cut-outs already waiting stay waiting. You can reject any of them later."
                  : "From now on, every new hero cut-out waits for an admin before it goes on the website.")
                : "The hero will show the whole photo in its frame instead. You can approve it again later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (confirm?.kind === "mode") mode.mutate(confirm.mode);
              else if (confirm?.kind === "reject-live") run(confirm.row, "reject", confirm.fromViewer);
              setConfirm(null);
            }}>
              {confirm?.kind === "mode" ? "Yes, change it" : "Reject"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
