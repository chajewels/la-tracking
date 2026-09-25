import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { scheduleDecision } from "../../supabase/functions/_shared/page365-inventory.ts";
import {
  SKIP_REASON, autoApplyRefusal, autoApplyText, runSourceLabel, type InventoryRun,
} from "@/lib/page365-inventory";

/**
 * Page365 inventory PR 3 (2026-09-30): an automatic fetch every 30 minutes
 * that applies DECREASES ONLY, behind an owner switch that defaults OFF.
 * The SQL behaviour (107 checks: switch off/on, decreases only, "Don't sync"
 * skipped, partial applies nothing, compare-and-set, lease, retention, bells)
 * runs against a real Postgres in
 * docs/sql/20260930_page365_inventory_schedule_local_tests.sql; this file pins
 * what TypeScript owns and the SQL's load-bearing clauses.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const PR3 = src("supabase/migrations/20260930100000_page365_inventory_schedule.sql");
const PR1 = src("supabase/migrations/20260927100000_page365_inventory_fetch.sql");
const PR2 = src("supabase/migrations/20260928100000_page365_inventory_pr2.sql");
const EDGE = src("supabase/functions/page365-inventory-fetch/index.ts");
/** SQL with -- comments removed, so a pin cannot be satisfied by prose. */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
const body = (sql: string, name: string) => {
  const all = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`, "g"))];
  expect(all.length, `${name} is defined`).toBeGreaterThan(0);
  return all[all.length - 1][1];
};
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

describe("scheduleDecision — one tick every 5 minutes", () => {
  const now = Date.parse("2026-09-30T03:00:00Z");
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const d = (open: { source: string; updated_at: string } | null, last: string | null) =>
    scheduleDecision(open, last, now, 10 * 60_000, 27 * 60_000);

  it("never overlaps a manual fetch that is reading", () => {
    expect(d({ source: "manual", updated_at: ago(1) }, ago(60))).toEqual({ act: "skip", reason: "manual_fetch_in_progress" });
  });
  it("resumes its own scheduled run", () => {
    expect(d({ source: "schedule", updated_at: ago(2) }, ago(4))).toEqual({ act: "resume" });
  });
  it("starts a new run only when the last scheduled one began >= 27 minutes ago", () => {
    expect(d(null, ago(20))).toEqual({ act: "wait", reason: "not_due" });
    expect(d(null, ago(27))).toEqual({ act: "start" });
    expect(d(null, null)).toEqual({ act: "start" });
  });
  it("an abandoned reader (manual or scheduled) no longer blocks; start closes it", () => {
    expect(d({ source: "manual", updated_at: ago(11) }, ago(40))).toEqual({ act: "start" });
    expect(d({ source: "schedule", updated_at: ago(11) }, ago(12))).toEqual({ act: "wait", reason: "not_due" });
  });
});

describe("review-screen words (PR 3)", () => {
  const run = (over: Partial<InventoryRun>) =>
    ({ source: "schedule", status: "ready", auto_apply_state: null, auto_applied: 0, ...over }) as InventoryRun;
  it("labels the source", () => {
    expect(runSourceLabel(run({ source: "schedule" }))).toBe("Scheduled");
    expect(runSourceLabel(run({ source: "manual" }))).toBe("Manual");
  });
  it("says what the automatic decreases did", () => {
    expect(autoApplyText(run({ auto_apply_state: "applied", auto_applied: 3 }))).toBe("3 decreases applied automatically");
    expect(autoApplyText(run({ auto_apply_state: "applied", auto_applied: 0 }))).toBe("No stock changes to apply");
    // PR 3c: increases are applied too, and counted apart.
    expect(autoApplyText(run({ auto_apply_state: "applied", auto_applied: 3, auto_increased: 1 })))
      .toBe("2 decreases · 1 increase applied automatically");
    expect(autoApplyText(run({ auto_apply_state: "off" }))).toMatch(/off — nothing applied/);
    expect(autoApplyText(run({ status: "partial", auto_apply_state: "not_ready" }))).toMatch(/Incomplete read — nothing applied/);
    expect(autoApplyText(run({ source: "manual" }))).toMatch(/Manual fetch — nothing applied automatically/);
  });
  it("explains the new row notes and switch refusals", () => {
    expect(SKIP_REASON.auto_applied).toMatch(/automatically/);
    expect(SKIP_REASON.not_a_decrease).toBeTruthy();
    expect(autoApplyRefusal("permission_denied")).toMatch(/Website catalog permission/);
    expect(autoApplyRefusal("stale")).toMatch(/changed this a moment ago/);
  });
});

describe("migration 20260930100000 — load-bearing clauses", () => {
  const C = code(PR3);

  it("pins the four live bodies it relies on (Bug #280) — and redefines none of them", () => {
    const pins: [string, string, string][] = [
      ["page365_inventory_claim", "page365_inventory_claim(uuid,integer)", PR1],
      ["page365_inventory_store_product", "page365_inventory_store_product(uuid,jsonb,text)", PR1],
      ["page365_inventory_finish", "page365_inventory_finish(uuid)", PR2],
      ["page365_inventory_apply", "page365_inventory_apply(uuid,uuid[],uuid[])", PR2],
    ];
    for (const [name, sig, file] of pins) {
      const want = md5(body(file, name));
      // Pre-flight and self-check both pin the same md5.
      const rows = [...C.matchAll(new RegExp(`\\('${sig.replace(/[()[\]]/g, "\\$&")}',\\s*'([0-9a-f]{32})'\\)`, "g"))];
      expect(rows.length, `${name} pinned twice`).toBe(2);
      for (const r of rows) expect(r[1], name).toBe(want);
      expect(C).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`));
    }
  });

  it("never turns the switch on: seeds false only if absent, and proves the value did not move", () => {
    expect(C).toMatch(/VALUES \('page365_inventory_auto_apply', 'false'::jsonb,/);
    expect(C).toMatch(/ON CONFLICT \(key\) DO NOTHING;/);
    // The only write of the value is inside set_page365_inventory_auto_apply.
    const writes = [...C.matchAll(/SET value = /g)];
    expect(writes.length).toBe(1);
    expect(body(PR3, "set_page365_inventory_auto_apply")).toContain("SET value = to_jsonb(p_enabled)");
    expect(C).toContain("the auto-apply switch changed during this file");
  });

  it("the switch: manage_website_catalog, audited, guarded against every other write", () => {
    const set = code(body(PR3, "set_page365_inventory_auto_apply"));
    expect(set).toContain("public.has_permission(v_uid, 'manage_website_catalog')");
    expect(set).toContain("'set_page365_inventory_auto_apply'");
    expect(set).toContain("INSERT INTO public.audit_logs");
    expect(C).toMatch(/CREATE TRIGGER trg_guard_page365_inventory_auto_apply\s+BEFORE UPDATE OR DELETE ON public\.system_settings/);
  });

  it("auto-apply: decreases only, fail-closed switch, ready + window + not superseded, compare-and-set, never a switched-off product", () => {
    const f = code(body(PR3, "page365_inventory_auto_apply_run"));
    expect(f).toContain("WHERE s.key = 'page365_inventory_auto_apply'), 'false') = 'true'");
    expect(f).toContain("AND i.category = 'decrease' AND i.status = 'review'");
    expect(f).not.toMatch(/category\s*(=|IN)\s*\(?'increase'/);
    expect(f).toContain("WHEN v_run.status <> 'ready'                                THEN 'not_ready'");
    expect(f).toContain("now() > v_run.created_at + interval '30 minutes'");
    expect(f).toContain("r.status = 'ready' AND r.created_at > v_run.created_at) THEN 'superseded'");
    expect(f).toContain("IF v_run.source <> 'schedule' THEN");
    expect(f).toContain("WHERE id = v_it.variant_id AND stock_qty = v_it.seen_stock AND stock_qty > v_it.proposed_stock");
    expect(f).toContain("wp.page365_sync_disabled)             THEN 'sync_disabled'");
    expect(f).toContain("'page365_inventory_auto_applied'");
    expect(f).toContain("'page365_inventory_auto_apply'");
    // One bell per run: the close happens once (auto_apply_at), one INSERT per branch.
    expect(f).toContain("IF v_run.auto_apply_at IS NOT NULL THEN");
    expect([...f.matchAll(/INSERT INTO public\.staff_notifications/g)].length).toBe(2);
  });

  it("retention never deletes audit_logs and keeps what was applied", () => {
    const f = code(body(PR3, "page365_inventory_retention"));
    expect(f).not.toMatch(/audit_logs/);
    expect(f).toContain("i.status = 'applied' OR i.applied_at IS NOT NULL");
    expect(f).toContain("r.status <> 'fetching'");
    expect(f).toContain("r.id IS DISTINCT FROM v_latest");
    expect(f).toContain("greatest(coalesce(p_keep_days, 14), 7)");
  });

  it("service-role-only functions; the cron job uses the Vault key and the schedule action", () => {
    for (const fn of ["page365_inventory_lease(uuid, text, integer)", "page365_inventory_release(uuid, text)",
      "page365_inventory_auto_apply_run(uuid)", "page365_inventory_retention(integer)"]) {
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`);
    }
    expect(C).toMatch(/cron\.schedule\('page365-inventory-schedule', '2-59\/5 \* \* \* \*'/);
    expect(C).toContain("(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')");
    expect(C).toContain(`body := '{"action":"schedule"}'::jsonb`);
    expect(C).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no embedded JWT
  });
});

describe("edge page365-inventory-fetch — the scheduled path", () => {
  const E = EDGE.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  it("only the service role runs the tick, and it may run nothing else", () => {
    expect(E).toContain("requireAuth(req, { allowServiceRole: true })");
    expect(E).toContain('if (action !== "schedule") return jsonResponse({ error: "The service role may only run the scheduled fetch" }, 400);');
    expect(E).toContain('if (action === "schedule") return jsonResponse({ error: "The scheduled fetch runs from pg_cron only" }, 403);');
  });
  it("every chunk is read under the lease, manual and scheduled alike", () => {
    expect(E).toMatch(/async function readChunk[\s\S]*?rpc\("page365_inventory_lease"/);
    expect(E).toMatch(/if \(!leased\) return \{ busy: true as const/);
    expect(E).toContain('await supabase.rpc("page365_inventory_release", { p_run_id: runId, p_holder: holder });');
    expect(E).toContain("readChunk(supabase, runId, `manual:${crypto.randomUUID()}`");
  });
  it("skips a manual fetch, and auto-applies only through the SQL closer", () => {
    expect(E).toContain('if (decision.act === "skip") return { skipped: decision.reason, run_id: open?.id };');
    expect([...E.matchAll(/page365_inventory_auto_apply_run/g)].length).toBe(1);
    expect(E).not.toContain("page365_inventory_apply\"");
    expect(E).toMatch(/if \(now\.run\?\.source === "schedule" && now\.run\.status !== "fetching"\)/);
  });
});

// ── The switch card ─────────────────────────────────────────────────────────
const setAutoApply = vi.fn(async (...args: [boolean, boolean | null]) => ({ ok: true, changed: true, enabled: args[0] }));
vi.mock("@/lib/page365-inventory-api", () => {
  const runs = [
    { id: "r2", source: "schedule", status: "ready", error: null, page365_count: 572, products_total: 572,
      created_at: "2026-09-30T03:02:00Z", finished_at: "2026-09-30T03:06:00Z", auto_apply_state: "off", auto_applied: 0 },
    { id: "r1", source: "manual", status: "ready", error: null, page365_count: 572, products_total: 572,
      created_at: "2026-09-30T02:40:00Z", finished_at: "2026-09-30T02:44:00Z", auto_apply_state: null, auto_applied: 0 },
  ];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.order = () => chain;
  chain.limit = async () => ({ data: runs, error: null });
  return {
    runsTable: () => chain,
    getAutoApply: async () => ({ found: true, enabled: false, updated_at: null, updated_by_user_id: null, updated_by_name: null, can_change: true }),
    setAutoApply: (enabled: boolean, expected: boolean | null) => setAutoApply(enabled, expected),
  };
});

describe("Page365InventoryScheduleCard", () => {
  it("shows OFF, the run history with its source, and turns on only after confirming", async () => {
    const { Page365InventoryScheduleCard } = await import("@/components/website/Page365InventoryScheduleCard");
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Page365InventoryScheduleCard />
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId("p365-auto-apply-state")).textContent).toBe("Off");
    const rows = await screen.findAllByTestId("p365-run-history-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Scheduled")).toBeTruthy();
    expect(within(rows[0]).getByText(/Automatic updates off — nothing applied/)).toBeTruthy();
    expect(within(rows[1]).getByText("Manual")).toBeTruthy();
    expect(screen.getByTestId("p365-last-scheduled").textContent).toMatch(/Last scheduled fetch/);

    fireEvent.click(screen.getByRole("switch", { name: "Automatic updates every 30 minutes" }));
    expect(setAutoApply).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await vi.waitFor(() => expect(setAutoApply).toHaveBeenCalledWith(true, false));
  });
});
