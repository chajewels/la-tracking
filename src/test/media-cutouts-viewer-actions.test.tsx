import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Website → Photos zoom viewer (owner request 2026-09-28: "the approved button
 * should be there also same as the Hero Cut outs"). The viewer shows the row's
 * own buttons for the photo's state (CutoutActionButtons), calls the card's one
 * handler (review_media_cutout, once), moves to the next photo of the tab after
 * a success, closes when nothing is left, and stays open on an error.
 * Completed stays final: no Re-run in the viewer either.
 */

const calls: { fn: string; args?: Record<string, unknown> }[] = [];
let listRows: Record<string, unknown>[];
let isAdmin: boolean;
let failReview: string | null;
// Deciding a photo takes it out of the open tab, as the real list does.
let decidedLeaveTab: boolean;
// Holds the review call open, so the test can see the buttons while it runs.
let gate: Promise<void> | null;

vi.mock("@/lib/untyped-rpc", () => ({
  callUntypedRpc: async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "get_media_cutout_overview") {
      return { found: true, mode: "on", cap: 600, month: "2026-10", used: 10, status_counts: { needs_review: listRows.length }, state_counts: {}, test_batches: [] };
    }
    if (fn === "get_media_cutout_tab_totals") {
      return { tabs: { needs_review: { count: listRows.length, paid_calls: listRows.length } }, is_admin: isAdmin, per_photo_limit: 2, provider: "photoroom", price_usd: "0.02" };
    }
    if (fn === "list_media_cutouts") return { total: listRows.length, rows: listRows.map(r => ({ ...r })) };
    if (fn === "review_media_cutout") {
      if (gate) await gate;
      if (failReview) throw new Error(failReview);
      if (decidedLeaveTab) listRows = listRows.filter(r => r.source_url !== args?.p_source_url);
      return { ok: true, status: args?.p_action === "approve" ? "approved" : "rejected" };
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
  job_state: "done", status: "needs_review", flags: ["extra_objects:1"], rerun: false, own_cutout_url: null,
  provider: "photoroom", model: "photoroom", attempts: 1, last_error: null, source_w: 1200, source_h: 1200,
  output_kind: "baked", cutout_path: `website/derived/${n}/cutout.webp`, catalog_path: `website/derived/${n}/catalog.webp`,
  catalog_small_path: `website/derived/${n}/catalog-small.webp`, hero_usable: false, timings: {}, last_rerun: null,
  review_note: null, reviewed_at: null, finished_at: null, updated_at: "2026-10-05T00:00:00Z", paid_calls: 1, paid_call_limit: 2,
  published: true, product: { id: `p${n}`, sku: `AL${n}`, name: `Piece ${n}`, slug: `al${n}`, status: "active" }, product_count: 1,
  ...extra,
});

// hidden: the list behind the open dialog is aria-hidden by the dialog.
const buttons = (el: HTMLElement) => within(el).queryAllByRole("button", { hidden: true }) as HTMLButtonElement[];
const buttonNames = (el: HTMLElement) => buttons(el).map(b => b.textContent?.trim());

async function openViewerOn(index = 0) {
  const rows = await screen.findAllByTestId("cutout-row");
  // Wait for the admin flag (tab totals) so both surfaces render the same set.
  await waitFor(() => expect(calls.some(c => c.fn === "get_media_cutout_tab_totals")).toBe(true));
  fireEvent.click(within(rows[index]).getByRole("button", { name: "Open Original large" }));
  return screen.findByTestId("cutout-viewer");
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  listRows = [photo(1), photo(2), photo(3)];
  isAdmin = true;
  failReview = null;
  decidedLeaveTab = true;
  gate = null;
});

describe("zoom viewer: the row's own actions for the photo's state", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["needs_review", {}],
    ["ok (Completed)", { status: "ok", flags: [] }],
    ["auto_fixed (Completed)", { status: "auto_fixed", flags: [] }],
    ["approved (Completed)", { status: "approved", flags: [] }],
    ["kept_original (Completed)", { status: "kept_original", flags: [], cutout_path: null }],
    ["rejected", { status: "rejected" }],
    ["failed", { status: "failed", job_state: "error", cutout_path: null, catalog_path: null, catalog_small_path: null, last_error: "bad photo" }],
    ["needs owner", { status: "failed", job_state: "error", hold_reason: "Stopped after 2 paid calls", paid_calls: 2 }],
    ["pending, in the queue", { status: "pending", job_state: "queued", flags: [] }],
    ["processing", { status: "needs_review", job_state: "submitted" }],
  ];
  for (const [label, extra] of cases) {
    it(`${label}: the viewer offers exactly the row's buttons, enabled the same way`, async () => {
      listRows = [photo(1, extra)];
      wrap(<MediaCutoutReviewCard />);
      const viewer = await openViewerOn(0);
      const rowActions = screen.getAllByTestId("cutout-actions")[0];
      const viewerActions = within(viewer).getByTestId("viewer-actions");
      expect(buttonNames(viewerActions)).toEqual(buttonNames(rowActions));
      const enabled = (el: HTMLElement) => buttons(el).map(b => b.disabled);
      expect(enabled(viewerActions)).toEqual(enabled(rowActions));
      expect(buttonNames(viewerActions).length).toBeGreaterThan(0);
    });
  }

  it("Passed is final in the viewer too (approval first): 'To approve', no Re-run, Approve enabled", async () => {
    listRows = [photo(1, { status: "ok", flags: [] })];
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    expect(within(viewer).getByRole("heading")).toHaveTextContent("AL1");
    expect(within(viewer).getByTestId("viewer-status")).toHaveTextContent("To approve");
    expect(within(within(viewer).getByTestId("viewer-actions")).queryByRole("button", { name: /Re-run/ })).toBeNull();
    expect(within(viewer).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("needs_review: shows the product code and 'Needs review', with Approve and Re-run", async () => {
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    expect(within(viewer).getByRole("heading")).toHaveTextContent("AL1");
    expect(within(viewer).getByTestId("viewer-status")).toHaveTextContent("Needs review");
    expect(within(viewer).getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(within(viewer).getByRole("button", { name: /Re-run/ })).toBeEnabled();
    expect(within(viewer).getByTestId("viewer-position")).toHaveTextContent("1 of 3");
  });

  it("a FAILED photo at its paid-call limit offers 'Allow one more paid call' to an admin (NL366)", async () => {
    listRows = [photo(1, { status: "failed", job_state: "error", cutout_path: null, catalog_path: null, catalog_small_path: null,
                           last_error: "compositor exceeded the CPU limit twice", paid_calls: 2, paid_call_limit: 2 })];
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    expect(within(viewer).getByRole("button", { name: "Allow one more paid call" })).toBeEnabled();
  });

  it("a FAILED photo still under its limit does not offer the extra paid call", async () => {
    listRows = [photo(1, { status: "failed", job_state: "error", cutout_path: null, catalog_path: null, catalog_small_path: null,
                           last_error: "bad photo", paid_calls: 1, paid_call_limit: 2 })];
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    expect(within(viewer).queryByRole("button", { name: "Allow one more paid call" })).toBeNull();
  });

  it("Try once more stays admin-only in the viewer", async () => {
    isAdmin = false;
    listRows = [photo(1, { status: "rejected" })];
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    expect(within(viewer).queryByRole("button", { name: "Try once more" })).toBeNull();
  });
});

describe("zoom viewer: deciding", () => {
  it("Approve calls review_media_cutout once with the status seen, toasts, updates the tab count and moves to the next photo", async () => {
    let release!: () => void;
    gate = new Promise(r => { release = r; });
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    const approve = within(viewer).getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    // Disabled while running: every button, and a second click sends nothing.
    await waitFor(() => expect(approve).toBeDisabled());
    for (const b of buttons(within(viewer).getByTestId("viewer-actions"))) expect(b).toBeDisabled();
    fireEvent.click(approve);
    release();
    await waitFor(() => expect(within(screen.getByTestId("cutout-viewer")).getByRole("heading")).toHaveTextContent("AL2"));
    const reviews = calls.filter(c => c.fn === "review_media_cutout");
    expect(reviews).toHaveLength(1);
    expect(reviews[0].args).toMatchObject({ p_source_url: "https://cdn.test/src/1.jpg", p_action: "approve", p_expected_status: "needs_review" });
    expect(toast.success).toHaveBeenCalledWith("Approved.");
    expect(screen.getByRole("tab", { name: "Needs review (2)", hidden: true })).toBeInTheDocument();
    expect(within(screen.getByTestId("cutout-viewer")).getByTestId("viewer-position")).toHaveTextContent("1 of 2");
    expect(screen.getAllByTestId("cutout-row")).toHaveLength(2);
  });

  it("in a tab the photo stays in (All), it moves to the row after it", async () => {
    decidedLeaveTab = false;
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(1);
    fireEvent.click(within(viewer).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(within(screen.getByTestId("cutout-viewer")).getByRole("heading")).toHaveTextContent("AL3"));
  });

  it("the last photo of the tab: after the decision the viewer closes", async () => {
    listRows = [photo(1)];
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    fireEvent.click(within(viewer).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByTestId("cutout-viewer")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith("Approved.");
  });

  it("an error keeps the viewer open on the same photo and says what went wrong", async () => {
    failReview = "Network down";
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    fireEvent.click(within(viewer).getByRole("button", { name: "Approve" }));
    expect(await within(viewer).findByTestId("viewer-error")).toHaveTextContent("Network down");
    expect(toast.error).toHaveBeenCalledWith("Network down");
    expect(within(viewer).getByRole("heading")).toHaveTextContent("AL1");
    expect(within(viewer).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("Reject from the viewer uses the row's note dialog, then moves on", async () => {
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    fireEvent.click(within(viewer).getByRole("button", { name: "Reject" }));
    const dialogs = await screen.findAllByRole("dialog");
    const confirm = dialogs.find(d => d.textContent?.includes("Reject this cut-out?"))!;
    fireEvent.change(within(confirm).getByLabelText("Note"), { target: { value: "stand left in" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(within(screen.getByTestId("cutout-viewer")).getByRole("heading")).toHaveTextContent("AL2"));
    const reviews = calls.filter(c => c.fn === "review_media_cutout");
    expect(reviews).toHaveLength(1);
    expect(reviews[0].args).toMatchObject({ p_action: "reject", p_note: "stand left in", p_expected_status: "needs_review" });
  });

  it("a decision on the row itself does not open or move a viewer", async () => {
    wrap(<MediaCutoutReviewCard />);
    const rows = await screen.findAllByTestId("cutout-row");
    await waitFor(() => expect(calls.some(c => c.fn === "get_media_cutout_tab_totals")).toBe(true));
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.filter(c => c.fn === "review_media_cutout")).toHaveLength(1));
    expect(screen.queryByTestId("cutout-viewer")).toBeNull();
  });

  it("keys: → next, ← previous, as in the hero viewer", async () => {
    wrap(<MediaCutoutReviewCard />);
    const viewer = await openViewerOn(0);
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    await waitFor(() => expect(within(viewer).getByRole("heading")).toHaveTextContent("AL2"));
    fireEvent.keyDown(viewer, { key: "ArrowLeft" });
    await waitFor(() => expect(within(viewer).getByRole("heading")).toHaveTextContent("AL1"));
  });
});
