import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ImageOff, Lock, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  describeHeroFlag, fetchHeroPhotoContext, HERO_CONTEXT_KEY, HERO_STATUS_LABEL, heroActions, heroCutoutUrl,
  heroFlagPlain, heroPhotoNumber, type HeroRow,
} from "@/lib/hero-cutouts";
import {
  FIT, panBy, placeImage, wheelFactor, ZOOM_PRESETS, ZOOM_STEP, zoomBy, zoomLabel, zoomTo,
  type Point, type Size, type ZoomView,
} from "@/lib/hero-zoom";

/**
 * The hero cut-out zoom viewer (Website → Photos → Hero cut-outs). Opened from
 * any thumbnail in HeroCutoutsCard; shows the FULL-RESOLUTION files (the
 * original photo and the cut-out) — never a thumbnail — so an admin can check
 * erased holes, missing chain ends or prongs, a leftover stand or shadow and
 * grey edges before approving. Both panes share one zoom and position.
 *
 * Approve / Reject are the card's own (onAct → review_hero_cutout, admin only,
 * the same heroActions rules); the card moves the viewer to the next item
 * after a decision. Non-admins can view and zoom but get no buttons.
 */

export type HeroViewerBackground = "checkered" | "white" | "black";
type Layout = "side" | "cutout" | "original";

const BACKGROUNDS: { value: HeroViewerBackground; label: string }[] = [
  { value: "checkered", label: "Checkered" },
  { value: "white", label: "White" },
  { value: "black", label: "Black" },
];
const CHECKER = {
  backgroundColor: "#f4f4f5",
  backgroundImage: "conic-gradient(#d4d4d8 25%, transparent 0 50%, #d4d4d8 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
};
const bgStyle = (b: HeroViewerBackground) =>
  b === "checkered" ? CHECKER : { backgroundColor: b === "white" ? "#ffffff" : "#000000" };

function statusVariant(s: HeroRow["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (s === "approved") return "default";
  if (s === "needs_review" || s === "failed") return "destructive";
  if (s === "ok" || s === "auto_fixed") return "secondary";
  return "outline";
}

interface PaneProps {
  kind: "original" | "cutout";
  src: string | null;
  alt: string;
  /** Size known from the record, used until the file has loaded. */
  fallback: Size;
  view: ZoomView;
  setView: (f: (v: ZoomView) => ZoomView) => void;
  background?: HeroViewerBackground;
  onMeasure: (kind: "original" | "cutout", pane: Size, img: Size) => void;
}

/** One zoomable pane. Wheel / trackpad pinch / touch pinch zoom; drag pans when zoomed. */
function ZoomPane({ kind, src, alt, fallback, view, setView, background, onMeasure }: PaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Size>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const img = natural ?? fallback;
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ dist: number } | null>(null);

  useEffect(() => { setNatural(null); }, [src]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setPane({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { onMeasure(kind, pane, img); }, [kind, pane.w, pane.h, img.w, img.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Non-passive, so the page does not scroll or browser-zoom while zooming here.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const size = { w: el.clientWidth, h: el.clientHeight };
      setView(v => zoomBy(v, wheelFactor(e.deltaY, e.ctrlKey), at, size, img));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [img, setView]);

  const local = (e: ReactPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, local(e));
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / old browsers */ }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = local(e);
    pointers.current.set(e.pointerId, now);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current.dist > 0 && dist > 0) {
        const factor = dist / pinch.current.dist;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        setView(v => zoomBy(v, factor, mid, pane, img));
      }
      pinch.current = { dist };
    } else if (pointers.current.size === 1) {
      setView(v => panBy(v, now.x - prev.x, now.y - prev.y, img));
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const place = placeImage(view, pane, img);
  const label = kind === "cutout" ? "Hero cut-out" : "Original photo";

  return (
    <figure className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
      <figcaption className="text-xs font-medium text-muted-foreground">{label}</figcaption>
      <div
        ref={ref}
        role="region"
        aria-label={`${label}, zoomable`}
        data-testid={`hero-viewer-pane-${kind}`}
        data-background={kind === "cutout" ? background : undefined}
        className={cn(
          "relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded border border-border",
          kind === "original" && "bg-muted",
          view.fit ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing",
        )}
        style={kind === "cutout" && background ? bgStyle(background) : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {src ? (
          <img
            src={src}
            alt={alt}
            draggable={false}
            decoding="async"
            onLoad={e => {
              const t = e.currentTarget;
              if (t.naturalWidth && t.naturalHeight) setNatural({ w: t.naturalWidth, h: t.naturalHeight });
            }}
            className="pointer-events-none absolute max-w-none"
            // Zoomed in to 200 % or more, show the file's real pixels (no
            // smoothing), so a grey edge or an erased speck is seen as it is. Fit
            // stays smooth, as the storefront shows it, even for a small photo.
            style={{ left: place.left, top: place.top, width: place.width, height: place.height,
                     imageRendering: !view.fit && place.scale >= 2 ? "pixelated" : "auto" }}
          />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <ImageOff className="h-5 w-5" aria-hidden /> No cut-out file (the run failed)
          </div>
        )}
      </div>
    </figure>
  );
}

export interface HeroCutoutViewerProps {
  row: HeroRow | null;
  open: boolean;
  onClose: () => void;
  /** "3 of 20" in the card's current order and filter. */
  position: string;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  canReview: boolean;
  busy: boolean;
  onAct: (row: HeroRow, action: "approve" | "reject") => void;
}

export function HeroCutoutViewer(props: HeroCutoutViewerProps) {
  return (
    <Dialog open={props.open} onOpenChange={v => { if (!v) props.onClose(); }}>
      {props.open && <ViewerBody {...props} />}
    </Dialog>
  );
}

/** Mounted only while open: background and layout are remembered while it is open. */
function ViewerBody({ row, position, canPrev, canNext, onPrev, onNext, canReview, busy, onAct }: HeroCutoutViewerProps) {
  const [view, setViewState] = useState<ZoomView>(FIT);
  const [background, setBackground] = useState<HeroViewerBackground>("checkered");
  const [layout, setLayout] = useState<Layout>("side");
  const sizes = useRef<Record<"original" | "cutout", { pane: Size; img: Size }>>({
    original: { pane: { w: 0, h: 0 }, img: { w: 0, h: 0 } },
    cutout: { pane: { w: 0, h: 0 }, img: { w: 0, h: 0 } },
  });
  const [, bump] = useState(0);
  const setView = useCallback((f: (v: ZoomView) => ZoomView) => setViewState(f), []);
  const onMeasure = useCallback((kind: "original" | "cutout", pane: Size, img: Size) => {
    sizes.current[kind] = { pane, img };
    bump(n => n + 1);
  }, []);

  // A new item opens at Fit.
  useEffect(() => { setViewState(FIT); }, [row?.source_url]);

  const context = useQuery({
    queryKey: [HERO_CONTEXT_KEY, row?.product?.id],
    queryFn: () => fetchHeroPhotoContext(row!.product!.id),
    enabled: !!row?.product?.id,
    staleTime: 60_000,
  });

  if (!row) {
    return (
      <DialogContent aria-describedby={undefined} className="max-w-sm">
        <DialogTitle>Loading…</DialogTitle>
      </DialogContent>
    );
  }

  const cutoutSrc = heroCutoutUrl(row);
  const photoNo = heroPhotoNumber(row.source_url, context.data);
  const sku = row.product?.sku ?? "—";
  const can = heroActions(row);
  // The pane the zoom label and the keys refer to: the cut-out unless only the original is shown.
  const primary = layout === "original" || !cutoutSrc ? sizes.current.original : sizes.current.cutout;
  const centre = { x: primary.pane.w / 2, y: primary.pane.h / 2 };

  const zoomIn = () => setView(v => zoomBy(v, ZOOM_STEP, centre, primary.pane, primary.img));
  const zoomOut = () => setView(v => zoomBy(v, 1 / ZOOM_STEP, centre, primary.pane, primary.img));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable=true]")) return;
    if (e.key === "ArrowLeft" && canPrev) { e.preventDefault(); onPrev(); }
    else if (e.key === "ArrowRight" && canNext) { e.preventDefault(); onNext(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomIn(); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomOut(); }
    else if (e.key === "0") { e.preventDefault(); setView(() => FIT); }
  };

  const pressed = (on: boolean) => ({ "aria-pressed": on, variant: on ? ("default" as const) : ("outline" as const) });
  const originalAlt = `Original photo of ${sku}${photoNo ? `, photo ${photoNo}` : ""}`;
  const cutoutAlt = `Hero cut-out of ${sku}${photoNo ? `, photo ${photoNo}` : ""}`;

  return (
    <DialogContent
      data-testid="hero-viewer"
      onKeyDown={onKeyDown}
      className="flex h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-[1400px] flex-col gap-3 p-3 sm:h-[94dvh] sm:overflow-hidden sm:p-4"
    >
      <DialogHeader className="space-y-1">
        <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
          <span>{sku}{photoNo ? ` · photo ${photoNo}` : ""}</span>
          <Badge variant={statusVariant(row.status)}>{HERO_STATUS_LABEL[row.status]}</Badge>
        </DialogTitle>
        <DialogDescription className="truncate">
          {row.product ? row.product.name : "Photo no longer used by a product"}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="toolbar" aria-label="Viewer controls">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Zoom">
          <Button size="sm" {...pressed(view.fit)} onClick={() => setView(() => FIT)}>Fit</Button>
          {ZOOM_PRESETS.map(s => (
            <Button key={s} size="sm" {...pressed(!view.fit && Math.abs(view.scale - s) < 1e-6)}
                    onClick={() => setView(v => zoomTo(v, s, primary.pane, primary.img))}>
              {s * 100}%
            </Button>
          ))}
          <Button size="icon" variant="outline" className="h-9 w-9" aria-label="Zoom out" onClick={zoomOut}><Minus className="h-4 w-4" /></Button>
          <Button size="icon" variant="outline" className="h-9 w-9" aria-label="Zoom in" onClick={zoomIn}><Plus className="h-4 w-4" /></Button>
          <span className="min-w-[5.5rem] text-xs tabular-nums text-muted-foreground" data-testid="hero-viewer-zoom" aria-live="polite">
            {zoomLabel(view, primary.pane, primary.img)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Cut-out background">
          {BACKGROUNDS.map(b => (
            <Button key={b.value} size="sm" {...pressed(background === b.value)} onClick={() => setBackground(b.value)}>{b.label}</Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Layout">
          <Button size="sm" {...pressed(layout === "side")} onClick={() => setLayout("side")}>Side by side</Button>
          <Button size="sm" {...pressed(layout === "cutout")} onClick={() => setLayout("cutout")}>Cut-out only</Button>
          <Button size="sm" {...pressed(layout === "original")} onClick={() => setLayout("original")}>Original only</Button>
        </div>
      </div>

      <div className="flex h-[70dvh] shrink-0 flex-col gap-2 sm:h-auto sm:min-h-0 sm:flex-1 sm:flex-row" data-testid="hero-viewer-panes" data-layout={layout}>
        {layout !== "cutout" && (
          <ZoomPane kind="original" src={row.source_url} alt={originalAlt}
                    fallback={{ w: row.source_width ?? 0, h: row.source_height ?? 0 }}
                    view={view} setView={setView} onMeasure={onMeasure} />
        )}
        {layout !== "original" && (
          <ZoomPane kind="cutout" src={cutoutSrc} alt={cutoutAlt}
                    fallback={{ w: row.width ?? 0, h: row.height ?? 0 }}
                    view={view} setView={setView} background={background} onMeasure={onMeasure} />
        )}
      </div>

      <div className="grid shrink-0 gap-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0 space-y-2">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4" data-testid="hero-viewer-info">
            <div><dt className="text-xs text-muted-foreground">Product code</dt><dd className="font-medium">{sku}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Photo</dt><dd>{photoNo ?? (context.isLoading ? "…" : "—")}</dd></div>
            <div className="min-w-0"><dt className="text-xs text-muted-foreground">Category</dt>
              <dd className="truncate">{context.data?.categories.length ? context.data.categories.join(", ") : (context.isLoading ? "…" : "—")}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Size</dt>
              <dd className="tabular-nums">{row.source_width && row.source_height ? `${row.source_width} × ${row.source_height} px` : "—"}</dd></div>
          </dl>
          {row.flags.length > 0 ? (
            <ul className="space-y-1" data-testid="hero-viewer-flags" aria-label="What the checks found">
              {row.flags.map(f => (
                <li key={f} className="text-sm">
                  <span className="font-medium">{heroFlagPlain(f)}</span>
                  <span className="block text-xs text-muted-foreground">{describeHeroFlag(f)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">The checks found nothing to flag.</p>
          )}
          {row.review_note && <p className="text-xs text-muted-foreground">Note: {row.review_note}</p>}
        </div>

        <div className="flex flex-col gap-2 sm:items-end">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={!canPrev} onClick={onPrev} aria-label="Previous cut-out">
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground" data-testid="hero-viewer-position">{position}</span>
            <Button size="sm" variant="outline" disabled={!canNext} onClick={onNext} aria-label="Next cut-out">
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {canReview ? (
            <div className="flex flex-wrap gap-2" data-testid="hero-viewer-actions">
              <Button size="sm" disabled={busy || !can.approve} onClick={() => onAct(row, "approve")}>Approve</Button>
              <Button size="sm" variant="outline" disabled={busy || !can.reject} onClick={() => onAct(row, "reject")}>
                {row.status === "approved" ? "Reject (take off the hero)" : "Reject"}
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="hero-viewer-readonly">
              <Lock className="h-3 w-3" /> Only an admin can approve or reject.
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">Keys: ← → previous / next · + − zoom · 0 fit · Esc close</p>
        </div>
      </div>
    </DialogContent>
  );
}

