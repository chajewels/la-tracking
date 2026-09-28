import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * The hero cut-out zoom viewer (HeroCutoutViewer, opened from HeroCutoutsCard).
 * Same mocked RPCs as hero-cutouts-ui.test.tsx; the decisions go through the
 * card's own review_hero_cutout call, so the approval rules are unchanged.
 */

const calls: { fn: string; args?: Record<string, unknown> }[] = [];
let overview: Record<string, unknown>;
let rows: Record<string, unknown>[];
/** When true, a decided row leaves the list (as it does under the Waiting filter). */
let decidedLeave = false;

vi.mock("@/lib/untyped-rpc", () => ({
  callUntypedRpc: async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "get_hero_cutout_overview") return overview;
    if (fn === "list_hero_cutouts") return { total: rows.length, rows };
    if (fn === "review_hero_cutout") {
      if (!overview.can_review) return { error: "admin_only" };
      if (decidedLeave) rows = rows.filter(r => r.source_url !== args?.p_source_url);
      return { ok: true, status: args?.p_action === "approve" ? "approved" : "rejected" };
    }
    return {};
  },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { HeroCutoutsCard } from "@/components/website/HeroCutoutsCard";
import { describeHeroFlag, heroFlagPlain, heroPhotoOrder, setHeroContextForFixture } from "@/lib/hero-cutouts";
import { FIT, fitScale, panBy, placeImage, zoomBy, zoomLabel, zoomTo } from "@/lib/hero-zoom";

const PANE = { w: 800, h: 600 };
// jsdom lays nothing out: give every element the pane's size so fit / zoom are real numbers.
const dims = {
  w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
};
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => PANE.w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => PANE.h });
});
afterAll(() => {
  if (dims.w) Object.defineProperty(HTMLElement.prototype, "clientWidth", dims.w);
  if (dims.h) Object.defineProperty(HTMLElement.prototype, "clientHeight", dims.h);
});

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};
const U = (n: number) => `https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/p/${n}.jpg`;
const r = (n: number, over: Record<string, unknown> = {}) => ({
  id: String(n), source_url: U(n), source_sha256: "a".repeat(64), source_width: 1600, source_height: 1200, status: "ok",
  qa_status: "ok", flags: [], coverage: 0.4, cutout_path: `website/derived/hero/${String(n).padStart(32, "0")}/bbbbbbbb/cutout.webp`,
  width: 700, height: 900, model: "birefnet-general@epoch_244", auto_approved: false, reviewed_at: null, review_note: null,
  updated_at: "2026-09-28T00:00:00Z", product: { id: `p${n}`, sku: `R${n}`, name: `Ring ${n}`, slug: `r${n}`, status: "active" },
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  decidedLeave = false;
  overview = { mode: "approve", updated_at: null, updated_by_name: null, can_review: true,
               status_counts: { ok: 3 }, last_recorded_at: null };
  rows = [r(1), r(2), r(3)];
  setHeroContextForFixture(async (productId: string) => ({
    photos: [U(9), U(Number(productId.slice(1)))], // the listed photo is photo 2 of its product
    categories: ["Fine Jewelry"],
  }));
});

async function openFirstCutout() {
  wrap(<HeroCutoutsCard />);
  await screen.findAllByTestId("hero-cutout-row");
  const thumbs = screen.getAllByRole("button", { name: /Open the hero cut-out of R1/ });
  fireEvent.click(thumbs[0]);
  return screen.findByTestId("hero-viewer");
}
const viewer = () => screen.getByTestId("hero-viewer");
const cutoutImg = () => within(screen.getByTestId("hero-viewer-pane-cutout")).getByRole("img") as HTMLImageElement;
const zoomText = () => screen.getByTestId("hero-viewer-zoom").textContent;
const key = (k: string) => fireEvent.keyDown(viewer(), { key: k });

describe("open and close", () => {
  it("every thumbnail is a button that opens the viewer on its item, with the full file", async () => {
    await openFirstCutout();
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName(/R1 · photo 2/));
    expect(cutoutImg().getAttribute("src")).toBe(`https://cdn.test/website/derived/hero/${"1".padStart(32, "0")}/bbbbbbbb/cutout.webp`);
    const original = within(screen.getByTestId("hero-viewer-pane-original")).getByRole("img");
    expect(original).toHaveAttribute("src", U(1));
    expect(original).toHaveAttribute("alt", "Original photo of R1, photo 2");
    expect(cutoutImg()).toHaveAttribute("alt", "Hero cut-out of R1, photo 2");
  });

  it("the original's thumbnail opens it too", async () => {
    wrap(<HeroCutoutsCard />);
    fireEvent.click(await screen.findByRole("button", { name: /Open the original of R2/ }));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName(/R2/);
  });

  it("Esc closes; the close button closes", async () => {
    await openFirstCutout();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("hero-viewer")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: /Open the hero cut-out of R1/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("hero-viewer")).toBeNull());
  });

  it("shows product code, photo number, category, size and status", async () => {
    await openFirstCutout();
    const info = screen.getByTestId("hero-viewer-info");
    await waitFor(() => expect(info).toHaveTextContent("Fine Jewelry"));
    expect(info).toHaveTextContent("Product codeR1");
    expect(info).toHaveTextContent("Photo2");
    expect(info).toHaveTextContent("1600 × 1200 px");
    expect(within(viewer()).getByText("Waiting — passed")).toBeInTheDocument();
  });
});

describe("zoom", () => {
  it("Fit, 100 %, 200 %, 400 % size the full-resolution image; the pressed button follows", async () => {
    await openFirstCutout();
    const fit = fitScale(PANE, { w: 700, h: 900 });
    expect(zoomText()).toBe(`Fit (${Math.round(fit * 100)} %)`);
    expect(cutoutImg().style.width).toBe(`${700 * fit}px`);
    for (const [label, s] of [["100%", 1], ["200%", 2], ["400%", 4]] as const) {
      fireEvent.click(within(viewer()).getByRole("button", { name: label }));
      expect(cutoutImg().style.width).toBe(`${700 * s}px`);
      expect(within(viewer()).getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
      expect(zoomText()).toBe(`${s * 100} %`);
    }
    fireEvent.click(within(viewer()).getByRole("button", { name: "Fit" }));
    expect(zoomText()).toMatch(/^Fit/);
  });

  it("+ / − / 0 keys and the zoom buttons", async () => {
    await openFirstCutout();
    key("+");
    expect(zoomText()).not.toMatch(/^Fit/);
    key("0");
    expect(zoomText()).toMatch(/^Fit/);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = zoomText();
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(zoomText()).not.toBe(zoomed);
    key("-"); key("-"); key("-");
    expect(zoomText()).toMatch(/^Fit/); // never below fit
  });

  it("the mouse wheel / trackpad pinch zooms, and both panes stay linked", async () => {
    await openFirstCutout();
    const pane = screen.getByTestId("hero-viewer-pane-cutout");
    act(() => { pane.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(zoomText()).not.toMatch(/^Fit/);
    const scale = parseFloat(cutoutImg().style.width) / 700;
    const original = within(screen.getByTestId("hero-viewer-pane-original")).getByRole("img") as HTMLImageElement;
    expect(parseFloat(original.style.width) / 1600).toBeCloseTo(scale, 6); // same zoom on the original
  });
});

describe("background and layout", () => {
  it("checkered / white / black, remembered across items while open", async () => {
    await openFirstCutout();
    const pane = () => screen.getByTestId("hero-viewer-pane-cutout");
    expect(pane()).toHaveAttribute("data-background", "checkered");
    fireEvent.click(within(viewer()).getByRole("button", { name: "Black" }));
    expect(pane()).toHaveAttribute("data-background", "black");
    expect(pane().style.backgroundColor).toBe("rgb(0, 0, 0)");
    key("ArrowRight");
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName(/R2/));
    expect(pane()).toHaveAttribute("data-background", "black");
    fireEvent.click(within(viewer()).getByRole("button", { name: "White" }));
    expect(pane().style.backgroundColor).toBe("rgb(255, 255, 255)");
  });

  it("side by side by default; one large on request", async () => {
    await openFirstCutout();
    expect(screen.getByTestId("hero-viewer-pane-original")).toBeInTheDocument();
    expect(screen.getByTestId("hero-viewer-pane-cutout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cut-out only" }));
    expect(screen.queryByTestId("hero-viewer-pane-original")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Original only" }));
    expect(screen.queryByTestId("hero-viewer-pane-cutout")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
    expect(screen.getByTestId("hero-viewer-panes")).toHaveAttribute("data-layout", "side");
  });
});

describe("previous / next", () => {
  it("follows the card's order; ← → keys and buttons; ends disabled", async () => {
    await openFirstCutout();
    expect(screen.getByTestId("hero-viewer-position")).toHaveTextContent("1 of 3");
    expect(screen.getByRole("button", { name: "Previous cut-out" })).toBeDisabled();
    key("ArrowRight");
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName(/R2/));
    fireEvent.click(screen.getByRole("button", { name: "Next cut-out" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName(/R3/));
    expect(screen.getByRole("button", { name: "Next cut-out" })).toBeDisabled();
    key("ArrowLeft");
    await waitFor(() => expect(screen.getByTestId("hero-viewer-position")).toHaveTextContent("2 of 3"));
  });

  it("a new item opens at Fit", async () => {
    await openFirstCutout();
    fireEvent.click(within(viewer()).getByRole("button", { name: "400%" }));
    key("ArrowRight");
    await waitFor(() => expect(zoomText()).toMatch(/^Fit/));
  });
});

describe("decisions in the viewer", () => {
  it("an admin approves with the status seen, then the viewer moves to the next item", async () => {
    await openFirstCutout();
    fireEvent.click(within(screen.getByTestId("hero-viewer-actions")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_hero_cutout")?.args)
      .toEqual({ p_source_url: U(1), p_action: "approve", p_expected_status: "ok", p_note: null }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName(/R2/));
    expect(screen.getByTestId("hero-viewer")).toBeInTheDocument();
  });

  it("when the decided one leaves the list (Waiting), the next one takes its place", async () => {
    decidedLeave = true;
    await openFirstCutout();
    key("ArrowRight");
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName(/R2/));
    fireEvent.click(within(screen.getByTestId("hero-viewer-actions")).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName(/R3/));
    expect(screen.getByTestId("hero-viewer-position")).toHaveTextContent("2 of 2");
  });

  it("rejecting a LIVE one asks first, then moves on", async () => {
    rows = [r(1, { status: "approved" }), r(2)];
    await openFirstCutout();
    fireEvent.click(within(screen.getByTestId("hero-viewer-actions")).getByRole("button", { name: "Reject (take off the hero)" }));
    expect(calls.some(c => c.fn === "review_hero_cutout")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_hero_cutout")?.args?.p_expected_status).toBe("approved"));
    await waitFor(() => expect(screen.getByRole("dialog", { name: /R2/ })).toBeInTheDocument());
  });

  it("Approve is disabled exactly where the card disables it (a failed run has no file)", async () => {
    rows = [r(1, { status: "failed", qa_status: "failed", cutout_path: null, width: null, height: null, flags: ["api_error:empty_mask"] })];
    await openFirstCutout(); // the empty cut-out thumbnail still opens the viewer
    const actions = await screen.findByTestId("hero-viewer-actions");
    expect(within(actions).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(actions).getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByTestId("hero-viewer-pane-cutout")).toHaveTextContent("No cut-out file");
  });

  it("a held item shows its reason in plain words", async () => {
    rows = [r(1, { status: "needs_review", qa_status: "needs_review", flags: ["low_res:418x370", "extra_objects:1"] })];
    await openFirstCutout();
    const flags = screen.getByTestId("hero-viewer-flags");
    expect(flags).toHaveTextContent("Photo is small (418×370)");
    expect(flags).toHaveTextContent("Extra object in the picture");
    expect(within(screen.getByTestId("hero-viewer-actions")).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("a non-admin can view and zoom but gets no buttons", async () => {
    overview.can_review = false;
    await openFirstCutout();
    expect(screen.queryByTestId("hero-viewer-actions")).toBeNull();
    expect(screen.getByTestId("hero-viewer-readonly")).toHaveTextContent("Only an admin can approve or reject.");
    fireEvent.click(within(viewer()).getByRole("button", { name: "200%" }));
    expect(zoomText()).toBe("200 %");
    expect(calls.some(c => c.fn === "review_hero_cutout")).toBe(false);
  });
});

describe("plain words and photo order", () => {
  it.each([
    ["low_res:418x370", "Photo is small (418×370)"],
    ["interior_hole:0.0042", "Possible hole erased inside the piece (0.4 % of the piece)"],
    ["relative_coverage:0.14", "Much less of the piece than the main photo (14 % of it)"],
    ["extra_objects:1", "Extra object in the picture"],
    ["extra_objects:2", "Extra objects in the picture (2)"],
    ["edge_touch:top,left", "Piece touches the photo edge (top, left)"],
    ["coverage:0.02", "Piece fills very little of the photo (2 %)"],
    ["coverage:0.91", "Piece fills almost the whole photo (91 %)"],
    ["api_error:empty_mask", "The cut-out could not be made (empty_mask)"],
    ["something_new", "something_new"],
  ])("%s → %s", (flag, text) => expect(heroFlagPlain(flag)).toBe(text));

  it("the longer detail reads interior_hole as a share of the piece, never pixels", () => {
    expect(describeHeroFlag("interior_hole:0.0042")).toBe("Part of the piece was erased from inside it (0.4 % of the piece) — e.g. a dial or a stone.");
    expect(describeHeroFlag("interior_hole:0.0042")).not.toContain("px");
  });

  it("photo numbers follow the workflow's order (run.py all_images)", () => {
    expect(heroPhotoOrder([
      { sort: 2, website_product_media: [{ url: "b2", sort: 0 }] },
      { sort: 1, website_product_media: [{ url: "a2", sort: 1 }, { url: "a1", sort: 0 }] },
    ])).toEqual(["a1", "b2", "a2"]);
    expect(heroPhotoOrder([{ website_product_media: [{ url: "x", sort: 0 }, { url: "x", sort: 1 }] }])).toEqual(["x"]);
  });
});

describe("zoom maths", () => {
  const img = { w: 1000, h: 500 };
  it("fit centres the whole image", () => {
    const p = placeImage(FIT, PANE, img);
    expect(p.width).toBe(800);
    expect(p.top).toBe(100);
    expect(zoomLabel(FIT, PANE, img)).toBe("Fit (80 %)");
  });
  it("zooming keeps the point under the cursor still", () => {
    const at = { x: 200, y: 150 };
    const before = placeImage(FIT, PANE, img);
    const u = (at.x - before.left) / before.scale;
    const v = zoomBy(FIT, 3, at, PANE, img);
    const after = placeImage(v, PANE, img);
    expect((at.x - after.left) / after.scale).toBeCloseTo(u, 6);
  });
  it("zooming out snaps to Fit; never past 800 %", () => {
    expect(zoomBy(zoomTo(FIT, 1, PANE, img), 0.1, { x: 0, y: 0 }, PANE, img)).toEqual(FIT);
    const big = zoomBy(zoomTo(FIT, 4, PANE, img), 10, { x: 400, y: 300 }, PANE, img);
    expect(big.fit ? 0 : big.scale).toBe(8);
  });
  it("dragging pans only when zoomed, and stays on the image", () => {
    expect(panBy(FIT, 50, 50, img)).toBe(FIT);
    const v = zoomTo(FIT, 2, PANE, img);
    const moved = panBy(v, -100000, 0, img);
    expect(moved.fit ? -1 : moved.cx).toBe(1);
  });
});
