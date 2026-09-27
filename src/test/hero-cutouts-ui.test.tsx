import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Website → Photos → Hero cut-outs (docs/HERO-CUTOUTS.md): the HERO-ONLY
 * record's card, against mocked RPCs. The RPCs themselves (admin-only
 * decisions, audit rows, the switch guard, service-only writes) are proven by
 * docs/sql/20261009_hero_cutouts_local_tests.sql.
 */

const calls: { fn: string; args?: Record<string, unknown> }[] = [];
let overview: Record<string, unknown>;
let rows: Record<string, unknown>[];

vi.mock("@/lib/untyped-rpc", () => ({
  callUntypedRpc: async (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "get_hero_cutout_overview") return overview;
    if (fn === "list_hero_cutouts") return { total: rows.length, rows };
    if (fn === "review_hero_cutout") return overview.can_review ? { ok: true, status: args?.p_action === "approve" ? "approved" : "rejected" } : { error: "admin_only" };
    if (fn === "set_hero_cutout_mode") return { ok: true, changed: true, mode: args?.p_mode };
    return {};
  },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { HeroCutoutsCard } from "@/components/website/HeroCutoutsCard";
import { describeHeroFlag, heroActions } from "@/lib/hero-cutouts";

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};
const SRC = "https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/page365/1/11-100.jpg";
const r = (over: Record<string, unknown>) => ({
  id: "1", source_url: SRC, source_sha256: "a".repeat(64), source_width: 1440, source_height: 1440, status: "ok",
  qa_status: "ok", flags: [], coverage: 0.4, cutout_path: "website/derived/hero/aa/bb/cutout.webp", width: 700, height: 900,
  model: "birefnet-general@epoch_244", auto_approved: false, reviewed_at: null, review_note: null,
  updated_at: "2026-09-28T00:00:00Z", product: { id: "p", sku: "C0853", name: "Bvlgari watch", slug: "c0853", status: "active" },
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  overview = { mode: "approve", updated_at: null, updated_by_name: null, can_review: true,
               status_counts: { ok: 1, needs_review: 2, approved: 1 }, last_recorded_at: null };
  rows = [r({})];
});

describe("go-live switch", () => {
  it("ships OFF: approve first, and the badge says so", async () => {
    wrap(<HeroCutoutsCard />);
    expect(await screen.findByTestId("hero-mode-badge")).toHaveTextContent("Automatic go-live: OFF");
    expect(screen.getByText(/every new hero cut-out waits for an admin/i)).toBeInTheDocument();
  });

  it("an admin turns it on only after confirming, sending the mode they saw", async () => {
    wrap(<HeroCutoutsCard />);
    const toggle = await screen.findByTestId("hero-mode-toggle");
    fireEvent.click(within(toggle).getByText("Automatic"));
    expect(calls.some(c => c.fn === "set_hero_cutout_mode")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Yes, change it" }));
    await waitFor(() => expect(calls.find(c => c.fn === "set_hero_cutout_mode")?.args).toEqual({ p_mode: "auto", p_expected_mode: "approve" }));
  });

  it("a non-admin cannot change it", async () => {
    overview.can_review = false;
    wrap(<HeroCutoutsCard />);
    const toggle = await screen.findByTestId("hero-mode-toggle");
    for (const b of within(toggle).getAllByRole("radio")) expect(b).toBeDisabled();
    expect(screen.getByText("Only an admin can change this.")).toBeInTheDocument();
  });
});

describe("the queue", () => {
  it("opens on Waiting for approval and approves with the status the admin saw", async () => {
    wrap(<HeroCutoutsCard />);
    await screen.findByTestId("hero-cutout-row");
    expect(calls.find(c => c.fn === "list_hero_cutouts")?.args?.p_filter).toBe("waiting");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_hero_cutout")?.args)
      .toEqual({ p_source_url: SRC, p_action: "approve", p_expected_status: "ok", p_note: null }));
  });

  it("rejects a LIVE one only after confirming (take it off the hero)", async () => {
    rows = [r({ status: "approved" })];
    wrap(<HeroCutoutsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject (take off the hero)" }));
    expect(calls.some(c => c.fn === "review_hero_cutout")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() => expect(calls.find(c => c.fn === "review_hero_cutout")?.args?.p_expected_status).toBe("approved"));
  });

  it("explains held photos in plain words", async () => {
    rows = [r({ status: "needs_review", qa_status: "needs_review", flags: ["interior_hole:1850", "low_res:463x495", "relative_coverage:0.14"] })];
    wrap(<HeroCutoutsCard />);
    const flags = await screen.findByTestId("hero-cutout-flags");
    expect(flags).toHaveTextContent("erased from inside it");
    expect(flags).toHaveTextContent("too small for the hero (463 × 495 px");
    expect(flags).toHaveTextContent("far less of the piece than the main photo (14 %");
  });

  it("a non-admin sees the queue but no buttons", async () => {
    overview.can_review = false;
    wrap(<HeroCutoutsCard />);
    expect(await screen.findByTestId("hero-cutout-readonly")).toHaveTextContent("Only an admin can approve or reject.");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reject/ })).toBeNull();
  });
});

describe("rules", () => {
  it("a failed run cannot be approved; a rejected one can be approved again; reject is always possible otherwise", () => {
    expect(heroActions({ status: "failed", qa_status: "failed" })).toEqual({ approve: false, reject: true });
    expect(heroActions({ status: "rejected", qa_status: "ok" })).toEqual({ approve: true, reject: false });
    expect(heroActions({ status: "approved", qa_status: "auto_fixed" })).toEqual({ approve: false, reject: true });
    expect(heroActions({ status: "needs_review", qa_status: "needs_review" })).toEqual({ approve: true, reject: true });
  });
  it("describes unknown flags verbatim", () => {
    expect(describeHeroFlag("something_new:1")).toBe("something_new:1");
  });
});
