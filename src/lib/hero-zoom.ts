/**
 * Zoom and pan for the hero cut-out viewer (HeroCutoutViewer.tsx).
 *
 * One view is shared by both panes (original and cut-out), so they zoom and
 * pan together: `scale` is screen pixels per image pixel (1 = 100 %), and the
 * centre (`cx`, `cy`) is a fraction of the image, 0–1. Each pane applies it to
 * its own image, so two photos of different sizes show the same zoom and the
 * same relative spot. `fit` means "whole image in the pane".
 */

export type ZoomView = { fit: true } | { fit: false; scale: number; cx: number; cy: number };
export interface Size { w: number; h: number }
export interface Point { x: number; y: number }

export const FIT: ZoomView = { fit: true };
export const ZOOM_PRESETS = [1, 2, 4] as const;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const known = (s: Size) => s.w > 0 && s.h > 0;

/** The scale at which the whole image fits the pane (1 when either size is unknown). */
export function fitScale(pane: Size, img: Size): number {
  if (!known(pane) || !known(img)) return 1;
  return Math.min(pane.w / img.w, pane.h / img.h);
}

/** Scale and centre actually in effect for this pane. */
export function resolve(view: ZoomView, pane: Size, img: Size): { scale: number; cx: number; cy: number } {
  return view.fit ? { scale: fitScale(pane, img), cx: 0.5, cy: 0.5 } : view;
}

/** Where the <img> goes inside the pane (px, top-left origin). */
export function placeImage(view: ZoomView, pane: Size, img: Size) {
  const { scale, cx, cy } = resolve(view, pane, img);
  const width = img.w * scale;
  const height = img.h * scale;
  return { scale, width, height, left: pane.w / 2 - cx * width, top: pane.h / 2 - cy * height };
}

/** A fixed zoom (100 % / 200 % / 400 %), keeping the current centre. */
export function zoomTo(view: ZoomView, scale: number, pane: Size, img: Size): ZoomView {
  const { cx, cy } = resolve(view, pane, img);
  const s = clamp(scale, 0.01, MAX_SCALE);
  return { fit: false, scale: s, cx, cy };
}

/**
 * Zoom by `factor` keeping the image point under `at` (pane px) where it is —
 * the wheel, a trackpad pinch, a touch pinch and the +/− keys (at = centre).
 * Zooming out never goes below fit; reaching it snaps back to Fit.
 */
export function zoomBy(view: ZoomView, factor: number, at: Point, pane: Size, img: Size): ZoomView {
  if (!known(img)) return view;
  const cur = resolve(view, pane, img);
  const fit = fitScale(pane, img);
  const next = clamp(cur.scale * factor, Math.min(fit, MAX_SCALE), MAX_SCALE);
  if (factor < 1 && next <= fit * 1.0001) return FIT;
  const u = cur.cx * img.w + (at.x - pane.w / 2) / cur.scale;
  const v = cur.cy * img.h + (at.y - pane.h / 2) / cur.scale;
  return {
    fit: false,
    scale: next,
    cx: clamp((u - (at.x - pane.w / 2) / next) / img.w, 0, 1),
    cy: clamp((v - (at.y - pane.h / 2) / next) / img.h, 0, 1),
  };
}

/** Drag by (dx, dy) screen px. Nothing to pan at Fit. */
export function panBy(view: ZoomView, dx: number, dy: number, img: Size): ZoomView {
  if (view.fit || !known(img)) return view;
  return {
    ...view,
    cx: clamp(view.cx - dx / (img.w * view.scale), 0, 1),
    cy: clamp(view.cy - dy / (img.h * view.scale), 0, 1),
  };
}

/** Wheel delta → zoom factor. A trackpad pinch arrives as a wheel event with ctrlKey. */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  return Math.exp(-deltaY * (pinch ? 0.01 : 0.0015));
}

export function zoomLabel(view: ZoomView, pane: Size, img: Size): string {
  const pct = Math.round(resolve(view, pane, img).scale * 100);
  return view.fit ? `Fit (${pct} %)` : `${pct} %`;
}
