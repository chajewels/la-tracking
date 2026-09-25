import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  autoApplyText, defaultSelection, newAsOfText, runDuration, runKindLabel, splitStockSelection,
  type InventoryItem, type InventoryRun,
} from "@/lib/page365-inventory";
import { CREATE_REFUSAL, DRAFT_REASON, draftable, markNotListed } from "@/lib/page365-drafts";

/**
 * Page365 PR 3c (owner decisions 2026-09-26): QUICK reads every 30 minutes
 * (the catalogue list + the pages of Hub products), a FULL read nightly at
 * 02:00 PHT (03:00 JST) and on "Full fetch", automatic INCREASES as well as
 * decreases and hides, and Create drafts from a FRESH read.
 *
 * The SQL behaviour (92 checks: a quick read opens only Hub listings and never
 * a switched-off one; hide-follow presence from the list; the shrink guard on
 * the list count; a page error -> partial; switch ON applies decreases AND
 * increases with compare-and-set, never N4020, one bell naming both; OFF and
 * partial apply nothing; the nightly full read; drafts refuse a stale row, use
 * the fresh quantity and photos, skip a listing gone from Page365; one reader)
 * runs against a real Postgres in docs/sql/20261002_page365_quick_fetch_local_tests.sql.
 * This file pins what TypeScript owns and the SQL's load-bearing clauses.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const PR3C = src("supabase/migrations/20261002100000_page365_quick_fetch.sql");
const PR3B = src("supabase/migrations/20261001100000_page365_hide_follow.sql");
const PR3 = src("supabase/migrations/20260930100000_page365_inventory_schedule.sql");
const PR2 = src("supabase/migrations/20260928100000_page365_inventory_pr2.sql");
const PR4 = src("supabase/migrations/20260929100000_page365_inventory_drafts.sql");
const PR1 = src("supabase/migrations/20260927100000_page365_inventory_fetch.sql");
const EDGE = src("supabase/functions/page365-inventory-fetch/index.ts");
/** SQL with -- comments removed, so a pin cannot be satisfied by prose. */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
/** TS with comments removed. */
const tsCode = (ts: string) => ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const body = (sql: string, name: string) => {
  const all = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`, "g"))];
  expect(all.length, `${name} is defined`).toBeGreaterThan(0);
  return all[all.length - 1][1];
};
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

const item = (over: Partial<InventoryItem>): InventoryItem => ({
  id: "x", run_id: "run1", kind: "page365", page365_product_id: 1, page365_variant_id: 10, page365_name: "X Ring",
  variant_name: null, code: "X", page365_price_jpy: 10000, page365_full_price_jpy: null, page365_available: 1,
  match_result: "matched", website_product_id: "p-x", variant_id: "v-x", hub_sku: "X", hub_price_jpy: 10000,
  seen_stock: 1, web_holds: 0, invoice_holds: 0, proposed_stock: 1, category: "no_change", price_differs: false,
  photos_total: 0, photos_to_copy: 0, photos_removed: 0, missing_runs: null, status: "review", result_note: null,
  back_in_page365: false, ...over,
});

describe("review screen (PR 3c)", () => {
  const rows = [
    item({ id: "d", code: "QD", category: "decrease", seen_stock: 3, proposed_stock: 1 }),
    item({ id: "i", code: "QI", category: "increase", seen_stock: 0, proposed_stock: 2 }),
    item({ id: "i2", code: "QS", category: "increase", status: "applied", result_note: "auto_applied" }),
    item({ id: "n", code: "QN4020", category: "not_synced", seen_stock: 1, proposed_stock: 5 }),
  ];
  it("increases start ticked like decreases; applied and switched-off rows never do", () => {
    expect([...defaultSelection(rows).stock].sort()).toEqual(["d", "i"]);
  });
  it("an increase is still sent only in the increase list", () => {
    expect(splitStockSelection(rows, defaultSelection(rows).stock)).toEqual({ decreaseIds: ["d"], increaseIds: ["i"] });
  });
  it("labels kind and duration; a run without a kind predates PR 3c and read everything", () => {
    expect(runKindLabel({ kind: "quick" })).toBe("Quick");
    expect(runKindLabel({ kind: "full" })).toBe("Full");
    expect(runKindLabel({})).toBe("Full");
    expect(runDuration({ created_at: "2026-10-02T01:00:00Z", finished_at: "2026-10-02T01:00:12Z" })).toBe("12 s");
    expect(runDuration({ created_at: "2026-10-02T01:00:00Z", finished_at: "2026-10-02T01:03:05Z" })).toBe("3 min 5 s");
    expect(runDuration({ created_at: "2026-10-02T01:00:00Z", finished_at: null })).toBe("—");
  });
  it("says what the automatic updates did, increases counted apart", () => {
    const run = (over: Partial<InventoryRun>) =>
      ({ source: "schedule", status: "ready", auto_apply_state: "applied", auto_applied: 0, ...over }) as InventoryRun;
    expect(autoApplyText(run({ auto_applied: 2, auto_increased: 2 }))).toBe("2 increases applied automatically");
    expect(autoApplyText(run({ auto_applied: 1, auto_increased: 0 }))).toBe("1 decrease applied automatically");
    expect(autoApplyText(run({ auto_applied: 3, auto_increased: 1, hidden_count: 1 })))
      .toBe("2 decreases · 1 increase applied automatically · 1 product hidden on the website");
    expect(autoApplyText(run({ auto_apply_state: "off" }))).toBe("Automatic updates off — nothing applied");
  });
});

describe("New in Page365 (PR 3c)", () => {
  it("is labelled with the full fetch it comes from, in PHT", () => {
    // 2026-10-01 18:10 UTC = 2 October 02:10 in Manila.
    expect(newAsOfText({ created_at: "2026-10-01T18:10:00Z" })).toBe("Quantities as of the full fetch of 2026-10-02, 02:10 PHT");
  });
  it("greys out rows missing from the latest list; nothing to compare when the list IS the full fetch", () => {
    const rows = [item({ id: "a", category: "new", page365_product_id: 11 }), item({ id: "b", category: "new", page365_product_id: 12 })];
    const marked = markNotListed(rows, new Set([11]));
    expect(marked.map(r => r.not_listed)).toEqual([false, true]);
    expect(draftable(marked[0])).toBe(true);
    expect(draftable(marked[1])).toBe(false);
    expect(markNotListed(rows, null).every(r => !r.not_listed)).toBe(true);
  });
  it("a listing gone from Page365 at the fresh read is never draftable", () => {
    expect(draftable(item({ category: "new", result_note: "gone_from_page365" }))).toBe(false);
    expect(DRAFT_REASON.not_fresh).toMatch(/fresh/);
    expect(DRAFT_REASON.gone_from_page365).toMatch(/no longer on Page365/);
    expect(CREATE_REFUSAL.not_full_fetch).toMatch(/Full fetch/);
  });
});

describe("migration 20261002100000 — load-bearing clauses", () => {
  const C = code(PR3C);
  const pinned = (sig: string) =>
    [...C.matchAll(new RegExp(`\\('${sig.replace(/[()[\]]/g, "\\$&")}',\\s*'([0-9a-f]{32})'(?:,\\s*'([0-9a-f]{32})')?`, "g"))];

  it("replaces finish, auto_apply_run and create_drafts from their LIVE bodies (Bug #280) and pins the new ones", () => {
    const cases: [string, string, string][] = [
      ["page365_inventory_finish", "page365_inventory_finish(uuid)", PR2],
      ["page365_inventory_auto_apply_run", "page365_inventory_auto_apply_run(uuid)", PR3B],
      ["page365_inventory_create_drafts", "page365_inventory_create_drafts(uuid,uuid[])", PR4],
    ];
    for (const [name, sig, before] of cases) {
      const rows = pinned(sig);
      expect(rows.length, `${name}: pre-flight + self-check`).toBe(2);
      expect(rows[0][1], `${name} before`).toBe(md5(body(before, name)));
      expect(rows[0][2], `${name} after (re-run)`).toBe(md5(body(PR3C, name)));
      expect(rows[1][1], `${name} self-check`).toBe(md5(body(PR3C, name)));
    }
  });
  it("pins the bodies it relies on and redefines none of them", () => {
    const cases: [string, string, string][] = [
      ["page365_inventory_claim", "page365_inventory_claim(uuid,integer)", PR1],
      ["page365_inventory_store_product", "page365_inventory_store_product(uuid,jsonb,text)", PR1],
      ["page365_inventory_apply", "page365_inventory_apply(uuid,uuid[],uuid[])", PR2],
      ["page365_inventory_lease", "page365_inventory_lease(uuid,text,integer)", PR3],
      ["page365_inventory_retention", "page365_inventory_retention(integer)", PR3],
      ["page365_inventory_follow", "page365_inventory_follow(uuid)", PR3B],
      ["page365_inventory_hide_item", "page365_inventory_hide_item(uuid,uuid,uuid,text)", PR3B],
    ];
    for (const [name, sig, file] of cases) {
      const rows = pinned(sig);
      expect(rows.length, name).toBe(2);
      for (const r of rows) expect(r[1], name).toBe(md5(body(file, name)));
      expect(C).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`));
    }
  });
  it("never writes the switch's value, and proves it and every product's stock/status unchanged", () => {
    expect(C).not.toMatch(/SET\s+value\s*=/);
    expect(C).toContain("page365.quick_switch_before");
    expect(C).toContain("the auto-apply switch changed during this file");
    expect(C).toContain("a product status or stock changed during this file");
  });
  it("existing runs are full; the products status gains 'listed'", () => {
    expect(C).toContain("ADD COLUMN IF NOT EXISTS kind           text NOT NULL DEFAULT 'full'");
    expect(C).toContain("CHECK (kind IN ('quick','full'))");
    expect(C).toContain("CHECK (status IN ('pending','claimed','fetched','error','listed'))");
  });

  it("quick plan: opens only listings that can hold a Hub product, never a switched-off one", () => {
    const f = code(body(PR3C, "page365_inventory_plan_quick"));
    expect(f).toContain("v_run.status <> 'fetching' OR v_run.kind <> 'quick'");
    expect(f).toContain("WHERE wp.status <> 'archived' AND NOT coalesce(wp.page365_sync_disabled, false)");
    expect(f).toContain("hub.code = public.page365_first_word(p.list_name)");               // (a) list code
    expect(f).toContain("i.page365_product_id = p.page365_product_id AND i.run_id <> p_run_id"); // (b) variant code seen before
    expect(f).toContain("wp.page365_product_id = p.page365_product_id");                     // (c) drafted from it
    expect(f).toContain("SET status = 'listed'");
    expect(f).toContain("p.status = 'pending'");
    // The claimer is unchanged and only takes pending / stale-claimed / error rows: never 'listed'.
    expect(code(body(PR1, "page365_inventory_claim"))).not.toContain("'listed'");
  });
  it("finish: a quick read leaves switched-off products out of the Hub-only list; the shrink guard is on the list count", () => {
    const f = code(body(PR3C, "page365_inventory_finish"));
    expect(f).toContain("AND NOT (v_run.kind = 'quick' AND coalesce(wp.page365_sync_disabled, false))");
    expect(f).toContain("v_run.page365_count < v_prev_count * 0.8");
    expect(f).toContain("IF v_errors = 0 THEN");
    // Only this clause and the result changed from PR 2's body.
    const before = code(body(PR2, "page365_inventory_finish")).split("\n").filter(l => l.trim());
    const after = f.split("\n").filter(l => l.trim());
    expect(after.filter(l => !before.includes(l)).map(l => l.trim())).toEqual([
      "AND NOT (v_run.kind = 'quick' AND coalesce(wp.page365_sync_disabled, false))",
      "RETURN jsonb_build_object('ok', true, 'status', v_status, 'reason', v_reason, 'mode', v_mode, 'kind', v_run.kind);",
    ]);
  });
  it("auto-apply: decreases AND increases, same gate, compare-and-set, never a switched-off product", () => {
    const f = code(body(PR3C, "page365_inventory_auto_apply_run"));
    expect(f).toContain("AND i.category IN ('decrease', 'increase') AND i.status = 'review'");
    expect(f).toContain("WHERE id = v_it.variant_id AND stock_qty = v_it.seen_stock AND stock_qty <> v_it.proposed_stock;");
    expect(f).toContain("(v_it.category = 'increase') <> (v_it.proposed_stock > v_it.seen_stock)");
    expect(f).toContain("wp.page365_sync_disabled)             THEN 'sync_disabled'");
    expect(f).toContain("WHEN NOT v_on                                               THEN 'off'");
    expect(f).toContain("WHEN v_run.status <> 'ready'                                THEN 'not_ready'");
    expect(f).toContain("THEN 'window_passed'");
    expect(f).toContain("THEN 'superseded'");
    expect(f).toContain("'direction', v_it.category");
    expect(f).toContain("auto_increased = v_increased");
    expect(f).toContain("'Page365 stock updated automatically'");
    // Still never re-publishes, drafts, prices or photos.
    expect(f).not.toMatch(/website_publish_products|create_drafts|record_photo|price_jpy\s*=/);
  });
  it("create drafts: only a full run, superseded only by a newer full run, and only a row read fresh", () => {
    const f = code(body(PR3C, "page365_inventory_create_drafts"));
    expect(f).toContain("IF v_run.kind IS DISTINCT FROM 'full' THEN");
    expect(f).toContain("WHERE r.status = 'ready' AND r.kind = 'full' AND r.created_at > v_run.created_at) THEN");
    expect(f).toContain("p.fetched_at >= now() - interval '15 minutes'");
    expect(f).toContain("'reason', 'not_fresh'");
    expect(f).toContain("'reason', 'gone_from_page365'");
  });
  it("the fresh read touches only NEW rows of a full ready run, and whitelists what it stores", () => {
    const f = code(body(PR3C, "page365_inventory_refresh_product"));
    expect(f).toContain("v_run.status IS DISTINCT FROM 'ready' OR v_run.kind IS DISTINCT FROM 'full'");
    expect([...f.matchAll(/AND i\.category = 'new' AND i\.status = 'review'/g)].length).toBe(2);
    expect(f).not.toMatch(/website_product_variants|stock_qty|proposed_stock|seen_stock/);
  });
  it("the nightly full read: first scheduled read after the PHT hour (default 2 = 03:00 JST)", () => {
    const f = code(body(PR3C, "page365_inventory_next_kind"));
    expect(f).toContain("r.source = 'schedule' AND r.kind = 'full' AND r.status <> 'failed'");
    expect(f).toContain("now() AT TIME ZONE 'Asia/Manila'");
    expect(f).not.toContain("Asia/Tokyo");
    expect(C).toContain("VALUES ('page365_inventory_full_hour_pht', '2'::jsonb,");
  });
  it("one reader: the refresh lease is refused while a run's lease is held", () => {
    const f = code(body(PR3C, "page365_inventory_reader_lease"));
    expect(f).toContain("WHERE r.status = 'fetching' AND r.lease_until > now()");
  });
  it("browser roles reach none of the new functions", () => {
    for (const fn of ["page365_inventory_plan_quick(uuid)", "page365_inventory_next_kind()",
      "page365_inventory_refresh_product(uuid, jsonb, text)", "page365_inventory_reader_lease(text, integer)",
      "page365_inventory_reader_release(text)"]) {
      expect(C, fn).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
    }
  });
});

describe("edge page365-inventory-fetch (PR 3c)", () => {
  const E = tsCode(EDGE);
  it("staff default to a quick read; Full fetch asks for full", () => {
    expect(E).toContain('const kind: RunKind = body?.kind === "full" ? "full" : "quick";');
  });
  it("a quick run is planned right after the list is queued; the list count is the run's count", () => {
    const start = E.indexOf("async function startRun");
    const seg = E.slice(start, E.indexOf("async function refreshHoldsReader"));
    expect(seg.indexOf("page365_count: items.length")).toBeLessThan(seg.indexOf('rpc("page365_inventory_plan_quick"'));
    expect(seg).toContain('if (kind === "quick")');
    // If the plan cannot be made, read everything (the safe side).
    expect(seg).toContain('.update({ kind: "full" })');
  });
  it("the schedule asks SQL for the kind (nightly full)", () => {
    expect(E).toContain('supabase.rpc("page365_inventory_next_kind")');
    expect(E).toContain('startRun(supabase, "schedule", null, kind)');
  });
  it("'listed' products are neither open nor errors", () => {
    expect(E).toContain('else if (r.status === "listed") counts.listed++;');
  });
  it("one reader: a chunk backs off while a draft refresh holds the reader lease, after taking its own", () => {
    const seg = E.slice(E.indexOf("async function readChunk"), E.indexOf("/** PR 3: one cron tick. */"));
    expect(seg.indexOf('rpc("page365_inventory_lease"')).toBeLessThan(seg.indexOf("refreshHoldsReader(supabase)"));
  });
  it("refresh: staff only, <= 4 requests/s, under the reader lease, a 404 is 'gone'", () => {
    const seg = E.slice(E.indexOf("async function refreshForDrafts"), E.indexOf("Deno.serve"));
    expect(seg).toContain('rpc("page365_inventory_reader_lease"');
    expect(seg).toContain("createRateLimiter(4, 4)");
    expect(seg).toContain('r.why === "HTTP 404" ? "gone" : r.why');
    expect(seg).toContain('rpc("page365_inventory_refresh_product"');
    expect(seg).toContain('rpc("page365_inventory_reader_release"');
    expect(seg).toContain('.eq("category", "new")');
    // The service role may still only run the scheduled tick.
    expect(E).toContain('if (action !== "schedule") return jsonResponse({ error: "The service role may only run the scheduled fetch" }, 400);');
  });
});

// ── The schedule card: kind and duration in the run history ─────────────────
vi.mock("@/lib/page365-inventory-api", () => {
  const runs = [
    { id: "q", source: "schedule", kind: "quick", status: "ready", page365_count: 572, products_total: 64, error: null,
      created_at: "2026-10-02T01:30:00Z", finished_at: "2026-10-02T01:30:21Z", auto_apply_state: "applied",
      auto_applied: 3, auto_increased: 1, hidden_count: 0 },
    { id: "f", source: "schedule", kind: "full", status: "ready", page365_count: 572, products_total: 572, error: null,
      created_at: "2026-10-01T18:02:00Z", finished_at: "2026-10-01T18:09:30Z", auto_apply_state: "applied",
      auto_applied: 0, auto_increased: 0, hidden_count: 0 },
  ];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "order", "eq"]) chain[m] = () => chain;
  chain.limit = async () => ({ data: runs, error: null });
  return {
    runsTable: () => chain,
    getAutoApply: async () => ({ found: true, enabled: true, updated_at: null, updated_by_user_id: null, updated_by_name: null, can_change: true }),
    setAutoApply: vi.fn(),
  };
});

describe("Page365InventoryScheduleCard (PR 3c)", () => {
  it("names the switch for all three updates and shows Quick/Full with how long each read took", async () => {
    const { Page365InventoryScheduleCard } = await import("@/components/website/Page365InventoryScheduleCard");
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Page365InventoryScheduleCard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Automatic updates every 30 minutes \(decreases, increases, hiding\)/)).toBeTruthy();
    const rows = await screen.findAllByTestId("p365-run-history-row");
    expect(within(rows[0]).getByTestId("p365-run-kind").textContent).toBe("Quick");
    expect(within(rows[0]).getByTestId("p365-run-duration").textContent).toBe("21 s");
    expect(within(rows[0]).getByText("2 decreases · 1 increase applied automatically")).toBeTruthy();
    expect(within(rows[1]).getByTestId("p365-run-kind").textContent).toBe("Full");
    expect(within(rows[1]).getByTestId("p365-run-duration").textContent).toBe("7 min 30 s");
    expect(screen.getByText(/02:00 PHT \(03:00 JST\)/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Automatic updates every 30 minutes" })).toBeTruthy();
  });
});
