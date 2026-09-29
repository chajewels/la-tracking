import {
  useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Minus, Plus, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  FIT, panBy, placeImage, wheelFactor, ZOOM_STEP, zoomBy, zoomLabel, zoomTo,
  type Point, type Size, type ZoomView,
} from "@/lib/hero-zoom";

/**
 * Large viewer for Website → Photos (owner request 2026-09-27: the thumbnails
 * are too small to judge a background removal). The original sits beside the
 * chosen result at the same size; one click zooms BOTH to full resolution and
 * they pan together, so an edge can be compared pixel for pixel. The result
 * can be shown on white, black, a checkered pattern or the storefront stage —
 * dark and checkered make leftover background, halos and holes stand out.
 * The viewer itself changes nothing: the review buttons in its bottom bar
 * (`actions`, from MediaCutoutReviewCard) are the row's own, calling the
 * card's one handler. With `nav` it steps through the tab like the hero
 * viewer, with the same keys: ← → previous / next, + − zoom, 0 fit.
 *
 * Zoom (owner request 2026-09-29: pinch on a phone): one shared view for both
 * pictures (src/lib/hero-zoom.ts, the same maths as the hero viewer). Touch
 * pinch, trackpad pinch and the mouse wheel zoom around the fingers / pointer;
 * one finger or the mouse drags when zoomed; a tap or click without a drag
 * goes to full size at that spot, and back to fit. The pane keeps
 * touch-action: none so the phone never zooms the whole page instead.
 */

export interface ViewerImage { key: string; label: string; src: string; bg?: string }
export type ViewerBackground = "white" | "black" | "checker" | "stage";

const CHECKER: React.CSSProperties = {
  backgroundColor: "#ffffff",
  backgroundImage:
    "linear-gradient(45deg, #d4d4d4 25%, transparent 25%), linear-gradient(-45deg, #d4d4d4 25%, transparent 25%)," +
    "linear-gradient(45deg, transparent 75%, #d4d4d4 75%), linear-gradient(-45deg, transparent 75%, #d4d4d4 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

function backgroundStyle(bg: ViewerBackground, stage?: string): React.CSSProperties {
  if (bg === "checker") return CHECKER;
  if (bg === "black") return { backgroundColor: "#000000" };
  if (bg === "stage") return { backgroundColor: stage };
  return { backgroundColor: "#ffffff" };
}

export interface ViewerNav {
  /** "3 of 20" in the card's current tab and order. */
  position: string;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export default function CutoutViewer({ open, onOpenChange, title, badge, original, results, initialKey, nav, actions }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Shown beside the title, e.g. the photo's state. */
  badge?: ReactNode;
  original: ViewerImage | null;
  /** The processed versions (cut-out, catalogue, a parked re-run …). */
  results: ViewerImage[];
  initialKey?: string;
  nav?: ViewerNav;
  /** The review buttons, in a bottom bar below the pictures (never over them). */
  actions?: ReactNode;
}) {
  const [resultKey, setResultKey] = useState<string>(initialKey ?? results[0]?.key ?? "");
  const [bg, setBg] = useState<ViewerBackground>("checker");
  const [view, setView] = useState<ZoomView>(FIT);
  const zoomed = !view.fit;

  // Each time the viewer opens (or moves to another photo), start on the
  // picture that was clicked, fitted. Keyed on the files, not the array, so a
  // list refresh does not reset the zoom.
  const signature = [original?.src ?? "", ...results.map(r => `${r.key}=${r.src}`)].join("|");
  useEffect(() => {
    if (!open) return;
    setResultKey(initialKey && results.some(r => r.key === initialKey) ? initialKey : results[0]?.key ?? "");
    setView(FIT);
  }, [open, initialKey, signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = results.find(r => r.key === resultKey) ?? results[0] ?? null;
  // The original is a photo, not a cut-out: its own background is the point.
  const panes: Array<{ image: ViewerImage; isResult: boolean }> = [
    ...(original ? [{ image: original, isResult: false }] : []),
    ...(result ? [{ image: result, isResult: true }] : []),
  ];

  // Pane and picture sizes, per pane; the result pane (the last) drives the
  // toolbar's zoom label and the − + buttons.
  const [sizes, setSizes] = useState<Record<string, { pane: Size; img: Size }>>({});
  const onMeasure = useCallback((key: string, pane: Size, img: Size) => {
    setSizes(prev => {
      const cur = prev[key];
      if (cur && cur.pane.w === pane.w && cur.pane.h === pane.h && cur.img.w === img.w && cur.img.h === img.h) return prev;
      return { ...prev, [key]: { pane, img } };
    });
  }, []);
  const primaryKey = panes[panes.length - 1]?.image.key;
  const primary = (primaryKey && sizes[primaryKey]) || { pane: { w: 0, h: 0 }, img: { w: 0, h: 0 } };
  const centre = { x: primary.pane.w / 2, y: primary.pane.h / 2 };
  const zoomIn = () => setView(v => zoomBy(v, ZOOM_STEP, centre, primary.pane, primary.img));
  const zoomOut = () => setView(v => zoomBy(v, 1 / ZOOM_STEP, centre, primary.pane, primary.img));
  const toggleFull = () => setView(v => (v.fit ? zoomTo(v, 1, primary.pane, primary.img) : FIT));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=menuitem], [role=radio]")) return;
    if (nav && e.key === "ArrowLeft" && nav.canPrev) { e.preventDefault(); nav.onPrev(); }
    else if (nav && e.key === "ArrowRight" && nav.canNext) { e.preventDefault(); nav.onNext(); }
    else if (nav && (e.key === "+" || e.key === "=")) { e.preventDefault(); zoomIn(); }
    else if (nav && (e.key === "-" || e.key === "_")) { e.preventDefault(); zoomOut(); }
    else if (nav && e.key === "0") { e.preventDefault(); setView(FIT); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onKeyDown={onKeyDown} data-testid="cutout-viewer"
        className="flex h-[92dvh] max-h-[92dvh] w-[96vw] max-w-[96vw] flex-col gap-3 p-4 sm:p-5">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-6 text-base">
            <span className="truncate">{title}</span>
            {badge}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Tap or click a picture for full size, tap again to fit. Pinch, scroll or use − + to zoom; drag to move. Both pictures move together.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {results.length > 1 && (
            <ToggleGroup type="single" size="sm" variant="outline" value={result?.key}
              onValueChange={v => { if (v) setResultKey(v); }} aria-label="Which result to show">
              {results.map(r => <ToggleGroupItem key={r.key} value={r.key}>{r.label}</ToggleGroupItem>)}
            </ToggleGroup>
          )}
          <ToggleGroup type="single" size="sm" variant="outline" value={bg}
            onValueChange={v => { if (v) setBg(v as ViewerBackground); }} aria-label="Background behind the result">
            <ToggleGroupItem value="checker">Checkered</ToggleGroupItem>
            <ToggleGroupItem value="white">White</ToggleGroupItem>
            <ToggleGroupItem value="black">Black</ToggleGroupItem>
            <ToggleGroupItem value="stage">Website</ToggleGroupItem>
          </ToggleGroup>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={toggleFull}>
            {zoomed ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
            {zoomed ? "Fit to screen" : "Full size"}
          </Button>
          <div className="flex items-center gap-1" role="group" aria-label="Zoom">
            <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Zoom out" onClick={zoomOut}><Minus className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Zoom in" onClick={zoomIn}><Plus className="h-3.5 w-3.5" /></Button>
            <span className="min-w-[5rem] tabular-nums text-muted-foreground" data-testid="viewer-zoom" aria-live="polite">
              {zoomLabel(view, primary.pane, primary.img)}
            </span>
          </div>
          {result && (
            <a href={result.src} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
              <ExternalLink className="h-3.5 w-3.5" /> Open {result.label.toLowerCase()} in a new tab
            </a>
          )}
        </div>

        <div className={`grid min-h-0 flex-1 gap-3 ${panes.length > 1 ? "grid-rows-2 sm:grid-cols-2 sm:grid-rows-1" : ""}`}>
          {panes.map(({ image, isResult }) => (
            <ZoomPane key={image.key} image={image} view={view} setView={setView} onMeasure={onMeasure}
              style={isResult ? backgroundStyle(bg, image.bg) : { backgroundColor: "#ffffff" }} />
          ))}
        </div>

        {(nav || actions) && (
          <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end sm:justify-between"
               data-testid="viewer-bottom-bar">
            <div className="min-w-0">{actions}</div>
            {nav && (
              <div className="flex shrink-0 flex-col gap-1 sm:items-end">
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={!nav.canPrev} onClick={nav.onPrev} aria-label="Previous photo">
                    <ChevronLeft className="h-4 w-4" /> Previous
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground" data-testid="viewer-position">{nav.position}</span>
                  <Button size="sm" variant="outline" disabled={!nav.canNext} onClick={nav.onNext} aria-label="Next photo">
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
                <p className="hidden text-[11px] text-muted-foreground sm:block">Keys: ← → previous / next · + − zoom · 0 fit · Esc close</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One picture. At fit it is laid out as before (contained, centred); zoomed it
 * is placed from the shared view. Two fingers pinch, one finger or the mouse
 * drags, the wheel / a trackpad pinch zooms, a tap without a drag toggles
 * full size at that spot.
 */
function ZoomPane({ image, view, setView, onMeasure, style }: {
  image: ViewerImage;
  view: ZoomView;
  setView: (f: (v: ZoomView) => ZoomView) => void;
  onMeasure: (key: string, pane: Size, img: Size) => void;
  style: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Size>({ w: 0, h: 0 });
  const [img, setImg] = useState<Size>({ w: 0, h: 0 });
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ dist: number } | null>(null);
  const tap = useRef<{ at: Point; moved: boolean } | null>(null);

  useEffect(() => { setImg({ w: 0, h: 0 }); }, [image.src]);

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

  useEffect(() => { onMeasure(image.key, pane, img); }, [image.key, pane.w, pane.h, img.w, img.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Non-passive, so the page does not scroll or browser-zoom while zooming here.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      setView(v => zoomBy(v, wheelFactor(e.deltaY, e.ctrlKey), at, { w: el.clientWidth, h: el.clientHeight }, img));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [img, setView]);

  const local = (e: ReactPointerEvent): Point => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / old browsers */ }
    if (pointers.current.size === 1) tap.current = { at: p, moved: false };
    if (pointers.current.size === 2) {
      tap.current = null; // a pinch is never a tap
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = local(e);
    pointers.current.set(e.pointerId, now);
    if (tap.current && Math.abs(now.x - tap.current.at.x) + Math.abs(now.y - tap.current.at.y) > 4) tap.current.moved = true;
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
    const wasTap = pointers.current.size === 1 && tap.current && !tap.current.moved ? tap.current.at : null;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) tap.current = null;
    if (!wasTap || e.type === "pointercancel") return;
    // Full size centred on the tapped spot; tapped again, back to fit.
    setView(v => {
      if (!v.fit) return FIT;
      const p = placeImage(v, pane, img);
      if (!(p.width > 0 && p.height > 0)) return zoomTo(v, 1, pane, img);
      const cx = Math.min(1, Math.max(0, (wasTap.x - p.left) / p.width));
      const cy = Math.min(1, Math.max(0, (wasTap.y - p.top) / p.height));
      return { fit: false, scale: 1, cx, cy };
    });
  };

  const zoomed = !view.fit;
  const place = placeImage(view, pane, img);

  return (
    <figure className="flex min-h-0 min-w-0 flex-col gap-1">
      <figcaption className="text-[11px] text-muted-foreground">{image.label}</figcaption>
      <div
        ref={ref}
        data-testid={`viewer-pane-${image.key}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded border border-border ${
          zoomed ? "cursor-grab active:cursor-grabbing" : "flex cursor-zoom-in items-center justify-center"}`}
        style={style}
      >
        <img
          src={image.src}
          alt={image.label}
          draggable={false}
          onLoad={e => {
            const t = e.currentTarget;
            if (t.naturalWidth && t.naturalHeight) setImg({ w: t.naturalWidth, h: t.naturalHeight });
          }}
          className={zoomed ? "pointer-events-none absolute block max-w-none" : "block max-h-full max-w-full object-contain"}
          style={zoomed ? {
            left: place.left, top: place.top, width: place.width, height: place.height,
            imageRendering: place.scale >= 2 ? "pixelated" : "auto",
          } : undefined}
        />
      </div>
    </figure>
  );
}
