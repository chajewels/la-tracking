import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Website → Photos (docs/MEDIA-CUTOUTS.md): the switch + limit card and the
 * review card, against mocked RPCs. The RPCs themselves are proven by
 * docs/sql/20261005_media_cutouts_local_tests.sql.
 */

const calls: { fn: string; args?: Record<string, unknown> }[] = [];
let overview: Record<string, unknown>;
let listRows: Record<string, unknown>[];
let providerRow: Record<string, unknown> | Error;
let tabTotals: Record<string, unknown> | Error;

vi.mock("@/lib/untyped-rpc", () => ({
  callUntypedRpc: async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "get_media_cutout_overview") return overview;
    if (fn === "get_media_cutout_provider") { if (providerRow instanceof Error) throw providerRow; return providerRow; }
    if (fn === "set_media_cutout_provider") return { ok: true, changed: true, provider: args?.p_provider ?? "photoroom", price_usd: String(args?.p_price_usd ?? "0.02") };
    if (fn === "get_media_cutout_tab_totals") { if (tabTotals instanceof Error) throw tabTotals; return tabTotals; }
    if (fn === "list_media_cutouts") return { total: listRows.length, rows: listRows };
    if (fn === "set_media_cutout_settings") return { ok: true, changed: true, mode: args?.p_mode ?? overview.mode, cap: args?.p_cap ?? overview.cap };
    if (fn === "review_media_cutout") return { ok: true, status: args?.p_action === "approve" ? "approved" : "rejected" };
    if (fn === "add_media_cutout_test_batch") return { ok: true, batch: args?.p_batch, photos: 3, queued_new: 3, tagged: 3, unknown_skus: ["ZZ9"] };
    return {};
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }), upload: vi.fn() }) },
    functions: { invoke: vi.fn(async () => ({ data: { ok: true, mode: "test", submitted: 2, ready: 1, processed: [] }, error: null })) },
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { MediaCutoutReviewCard, MediaCutoutSettingsCard } from "@/components/website/MediaCutoutsCard";

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const SRC = "https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/page365/1/11-100.jpg";

beforeEach(() => {
  calls.length = 0;
  providerRow = { found: true, provider: "photoroom", raw_provider: "photoroom", price_usd: "0.02", updated_at: null, updated_by_name: null };
  // Before migration 20261010100000 the RPC does not exist: the tabs fall back to the status counts.
  tabTotals = new Error("function get_media_cutout_tab_totals() does not exist");
  overview = {
    found: true, mode: "off", cap: 600, month: "2026-10", used: 480, bell_80_at: "2026-10-05T00:00:00Z",
    updated_at: null, updated_by_name: null, can_change: true, last_tick_at: null, last_tick: null,
    status_counts: { needs_review: 2, ok: 5 }, state_counts: {}, test_batches: [{ name: "Test 30", count: 30, done: 12 }],
    cpu_ms_p95: 640, cpu_ms_max: 900, cpu_fallbacks: 0,
  };
  listRows = [{
    id: "1", source_url: SRC, source_kind: "page365", priority: 0, test_batch: "Test 30", job_state: "done",
    status: "needs_review", flags: ["extra_objects:1", "low_res:418x370"], rerun: false, own_cutout_url: null,
    provider: "fal", model: "fal-ai/birefnet/v2:heavy", attempts: 0, last_error: null, source_w: 418, source_h: 370,
    output_kind: "baked", cutout_path: "website/derived/aa/r1/cutout.webp", catalog_path: "website/derived/aa/r1/catalog.webp",
    catalog_small_path: "website/derived/aa/r1/catalog-small.webp", hero_usable: false, timings: { total: 500 },
    last_rerun: null, review_note: null, reviewed_at: null, finished_at: null, updated_at: "2026-10-05T00:00:00Z",
    product: { id: "p", sku: "AL123", name: "K18 heart pendant", slug: "al123", status: "active" }, product_count: 1,
  }];
});

describe("switch and limit", () => {
  it("shows Off, the month's usage against the limit, and the test batch progress", async () => {
    wrap(<MediaCutoutSettingsCard />);
    expect(await screen.findByTestId("cutout-mode-badge")).toHaveTextContent("Off");
    expect(screen.getByTestId("cutout-mode-text")).toHaveTextContent("nothing is sent");
    expect(screen.getByTestId("cutout-usage")).toHaveTextContent("480 of 600 photos");
    expect(screen.getByTestId("cutout-test-batch")).toHaveTextContent("“Test 30”: 12 of 30 photos finished");
    expect(screen.getByRole("button", { name: /Run now/ })).toBeDisabled(); // nothing to run while Off
  });

  it("Test is one click; On asks first; each sends the mode the screen showed (stale-safe)", async () => {
    wrap(<MediaCutoutSettingsCard />);
    fireEvent.click(await screen.findByRole("radio", { name: "Test" }));
    await waitFor(() => expect(calls.find(c => c.fn === "set_media_cutout_settings")?.args)
      .toEqual({ p_mode: "test", p_cap: null, p_expected_mode: "off" }));
    calls.length = 0;
    fireEvent.click(screen.getByRole("radio", { name: "On" }));
    expect(await screen.findByText("Turn background removal on for every photo?")).toBeInTheDocument();
    expect(calls.some(c => c.fn === "set_media_cutout_settings")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(calls.find(c => c.fn === "set_media_cutout_settings")?.args?.p_mode).toBe("on"));
  });

  it("saves a new monthly limit and adds SKUs to a test batch", async () => {
    wrap(<MediaCutoutSettingsCard />);
    fireEvent.change(await screen.findByLabelText("Monthly limit"), { target: { value: "900" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
    await waitFor(() => expect(calls.find(c => c.fn === "set_media_cutout_settings")?.args).toMatchObject({ p_mode: null, p_cap: 900 }));
    fireEvent.change(screen.getByLabelText("SKUs"), { target: { value: "al112, al3\nR3110 zz9" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to test batch \(4 SKUs\)/ }));
    await waitFor(() => expect(calls.find(c => c.fn === "add_media_cutout_test_batch")?.args)
      .toEqual({ p_skus: ["AL112", "AL3", "R3110", "ZZ9"], p_batch: "Test 30", p_main_only: false }));
  });
});

describe("provider and estimated cost (Photoroom)", () => {
  it("shows Photoroom at $0.02 a photo and the month's estimate: 480 × $0.02 = $9.60, at most $12.00 at the 600 limit", async () => {
    wrap(<MediaCutoutSettingsCard />);
    const prov = await screen.findByTestId("cutout-provider");
    await waitFor(() => expect(prov).toHaveTextContent("Photoroom"));
    expect(screen.getByTestId("cutout-price")).toHaveTextContent("$0.02 a photo");
    expect(screen.getByTestId("cutout-cost")).toHaveTextContent("Estimated cost: $9.60 so far this month (480 × $0.02); at most $12.00 at the limit");
    expect(screen.getByTestId("cutout-last-run")).toHaveTextContent("It runs every minute while the switch is on.");
  });

  it("saves a price with the provider the screen showed", async () => {
    wrap(<MediaCutoutSettingsCard />);
    fireEvent.change(await screen.findByLabelText("Price per photo (US$, for the estimate)"), { target: { value: "0.025" } });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(calls.find(c => c.fn === "set_media_cutout_provider")?.args)
      .toEqual({ p_provider: null, p_price_usd: 0.025, p_expected_provider: "photoroom" }));
  });

  it("before the migration: says so, and still estimates at Photoroom's list price", async () => {
    providerRow = new Error("function get_media_cutout_provider() does not exist");
    wrap(<MediaCutoutSettingsCard />);
    expect(await screen.findByTestId("cutout-provider-missing")).toHaveTextContent("once the Photoroom migration has been run");
    expect(screen.getByTestId("cutout-cost")).toHaveTextContent("$9.60 so far");
  });

  it("the Turn-on question names the provider and the most it can cost", async () => {
    wrap(<MediaCutoutSettingsCard />);
    await waitFor(() => expect(screen.getByTestId("cutout-provider")).toHaveTextContent("Photoroom"));
    fireEvent.click(screen.getByRole("radio", { name: "On" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Every queued photo will be sent to Photoroom");
    expect(dialog).toHaveTextContent("up to 600 a month (at most about $12.00)");
  });
});

describe("review", () => {
  it("shows original → cut-out → catalogue, and the flags in plain words", async () => {
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    expect(within(row).getByText("AL123 · K18 heart pendant")).toBeInTheDocument();
    expect(within(row).getByAltText("Original")).toHaveAttribute("src", SRC);
    expect(within(row).getByAltText("Cut-out (hero)")).toHaveAttribute("src", "https://cdn.test/website/derived/aa/r1/cutout.webp");
    expect(within(row).getByAltText("Catalogue")).toHaveAttribute("src", "https://cdn.test/website/derived/aa/r1/catalog-small.webp");
    const flags = within(row).getByTestId("cutout-flags");
    expect(flags).toHaveTextContent('A second object is in the photo (e.g. an inset "BACK" view)');
    expect(flags).toHaveTextContent("Too small: 418 × 370 px (at least 800 px needed)");
    expect(calls.find(c => c.fn === "list_media_cutouts")?.args).toMatchObject({ p_filter: "needs_review" });
    expect(screen.getByRole("tab", { name: "Needs review (2)" })).toHaveAttribute("aria-selected", "true");
  });

  it("Approve sends the status the reviewer saw; Reject asks for an optional note", async () => {
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_media_cutout")?.args).toEqual({
      p_source_url: SRC, p_action: "approve", p_note: null, p_own_cutout_url: null, p_expected_status: "needs_review",
    }));
    calls.length = 0;
    fireEvent.click(within(row).getByRole("button", { name: "Reject" }));
    fireEvent.change(await screen.findByLabelText("Note"), { target: { value: "wrong piece" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_media_cutout")?.args).toMatchObject({ p_action: "reject", p_note: "wrong piece" }));
  });

  it("a photo being processed cannot be acted on", async () => {
    listRows[0].job_state = "processing";
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    expect(within(row).getByText("Processing…")).toBeInTheDocument();
    for (const name of ["Approve", "Reject", /Re-run/, /Upload my own/]) expect(within(row).getByRole("button", { name })).toBeDisabled();
  });
});

describe("large viewer (owner request 2026-09-27: thumbnails too small to judge)", () => {
  it("a thumbnail opens the original beside the full-size result; background, result and zoom switch", async () => {
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    fireEvent.click(within(row).getByRole("button", { name: "Open Cut-out (hero) large" }));

    const dialog = await screen.findByRole("dialog");
    const original = within(dialog).getByTestId("viewer-pane-original");
    const cut = within(dialog).getByTestId("viewer-pane-cutout");
    expect(within(original).getByRole("img")).toHaveAttribute("src", SRC);
    expect(within(cut).getByRole("img")).toHaveAttribute("src", "https://cdn.test/website/derived/aa/r1/cutout.webp");

    // Checkered by default; Black switches only the result's background.
    expect(cut.style.backgroundImage).toContain("linear-gradient");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Black" }));
    expect(cut.style.backgroundColor).toBe("rgb(0, 0, 0)");
    expect(original.style.backgroundColor).toBe("rgb(255, 255, 255)");

    // The catalogue shows its FULL file, never the small thumbnail.
    fireEvent.click(within(dialog).getByRole("radio", { name: "Catalogue" }));
    expect(within(within(dialog).getByTestId("viewer-pane-catalog")).getByRole("img"))
      .toHaveAttribute("src", "https://cdn.test/website/derived/aa/r1/catalog.webp");

    // Full size and back; both pictures zoom together.
    fireEvent.click(within(dialog).getByRole("button", { name: /Full size/ }));
    for (const img of within(dialog).getAllByRole("img")) expect(img.className).toContain("max-w-none");
    fireEvent.click(within(dialog).getByRole("button", { name: /Fit to screen/ }));
    for (const img of within(dialog).getAllByRole("img")) expect(img.className).toContain("max-h-full");

    expect(within(dialog).getByRole("link", { name: /Open catalogue in a new tab/ }))
      .toHaveAttribute("href", "https://cdn.test/website/derived/aa/r1/catalog.webp");
  });
});

describe("cut once (owner rule 2026-09-28): locked tabs, per-photo paid calls, admin-only reopen with the cost", () => {
  const TABS = {
    tabs: {
      needs_review: { count: 14, paid_calls: 14 }, needs_owner: { count: 2, paid_calls: 4 }, failed: { count: 495, paid_calls: 0 },
      auto_fixed: { count: 10, paid_calls: 10 }, queue: { count: 376, paid_calls: 6 }, completed: { count: 110, paid_calls: 112 },
      rejected: { count: 5, paid_calls: 5 }, test: { count: 6, paid_calls: 6 }, all: { count: 1002, paid_calls: 139 },
    },
    is_admin: true, per_photo_limit: 2, provider: "replicate", price_usd: "0.005",
  };
  const openTab = async (name: RegExp) => { fireEvent.click(await screen.findByRole("tab", { name })); };

  it("tabs carry their photo counts; the open tab shows its paid calls and cost; the month's used / limit stays visible", async () => {
    tabTotals = TABS;
    wrap(<MediaCutoutReviewCard />);
    expect(await screen.findByRole("tab", { name: "Completed (110)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Needs owner (2)" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Published/ })).toBeNull();
    expect(screen.getByTestId("cutout-month-usage")).toHaveTextContent("This month: 480 of 600 paid calls · each photo is cut once, at most 2 paid calls");
    expect(screen.getByTestId("cutout-tab-totals")).toHaveTextContent("Needs review: 14 photos · 14 paid calls (about $0.07)");
    await openTab(/^Completed/);
    await waitFor(() => expect(screen.getByTestId("cutout-tab-totals")).toHaveTextContent("Completed: 110 photos · 112 paid calls (about $0.56)"));
    expect(calls.filter(c => c.fn === "list_media_cutouts").at(-1)?.args).toMatchObject({ p_filter: "completed" });
  });

  it("Completed: locked, no Re-run; the admin's Unlock and re-cut confirms 1 paid call and its cost, then sends it with the reason", async () => {
    tabTotals = TABS;
    Object.assign(listRows[0], { status: "approved", flags: [], paid_calls: 1, paid_call_limit: 2 });
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    expect(within(row).getByTestId("cutout-locked")).toHaveTextContent("Locked");
    expect(within(row).getByTestId("cutout-paid-calls")).toHaveTextContent("Paid calls: 1 of 2");
    expect(within(row).queryByRole("button", { name: /Re-run/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Upload my own/ })).toBeNull();
    fireEvent.click(await within(row).findByRole("button", { name: /Unlock and re-cut/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Unlock and re-cut this photo?");
    expect(dialog).toHaveTextContent("This sends it to Replicate (BiRefNet) once: 1 paid call, about $0.005.");
    expect(dialog).toHaveTextContent("Paid calls for this photo so far: 1. Recorded in the audit log.");
    expect(calls.some(c => c.fn === "review_media_cutout")).toBe(false); // nothing is spent before the confirm
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "owner wants a cleaner edge" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send once (1 paid call)" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_media_cutout")?.args).toEqual({
      p_source_url: SRC, p_action: "unlock_recut", p_note: "owner wants a cleaner edge", p_own_cutout_url: null, p_expected_status: "approved",
    }));
  });

  it("Completed for a non-admin: no reopen button, it says only an admin can", async () => {
    tabTotals = { ...TABS, is_admin: false };
    Object.assign(listRows[0], { status: "ok", flags: [], paid_calls: 1 });
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    expect(await within(row).findByTestId("cutout-admin-only")).toHaveTextContent("Only an admin can send it for another paid cut.");
    expect(within(row).queryByRole("button", { name: /Unlock and re-cut/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Re-run/ })).toBeNull();
  });

  it("Rejected: the normal photo stays; Upload my own cut-out (free) and the admin's Try once more (confirmed, 1 paid call)", async () => {
    tabTotals = TABS;
    Object.assign(listRows[0], { status: "rejected", paid_calls: 1 });
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    expect(within(row).getByText(/The website shows the normal photo/)).toBeInTheDocument();
    for (const name of ["Approve", "Reject", /Re-run/]) expect(within(row).queryByRole("button", { name })).toBeNull();
    expect(within(row).getByRole("button", { name: /Upload my own cut-out/ })).toBeEnabled();
    fireEvent.click(await within(row).findByRole("button", { name: "Try once more" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("The website keeps the normal photo unless the new cut-out passes.");
    expect(dialog).toHaveTextContent("1 paid call, about $0.005");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send once (1 paid call)" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_media_cutout")?.args).toMatchObject({ p_action: "retry_once", p_expected_status: "rejected" }));
  });

  it("Needs owner: the reason in plain words; no Re-run; the admin can allow ONE more paid call after a confirm", async () => {
    tabTotals = TABS;
    Object.assign(listRows[0], {
      status: "failed", job_state: "error", flags: ["api_error:HTTP 502"], paid_calls: 2, paid_call_limit: 2,
      cutout_path: null, catalog_path: null, catalog_small_path: null,
      hold_reason: "Stopped after 2 paid calls (the limit for this photo is 2). Last error: replicate submit: HTTP 502",
    });
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    expect(within(row).getByTestId("cutout-hold-reason")).toHaveTextContent("Needs owner: Stopped after 2 paid calls");
    expect(within(row).getByTestId("cutout-paid-calls")).toHaveTextContent("Paid calls: 2 of 2");
    expect(within(row).queryByRole("button", { name: /Re-run/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "Keep the normal photo" })).toBeEnabled();
    fireEvent.click(await within(row).findByRole("button", { name: "Allow one more paid call" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("It stopped after 2 paid calls, the limit for one photo.");
    expect(dialog).toHaveTextContent("If that call fails it is not retried");
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow 1 paid call" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_media_cutout")?.args).toMatchObject({ p_action: "override_cap" }));
  });

  it("a photo that has used its 2 paid calls cannot be re-run", async () => {
    tabTotals = TABS;
    Object.assign(listRows[0], { paid_calls: 2, paid_call_limit: 2 });
    wrap(<MediaCutoutReviewCard />);
    const row = await screen.findByTestId("cutout-row");
    expect(within(row).getByRole("button", { name: /Re-run/ })).toBeDisabled();
    expect(within(row).getByText(/has used all its paid calls; Re-run is off/)).toBeInTheDocument();
  });
});
