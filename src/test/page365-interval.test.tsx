import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  SCHEDULE_INTERVALS, normalizeIntervalMinutes, scheduleDecision, scheduleEveryMs, type ScheduleInterval,
} from "../../supabase/functions/_shared/page365-inventory.ts";
import { INTERVAL_CHOICES, intervalRefusal, nextCheckText } from "@/lib/page365-inventory";

/**
 * Page365 inventory PR 3d (2026-10-03): "Check Page365 every" 5 / 10 / 20 / 30
 * minutes, and a time-safe hide (2 missing complete reads AND >= 30 minutes
 * since last seen). The SQL behaviour (setting, CHECK, guard, permission,
 * audit, next check, the hide rule) runs against a real Postgres in
 * docs/sql/20261003_page365_interval_local_tests.sql; this file pins the start
 * cadence (TypeScript owns it), the words, the card, and the SQL's
 * load-bearing clauses.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const PR3D = src("supabase/migrations/20261003100000_page365_interval.sql");
const PR3B = src("supabase/migrations/20261001100000_page365_hide_follow.sql");
const EDGE = src("supabase/functions/page365-inventory-fetch/index.ts");
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
const body = (sql: string, name: string) => {
  const all = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`, "g"))];
  expect(all.length, `${name} is defined`).toBeGreaterThan(0);
  return all[all.length - 1][1];
};
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const MIN = 60_000;
const ABANDONED = 10 * MIN;

/**
 * Simulate the cron (minute 2, 7, … 57 — "2-59/5") over `hours`, with the tick
 * landing 0-25 s late and a read beginning 3 s after its tick. A started read
 * stays 'fetching' for `readMs`, then ends. Returns every start time.
 */
function simulate(minutes: ScheduleInterval, hours: number, readMs = 40_000, manual?: { from: number; to: number }) {
  const t0 = Date.UTC(2026, 9, 3, 0, 2, 0);
  const starts: number[] = [];
  const decisions: string[] = [];
  let open: { source: string; updated_at: string; endsAt: number } | null = null;
  for (let k = 0; k < hours * 12; k++) {
    const now = t0 + k * 5 * MIN + ((k * 7919) % 26) * 1000; // deterministic 0-25 s jitter
    if (open && now >= open.endsAt) open = null;
    const manualOpen = manual && now >= manual.from && now < manual.to
      ? { source: "manual", updated_at: new Date(now - 1000).toISOString() } : null;
    const reading = manualOpen ?? (open ? { source: open.source, updated_at: new Date(now - 1000).toISOString() } : null);
    const last = starts.length ? new Date(starts[starts.length - 1]).toISOString() : null;
    const d = scheduleDecision(reading, last, now, ABANDONED, scheduleEveryMs(minutes));
    decisions.push(d.act);
    if (d.act === "start") {
      const at = now + 3000;
      starts.push(at);
      open = { source: "schedule", updated_at: new Date(at).toISOString(), endsAt: at + readMs };
    }
  }
  return { starts, decisions };
}
const gapsMin = (starts: number[]) => starts.slice(1).map((s, i) => (s - starts[i]) / MIN);

describe("the interval (PR 3d)", () => {
  it("offers exactly 5, 10, 20 and 30 — the Hub and the edge agree", () => {
    expect([...SCHEDULE_INTERVALS]).toEqual([5, 10, 20, 30]);
    expect([...INTERVAL_CHOICES]).toEqual([5, 10, 20, 30]);
  });
  it("anything else (before the migration, a bad value) reads as 30", () => {
    for (const v of [5, 10, 20, 30]) expect(normalizeIntervalMinutes(v)).toBe(v);
    expect(normalizeIntervalMinutes("5")).toBe(5);
    for (const v of [null, undefined, 0, 15, 60, -5, "", "abc", 7.5, {}]) expect(normalizeIntervalMinutes(v)).toBe(30);
  });
  it("due = interval − 2.5 min: one tick before never qualifies, the tick at the interval always does", () => {
    for (const m of SCHEDULE_INTERVALS) {
      expect(scheduleEveryMs(m)).toBe(m * MIN - 150_000);
      // Tick one interval after a start that began 3 s after its tick, landing 0-25 s late.
      expect(m * MIN - 3000 + 0).toBeGreaterThanOrEqual(scheduleEveryMs(m));
      // The tick before (interval − 5 min later), even 25 s late, is not due.
      expect((m - 5) * MIN - 3000 + 25_000).toBeLessThan(scheduleEveryMs(m));
    }
  });
});

describe("scheduleDecision at each interval — on time, never early, never overlapping", () => {
  for (const m of SCHEDULE_INTERVALS) {
    it(`${m} minutes: every scheduled start is ${m} minutes after the last (6 hours of ticks)`, () => {
      const { starts } = simulate(m, 6);
      expect(starts.length).toBe(Math.floor((6 * 60) / m));
      for (const g of gapsMin(starts)) {
        expect(g).toBeGreaterThan(m - 0.5);   // never early
        expect(g).toBeLessThan(m + 0.5);      // on time (cron jitter only)
      }
    });
  }
  it("a read still running when the next is due is resumed, never joined by a second", () => {
    // Each read takes 7 minutes at a 5-minute interval: the due tick finds it reading.
    const { starts, decisions } = simulate(5, 3, 7 * MIN);
    expect(decisions).toContain("resume");
    for (const g of gapsMin(starts)) expect(g).toBeGreaterThanOrEqual(10 - 0.5); // skipped to the next tick
    // Never two starts while one is open.
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThan(7 * MIN);
  });
  it("a staff fetch in progress is skipped, then the schedule picks up on the next due tick", () => {
    const t0 = Date.UTC(2026, 9, 3, 0, 2, 0);
    const { starts, decisions } = simulate(5, 2, 40_000, { from: t0 + 20 * MIN, to: t0 + 36 * MIN });
    expect(decisions).toContain("skip");
    expect(starts.some(s => s >= t0 + 20 * MIN && s < t0 + 36 * MIN)).toBe(false);
    expect(starts.some(s => s >= t0 + 36 * MIN && s < t0 + 42 * MIN)).toBe(true);
  });
  it("changing the interval takes effect on the next tick (5 -> 30 waits; 30 -> 5 starts at once)", () => {
    const last = Date.UTC(2026, 9, 3, 1, 2, 3);
    const at = (minAfter: number) => last + minAfter * MIN;
    const lastIso = new Date(last).toISOString();
    expect(scheduleDecision(null, lastIso, at(5), ABANDONED, scheduleEveryMs(5)).act).toBe("start");
    expect(scheduleDecision(null, lastIso, at(5), ABANDONED, scheduleEveryMs(30)).act).toBe("wait");
    expect(scheduleDecision(null, lastIso, at(10), ABANDONED, scheduleEveryMs(30)).act).toBe("wait");
    expect(scheduleDecision(null, lastIso, at(30), ABANDONED, scheduleEveryMs(30)).act).toBe("start");
  });
});

describe("edge page365-inventory-fetch reads the interval (PR 3d)", () => {
  const E = EDGE.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
  it("asks SQL for the interval and feeds it to scheduleDecision; no hard-coded cadence left", () => {
    expect(E).toContain('await supabase.rpc("page365_inventory_interval_minutes")');
    expect(E).toContain("normalizeIntervalMinutes(minutesErr ? null : minutesRaw)");
    expect(E).toMatch(/scheduleDecision\(open \?\? null, last\?\.created_at \?\? null, Date\.now\(\), ABANDONED_AFTER_MS,\s*scheduleEveryMs\(intervalMinutes\)\)/);
    expect(E).not.toContain("SCHEDULE_EVERY_MS");
    expect(E).not.toMatch(/27 \* 60_000/);
  });
  it("the nightly full read and the manual-fetch skip are unchanged", () => {
    expect(E).toContain('await supabase.rpc("page365_inventory_next_kind")');
    expect(E).toContain('if (decision.act === "skip") return { skipped: decision.reason, run_id: open?.id };');
    expect(E).toContain("createRateLimiter(4, 4)");
  });
});

describe("migration 20261003100000 — load-bearing clauses", () => {
  const C = code(PR3D);
  it("only 5/10/20/30, as JSON numbers, seeded 30 and never overwritten", () => {
    expect(C).toContain("CHECK (key <> 'page365_inventory_interval_minutes' OR value IN ('5'::jsonb, '10'::jsonb, '20'::jsonb, '30'::jsonb))");
    expect(C).toMatch(/VALUES \('page365_inventory_interval_minutes', '30'::jsonb,[\s\S]*?ON CONFLICT \(key\) DO NOTHING;/);
  });
  it("the setter: signed-in, manage_website_catalog, allowed values, audited from/to/who/when", () => {
    const b = code(body(PR3D, "set_page365_inventory_interval"));
    expect(b).toContain("IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;");
    expect(b).toContain("IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN");
    expect(b).toContain("IF p_minutes IS NULL OR p_minutes NOT IN (5, 10, 20, 30) THEN");
    expect(b).toMatch(/INSERT INTO public\.audit_logs \(entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at\)\s*VALUES \('system_setting', v_row\.id, 'set_page365_inventory_interval'/);
    expect(b).toContain("'minutes', v_old");
    expect(b).toContain("'minutes', p_minutes");
    expect(C).toContain("GRANT EXECUTE ON FUNCTION public.set_page365_inventory_interval(integer, integer) TO authenticated;");
    expect(C).toContain("REVOKE ALL ON FUNCTION public.set_page365_inventory_interval(integer, integer) FROM PUBLIC, anon;");
  });
  it("a guard trigger refuses every other write of the value", () => {
    expect(C).toContain("coalesce(current_setting('app.allow_page365_interval_change', true), '') <> 'on'");
    expect(C).toMatch(/CREATE TRIGGER trg_guard_page365_inventory_interval\s+BEFORE UPDATE OR DELETE ON public\.system_settings/);
  });
  it("the service reader is not a browser function", () => {
    expect(C).toContain("REVOKE ALL ON FUNCTION public.page365_inventory_interval_minutes() FROM PUBLIC, anon, authenticated;");
    expect(C).toContain("GRANT EXECUTE ON FUNCTION public.page365_inventory_interval_minutes() TO service_role;");
  });
  it("hide: 2 missing complete reads AND last seen >= 30 minutes before the read — one clause added, nothing else", () => {
    const before = body(PR3B, "page365_inventory_follow");
    const after = body(PR3D, "page365_inventory_follow");
    expect(md5(before)).toBe("9c99a035f3812fb39522d087618e461d");
    expect(md5(after)).toBe("6e26568441fc308c42426de238fb165f");
    const c = code(after);
    expect(c).toContain("AND coalesce(i.missing_runs, 0) >= 2");
    expect(c).toContain("AND pr.last_seen_at <= v_run.created_at - interval '30 minutes'");
    // Strip the added clause and the comment lines: the rest is the live body.
    const strip = (s: string) => code(s).split("\n").filter(l => l.trim() !== "" && !/last_seen_at <= v_run\.created_at - interval '30 minutes'/.test(l)).join("\n");
    expect(strip(after)).toBe(strip(before));
  });
  it("guards: the replaced body and the bodies relied on are pinned, before and after", () => {
    for (const h of ["9c99a035f3812fb39522d087618e461d", "6e26568441fc308c42426de238fb165f",
                     "d9d251fb68aac0acf9a5360b22fddc07", "6bf16430aedfd4068b45024b8d860e95",
                     "6d79e693a71a97f2afc12f429dc61e41", "3a0a932b88cdd1534a9c0285f8ea392b"]) {
      expect(C).toContain(h);
    }
    expect(C).toContain("RAISE EXCEPTION 'STOP — page365_interval: live is not what this file was written against. Nothing was modified.%'");
    // The auto-apply rules are NOT touched: no new body for them, the nightly kind unchanged.
    expect(C).not.toMatch(/CREATE OR REPLACE FUNCTION public\.page365_inventory_auto_apply_run/);
    expect(C).not.toMatch(/CREATE OR REPLACE FUNCTION public\.page365_inventory_next_kind/);
    expect(C).not.toMatch(/cron\.schedule/);
  });
  it("proves no other setting moved", () => {
    expect(C).toContain("RAISE EXCEPTION 'page365_interval self-check: another system_settings row changed';");
  });
});

describe("card words (PR 3d)", () => {
  it("next check is shown in PHT, hours:minutes", () => {
    // 05:47 UTC = 13:47 PHT
    expect(nextCheckText("2026-10-03T05:47:00Z", null)).toBe("Next check around 13:47 (PHT).");
    expect(nextCheckText("2026-10-03T05:47:00Z", "manual")).toBe("Next check around 13:47 (PHT), once the staff fetch in progress has finished.");
    expect(nextCheckText("2026-10-03T05:47:00Z", "schedule")).toBe("Checking Page365 now…");
    expect(nextCheckText(null, null)).toBe("");
  });
  it("refusals are in words", () => {
    expect(intervalRefusal("permission_denied")).toMatch(/Website catalog permission/);
    expect(intervalRefusal("invalid_interval")).toBe("Choose 5, 10, 20 or 30 minutes.");
    expect(intervalRefusal("stale")).toMatch(/Someone else changed this/);
  });
});

// ── The card ────────────────────────────────────────────────────────────────
const setScheduleInterval = vi.fn(async (minutes: number, expected: number | null) =>
  ({ ok: true, changed: true, minutes, old_minutes: expected }));
let intervalAnswer: () => Promise<unknown> = async () => ({
  found: true, minutes: 5, allowed: [5, 10, 20, 30], updated_at: "2026-10-03T05:30:00Z",
  updated_by_user_id: "u1", updated_by_name: "Cynthia", last_scheduled_at: "2026-10-03T05:42:03Z",
  reading: null, next_check_at: "2026-10-03T05:47:00Z", can_change: true,
});
vi.mock("@/lib/page365-inventory-api", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.order = () => chain;
  chain.limit = async () => ({ data: [], error: null });
  return {
    runsTable: () => chain,
    getAutoApply: async () => ({ found: true, enabled: true, updated_at: null, updated_by_user_id: null, updated_by_name: null, can_change: true }),
    setAutoApply: vi.fn(),
    getScheduleInterval: () => intervalAnswer(),
    setScheduleInterval: (m: number, e: number | null) => setScheduleInterval(m, e),
  };
});

beforeAll(() => {
  // Radix Select uses pointer capture and scrollIntoView, which jsdom lacks.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

async function renderCard() {
  const { Page365InventoryScheduleCard } = await import("@/components/website/Page365InventoryScheduleCard");
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Page365InventoryScheduleCard />
    </QueryClientProvider>,
  );
}

describe("Page365InventoryScheduleCard — Check Page365 every (PR 3d)", () => {
  it("titles itself with the chosen interval, shows the next check, and saves a new choice with the old one as expected", async () => {
    await renderCard();
    expect(await screen.findByText(/Automatic updates every 5 minutes/)).toBeTruthy();
    expect(screen.queryByText(/every 30 minutes/)).toBeNull();
    expect((await screen.findByTestId("p365-next-check")).textContent).toBe("Next check around 13:47 (PHT).");
    expect(screen.getByTestId("p365-interval").textContent).toMatch(/Use 5 minutes during live sessions/);
    expect(screen.getByTestId("p365-interval").textContent).toMatch(/Last changed .* by Cynthia/);

    const trigger = screen.getByRole("combobox", { name: "Check Page365 every" });
    expect(trigger.textContent).toBe("5 minutes");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "30 minutes" }));
    await vi.waitFor(() => expect(setScheduleInterval).toHaveBeenCalledWith(30, 5));
  });

  it("without the permission the selector is not offered (the server refuses anyway)", async () => {
    intervalAnswer = async () => { throw Object.assign(new Error("permission_denied"), { code: "permission_denied" }); };
    await renderCard();
    await screen.findAllByText(/Automatic updates every 30 minutes/);
    expect(screen.queryByTestId("p365-interval")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Check Page365 every" })).toBeNull();
  });
});
