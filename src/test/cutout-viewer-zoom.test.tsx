/**
 * Website → Photos → "Photos to check" viewer: zoom on a phone (owner request
 * 2026-09-29). Two-finger pinch, the wheel / trackpad pinch and the − + buttons
 * zoom BOTH pictures together; a tap goes to full size and back to fit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import CutoutViewer from "@/components/website/CutoutViewer";

const PANE = { w: 400, h: 400 };
const IMG = { w: 1600, h: 1600 }; // fit = 25 %
const saved: Record<string, PropertyDescriptor | undefined> = {};
const savedRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  for (const [k, v] of [["clientWidth", PANE.w], ["clientHeight", PANE.h]] as const) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
  }
  for (const [k, v] of [["naturalWidth", IMG.w], ["naturalHeight", IMG.h]] as const) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, k);
    Object.defineProperty(HTMLImageElement.prototype, k, { configurable: true, get: () => v });
  }
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: PANE.w, height: PANE.h, right: PANE.w, bottom: PANE.h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = savedRect;
  for (const k of ["clientWidth", "clientHeight"]) if (saved[k]) Object.defineProperty(HTMLElement.prototype, k, saved[k]!);
  for (const k of ["naturalWidth", "naturalHeight"]) if (saved[k]) Object.defineProperty(HTMLImageElement.prototype, k, saved[k]!);
});

function open() {
  render(
    <CutoutViewer open onOpenChange={() => {}} title="AL3 · photo 1"
      original={{ key: "original", label: "Original", src: "https://cdn.test/o.jpg" }}
      results={[{ key: "cutout", label: "Cut-out", src: "https://cdn.test/c.webp" }]} />,
  );
  const dialog = screen.getByRole("dialog");
  for (const img of within(dialog).getAllByRole("img")) fireEvent.load(img);
  return dialog;
}
const zoom = (d: HTMLElement) => within(d).getByTestId("viewer-zoom").textContent;
const imgs = (d: HTMLElement) => within(d).getAllByRole("img") as HTMLImageElement[];

describe("Photos to check viewer: zoom", () => {
  it("opens at fit; + and − zoom both pictures together", () => {
    const d = open();
    expect(zoom(d)).toBe("Fit (25 %)");
    fireEvent.click(within(d).getByRole("button", { name: "Zoom in" }));
    expect(zoom(d)).toBe("38 %");
    for (const i of imgs(d)) expect(i.style.width).toBe("600px");
    fireEvent.click(within(d).getByRole("button", { name: "Zoom out" }));
    expect(zoom(d)).toMatch(/^Fit/);
  });

  it("a two-finger pinch zooms both pictures", () => {
    const d = open();
    const pane = within(d).getByTestId("viewer-pane-cutout");
    fireEvent.pointerDown(pane, { pointerId: 1, clientX: 150, clientY: 200 });
    fireEvent.pointerDown(pane, { pointerId: 2, clientX: 250, clientY: 200 });
    fireEvent.pointerMove(pane, { pointerId: 2, clientX: 350, clientY: 200 }); // distance 100 → 200
    fireEvent.pointerUp(pane, { pointerId: 2 });
    fireEvent.pointerUp(pane, { pointerId: 1 });
    expect(zoom(d)).toBe("50 %");
    for (const i of imgs(d)) expect(i.style.width).toBe("800px");
  });

  it("the wheel (and a trackpad pinch) zooms", () => {
    const d = open();
    fireEvent.wheel(within(d).getByTestId("viewer-pane-original"), { deltaY: -100, ctrlKey: true });
    expect(zoom(d)).not.toMatch(/^Fit/);
  });

  it("a tap goes to full size at that spot, a second tap back to fit; a drag pans", () => {
    const d = open();
    const pane = within(d).getByTestId("viewer-pane-cutout");
    fireEvent.pointerDown(pane, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(pane, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(zoom(d)).toBe("100 %");
    expect(within(d).getByRole("button", { name: /Fit to screen/ })).toBeInTheDocument();
    // The tapped spot (a quarter in) is now centred: left = 200 − 0.25 × 1600.
    expect(imgs(d)[1].style.left).toBe("-200px");

    fireEvent.pointerDown(pane, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(pane, { pointerId: 1, clientX: 260, clientY: 200 });
    fireEvent.pointerUp(pane, { pointerId: 1, clientX: 260, clientY: 200 });
    expect(zoom(d)).toBe("100 %"); // a drag is not a tap
    for (const i of imgs(d)) expect(i.style.left).toBe("-140px");

    fireEvent.pointerDown(pane, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(pane, { pointerId: 1, clientX: 50, clientY: 50 });
    expect(zoom(d)).toMatch(/^Fit/);
  });

  it("the page itself never zooms: the panes keep touch-action none", () => {
    const d = open();
    for (const k of ["original", "cutout"]) expect(within(d).getByTestId(`viewer-pane-${k}`).className).toContain("touch-none");
  });
});
