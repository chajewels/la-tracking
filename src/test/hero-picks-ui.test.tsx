import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Hero picks (migration 20261013100000, docs/HERO-PICKS.md), Website → Photos:
 * the "Use on hero" tick in CutoutActionButtons (row AND zoom viewer), disabled
 * with its reason when the cut-out is not usable, admin only; the Hero tab with
 * its counts; the hero switch (asks first, says what the website will show);
 * the carry-over (preview first, then apply). Against mocked RPCs — the rules
 * themselves are proven by docs/sql/20261013_hero_picks_local_tests.sql.
 */

const calls: { fn: string; args?: Record<string, unknown> }[] = [];
let listRows: Record<string, unknown>[];
let isAdmin: boolean;
let withHero: boolean;
let source: string;
let failPick: string | null;

vi.mock("@/lib/untyped-rpc", () => ({
  callUntypedRpc: async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "get_media_cutout_overview") {
      return { found: true, mode: "on", cap: 600, month: "2026-10", used: 10, status_counts: {}, state_counts: {}, test_batches: [] };
    }
    if (fn === "get_media_cutout_tab_totals") {
      return {
        tabs: {
          needs_review: { count: 1, paid_calls: 1 }, completed: { count: listRows.length, paid_calls: listRows.length },
          ...(withHero ? { hero: { count: 3, paid_calls: 3, usable: 2, products_on_hero: 2, published_left_out: 301, published_in_stock: 303 } } : {}),
        },
        is_admin: isAdmin, per_photo_limit: 2, provider: "replicate", price_usd: "0.005",
        ...(withHero ? { hero_photo_source: source } : {}),
      };
    }
    if (fn === "list_media_cutouts") return { total: listRows.length, rows: listRows.map(r => ({ ...r })) };
    if (fn === "set_hero_pick") {
      if (failPick) return { error: failPick };
      listRows = listRows.map(r => r.source_url === args?.p_source_url ? { ...r, hero_pick: args?.p_pick } : r);
      return { ok: true, hero_pick: args?.p_pick, changed: true };
    }
    if (fn === "set_hero_photo_source") { source = String(args?.p_source); return { ok: true, changed: true, source }; }
    if (fn === "hero_picks_carry_over") {
      return args?.p_apply
        ? { ok: true, applied: true, approved_hero: 58, already_ticked: 47, ticked: 44, left_out: { not_published: 4 },
            products_now: { published_in_stock: 303, products_on_hero: 41, published_left_out: 262 } }
        : { ok: true, applied: false, approved_hero: 58, already_ticked: 3, to_tick: 44,
            left_out: { kept_original: 2, not_completed: 5, not_published: 4 },
            products_now: { published_in_stock: 303, products_on_hero: 2, published_left_out: 301 },
            products_after: { published_in_stock: 303, products_on_hero: 41, published_left_out: 262 } };
    }
    return {};
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }), upload: vi.fn() }) },
    functions: { invoke: vi.fn() },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { MediaCutoutReviewCard } from "@/components/website/MediaCutoutsCard";
import { toast } from "sonner";

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const photo = (n: number, extra: Record<string, unknown> = {}) => ({
  id: String(n), source_url: `https://cdn.test/src/${n}.jpg`, source_kind: "page365", priority: 0, test_batch: null,
  job_state: "done", status: "ok", flags: [], rerun: false, own_cutout_url: null, provider: "replicate", model: "birefnet",
  attempts: 1, last_error: null, source_w: 1200, source_h: 1200, output_kind: "baked",
  cutout_path: `website/derived/${n}/cutout.webp`, catalog_path: `website/derived/${n}/catalog.webp`,
  catalog_small_path: `website/derived/${n}/catalog-small.webp`, hero_usable: null, timings: {}, last_rerun: null,
  review_note: null, reviewed_at: null, finished_at: null, updated_at: "2026-10-05T00:00:00Z", paid_calls: 1, paid_call_limit: 2,
  published: true, product: { id: `p${n}`, sku: `AL${n}`, name: `Piece ${n}`, slug: `al${n}`, status: "active" }, product_count: 1,
  hero_pick: false, hero_pick_blocker: null, ...extra,
});

const heroBox = (el: HTMLElement) => within(el).getByTestId("hero-pick");
const tickOf = (el: HTMLElement) => within(heroBox(el)).getByRole("checkbox", { hidden: true });
const ready = () => waitFor(() => expect(calls.some(c => c.fn === "get_media_cutout_tab_totals")).toBe(true));
const openTab = async (name: RegExp) => fireEvent.click(await screen.findByRole("tab", { name }));

beforeEach(() => {
  calls.length = 0;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  listRows = [photo(1)];
  isAdmin = true;
  withHero = true;
  source = "hero_record";
  failPick = null;
});

describe("Use on hero — the tick", () => {
  it("before the migration: no tick and no Hero tab", async () => {
    withHero = false;
    listRows = [photo(1, { hero_pick: undefined, hero_pick_blocker: undefined })];
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    await ready();
    expect(within(row).queryByTestId("hero-pick")).toBeNull();
    expect(screen.queryByRole("tab", { name: /^Hero/ })).toBeNull();
  });

  it("a usable cut-out: an admin ticks it — one call, a toast, the list refreshed", async () => {
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    await ready();
    const tick = await waitFor(() => { const t = tickOf(row); expect(t).toBeEnabled(); return t; });
    expect(tick).toHaveAttribute("data-state", "unchecked");
    expect(within(row).queryByTestId("hero-pick-note")).toBeNull();
    const listed = calls.filter(c => c.fn === "list_media_cutouts").length;
    fireEvent.click(tick);
    await waitFor(() => expect(calls.filter(c => c.fn === "set_hero_pick")).toHaveLength(1));
    expect(calls.find(c => c.fn === "set_hero_pick")?.args).toEqual({ p_source_url: "https://cdn.test/src/1.jpg", p_pick: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Ticked "Use on hero"\. The website keeps using the hero record/)));
    await waitFor(() => expect(calls.filter(c => c.fn === "list_media_cutouts").length).toBeGreaterThan(listed));
    await waitFor(() => expect(tickOf(screen.getByTestId("cutout-row"))).toHaveAttribute("data-state", "checked"));
  });

  const blocked: Array<[string, Record<string, unknown>, RegExp]> = [
    ["kept original", { status: "kept_original", cutout_path: null, hero_pick_blocker: "kept_original" }, /the original photo was kept/],
    ["rejected", { status: "rejected", hero_pick_blocker: "rejected" }, /the cut-out was rejected/],
    ["not finished", { status: "needs_review", hero_pick_blocker: "not_completed" }, /not finished and approved yet/],
    ["no file", { cutout_path: null, hero_pick_blocker: "no_cutout_file" }, /has no file/],
    ["product not published", { published: false, hero_pick_blocker: "not_published" }, /its product is not published/],
  ];
  for (const [label, extra, reason] of blocked) {
    it(`${label}: disabled, with the plain reason`, async () => {
      listRows = [photo(1, extra)];
      wrap(<MediaCutoutReviewCard />);
      const row = await screen.findByTestId("cutout-row");
      await ready();
      await waitFor(() => expect(within(row).getByTestId("hero-pick-note")).toHaveTextContent(reason));
      expect(within(row).getByTestId("hero-pick-note")).toHaveTextContent(/^Can't be on the hero: /);
      expect(tickOf(row)).toBeDisabled();
    });
  }

  it("ticked but no longer usable: shown ticked, can be unticked, says why it is off the hero", async () => {
    listRows = [photo(1, { hero_pick: true, published: false, hero_pick_blocker: "not_published" })];
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    await ready();
    await waitFor(() => expect(tickOf(row)).toBeEnabled());
    expect(tickOf(row)).toHaveAttribute("data-state", "checked");
    expect(within(row).getByTestId("hero-pick-note")).toHaveTextContent("Ticked, but not on the hero: its product is not published.");
    fireEvent.click(tickOf(row));
    await waitFor(() => expect(calls.find(c => c.fn === "set_hero_pick")?.args).toMatchObject({ p_pick: false }));
  });

  it("not an admin: read-only, says so", async () => {
    isAdmin = false;
    listRows = [photo(1, { hero_pick: true })];
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    await ready();
    await waitFor(() => expect(within(row).getByTestId("hero-pick-note")).toHaveTextContent("Only an admin can choose the hero photos."));
    expect(tickOf(row)).toBeDisabled();
    expect(tickOf(row)).toHaveAttribute("data-state", "checked");
  });

  it("a refusal shows the reason in plain words", async () => {
    failPick = "not_published";
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    await ready();
    await waitFor(() => expect(tickOf(row)).toBeEnabled());
    fireEvent.click(tickOf(row));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Cannot use this photo on the hero: its product is not published."));
  });

  it("the zoom viewer has the same tick", async () => {
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    await ready();
    await waitFor(() => expect(tickOf(row)).toBeEnabled());
    fireEvent.click(within(row).getByRole("button", { name: "Open Original large" }));
    const viewer = await screen.findByTestId("cutout-viewer");
    const tick = tickOf(within(viewer).getByTestId("viewer-actions"));
    expect(tick).toBeEnabled();
    fireEvent.click(tick);
    await waitFor(() => expect(calls.filter(c => c.fn === "set_hero_pick")).toHaveLength(1));
    expect(screen.getByTestId("cutout-viewer")).toBeInTheDocument();
  });
});

describe("Hero tab", () => {
  it("counts: ticked photos, products on the hero, published products left out", async () => {
    wrap(<MediaCutoutReviewCard />);
    await openTab(/^Hero \(3\)/);
    const panel = await screen.findByTestId("hero-picks-panel");
    const counts = within(panel).getByTestId("hero-picks-counts");
    expect(counts).toHaveTextContent("Ticked photos3");
    expect(counts).toHaveTextContent("1 not usable now");
    expect(counts).toHaveTextContent("Products on the hero2of 303 published and in stock");
    expect(counts).toHaveTextContent("Published products left out301");
    await waitFor(() => expect(calls.filter(c => c.fn === "list_media_cutouts").at(-1)?.args).toMatchObject({ p_filter: "hero" }));
  });

  it("the switch shows its value; changing it asks first and says what the website will show", async () => {
    wrap(<MediaCutoutReviewCard />);
    await openTab(/^Hero/);
    const panel = await screen.findByTestId("hero-picks-panel");
    expect(within(panel).getByTestId("hero-source-badge")).toHaveTextContent("Hero record (approved hero cut-outs)");
    fireEvent.click(within(panel).getByRole("radio", { name: "Ticked product cut-outs" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByTestId("hero-source-confirm")).toHaveTextContent("shows ONLY product cut-outs ticked");
    expect(dialog).toHaveTextContent("Right now that is 2 of 303 published products in stock; 301 would leave the hero");
    expect(calls.some(c => c.fn === "set_hero_photo_source")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some(c => c.fn === "set_hero_photo_source")).toBe(false);

    fireEvent.click(within(panel).getByRole("radio", { name: "Ticked product cut-outs" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(calls.find(c => c.fn === "set_hero_photo_source")?.args)
      .toEqual({ p_source: "product_ticks", p_expected_source: "hero_record" }));
    await waitFor(() => expect(within(screen.getByTestId("hero-picks-panel")).getByTestId("hero-source-badge"))
      .toHaveTextContent("Ticked product cut-outs"));
  });

  it("carry-over: preview first (nothing written), then one apply", async () => {
    wrap(<MediaCutoutReviewCard />);
    await openTab(/^Hero/);
    const panel = await screen.findByTestId("hero-picks-panel");
    fireEvent.click(within(panel).getByRole("button", { name: /Carry over approved hero cut-outs/ }));
    const dialog = await screen.findByRole("alertdialog");
    const preview = within(dialog).getByTestId("hero-carry-over-preview");
    expect(preview).toHaveTextContent("58 approved hero cut-outs: 44 will be ticked, 3 already ticked.");
    expect(preview).toHaveTextContent("2 — the original photo was kept");
    expect(preview).toHaveTextContent("4 — its product is not published");
    expect(preview).toHaveTextContent("Products on the hero: 2 → 41 of 303 published in stock; 262 left out.");
    expect(preview).toHaveTextContent("The website does not change");
    expect(calls.filter(c => c.fn === "hero_picks_carry_over").map(c => c.args)).toEqual([{ p_apply: false }]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Tick 44 photos" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Ticked 44 photos from the approved hero cut-outs. Saved to the audit log."));
    expect(calls.filter(c => c.fn === "hero_picks_carry_over").map(c => c.args)).toEqual([{ p_apply: false }, { p_apply: true }]);
  });

  it("not an admin: counts only — no carry-over, the switch cannot be changed", async () => {
    isAdmin = false;
    wrap(<MediaCutoutReviewCard />);
    await openTab(/^Hero/);
    const panel = await screen.findByTestId("hero-picks-panel");
    expect(within(panel).queryByTestId("hero-carry-over")).toBeNull();
    expect(within(panel).getByRole("radio", { name: "Ticked product cut-outs" })).toBeDisabled();
    expect(panel).toHaveTextContent("Only an admin can change this.");
  });
});
