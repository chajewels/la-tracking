import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ExternalLink, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * Large viewer for Website → Photos (owner request 2026-09-27: the thumbnails
 * are too small to judge a background removal). The original sits beside the
 * chosen result at the same size; one click zooms BOTH to full resolution and
 * they pan together, so an edge can be compared pixel for pixel. The result
 * can be shown on white, black, a checkered pattern or the storefront stage —
 * dark and checkered make leftover background, halos and holes stand out.
 * Read-only: it changes nothing.
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

export default function CutoutViewer({ open, onOpenChange, title, original, results, initialKey }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  original: ViewerImage | null;
  /** The processed versions (cut-out, catalogue, a parked re-run …). */
  results: ViewerImage[];
  initialKey?: string;
}) {
  const [resultKey, setResultKey] = useState<string>(initialKey ?? results[0]?.key ?? "");
  const [bg, setBg] = useState<ViewerBackground>("checker");
  const [zoomed, setZoomed] = useState(false);

  // Each time the viewer opens, start on the picture that was clicked, fitted.
  useEffect(() => {
    if (!open) return;
    setResultKey(initialKey && results.some(r => r.key === initialKey) ? initialKey : results[0]?.key ?? "");
    setZoomed(false);
  }, [open, initialKey, results]);

  const result = results.find(r => r.key === resultKey) ?? results[0] ?? null;
  // The original is a photo, not a cut-out: its own background is the point.
  const panes: Array<{ image: ViewerImage; isResult: boolean }> = [
    ...(original ? [{ image: original, isResult: false }] : []),
    ...(result ? [{ image: result, isResult: true }] : []),
  ];

  // Zoomed panes pan together: moving one moves the other to the same spot.
  const paneRefs = useRef<Array<HTMLDivElement | null>>([]);
  const syncing = useRef(false);
  const onScroll = useCallback((from: number) => {
    if (syncing.current) return;
    const src = paneRefs.current[from];
    if (!src) return;
    const rx = src.scrollWidth > src.clientWidth ? src.scrollLeft / (src.scrollWidth - src.clientWidth) : 0;
    const ry = src.scrollHeight > src.clientHeight ? src.scrollTop / (src.scrollHeight - src.clientHeight) : 0;
    syncing.current = true;
    paneRefs.current.forEach((el, i) => {
      if (!el || i === from) return;
      el.scrollLeft = rx * (el.scrollWidth - el.clientWidth);
      el.scrollTop = ry * (el.scrollHeight - el.clientHeight);
    });
    requestAnimationFrame(() => { syncing.current = false; });
  }, []);

  // Drag to move while zoomed; a click without a drag toggles the zoom.
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; pane: number } | null>(null);
  const onPointerDown = (i: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = paneRefs.current[i];
    if (!el) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false, pane: i };
    el.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !zoomed) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    const el = paneRefs.current[d.pane];
    if (el) { el.scrollLeft = d.left - dx; el.scrollTop = d.top - dy; }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      // Zoom in centred on the point that was clicked.
      const el = paneRefs.current[d.pane];
      const rect = el?.getBoundingClientRect();
      const fx = rect ? (e.clientX - rect.left) / rect.width : 0.5;
      const fy = rect ? (e.clientY - rect.top) / rect.height : 0.5;
      setZoomed(z => {
        const next = !z;
        if (next) {
          requestAnimationFrame(() => {
            paneRefs.current.forEach(p => {
              if (!p) return;
              p.scrollLeft = fx * (p.scrollWidth - p.clientWidth);
              p.scrollTop = fy * (p.scrollHeight - p.clientHeight);
            });
          });
        }
        return next;
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-3 p-4 sm:p-5">
        <DialogHeader className="space-y-1">
          <DialogTitle className="truncate pr-6 text-base">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            Click a picture to zoom to full size, drag to move, click again to fit. Both pictures move together.
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
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setZoomed(z => !z)}>
            {zoomed ? <ZoomOut className="h-3.5 w-3.5" /> : <ZoomIn className="h-3.5 w-3.5" />}
            {zoomed ? "Fit to screen" : "Full size"}
          </Button>
          {result && (
            <a href={result.src} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
              <ExternalLink className="h-3.5 w-3.5" /> Open {result.label.toLowerCase()} in a new tab
            </a>
          )}
        </div>

        <div className={`grid min-h-0 flex-1 gap-3 ${panes.length > 1 ? "grid-rows-2 sm:grid-cols-2 sm:grid-rows-1" : ""}`}>
          {panes.map(({ image, isResult }, i) => (
            <figure key={image.key} className="flex min-h-0 min-w-0 flex-col gap-1">
              <figcaption className="text-[11px] text-muted-foreground">{image.label}</figcaption>
              <div
                ref={el => { paneRefs.current[i] = el; }}
                data-testid={`viewer-pane-${image.key}`}
                onScroll={() => onScroll(i)}
                onPointerDown={onPointerDown(i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className={`relative min-h-0 flex-1 touch-none select-none overflow-auto rounded border border-border ${
                  zoomed ? "cursor-grab active:cursor-grabbing" : "flex cursor-zoom-in items-center justify-center"}`}
                style={isResult ? backgroundStyle(bg, image.bg) : { backgroundColor: "#ffffff" }}
              >
                <img
                  src={image.src}
                  alt={image.label}
                  draggable={false}
                  className={zoomed ? "block max-w-none" : "block max-h-full max-w-full object-contain"}
                />
              </div>
            </figure>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
