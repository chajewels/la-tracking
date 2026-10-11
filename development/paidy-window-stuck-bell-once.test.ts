/**
 * QA residual of 2026-10-11 (owner go 11:43 JST): the "A Paidy approval is
 * still waiting to be checked" bell (paidy_window_stuck) is written by ONE
 * atomic writer (ring_paidy_window_stuck_bell — unique index + stamp in the
 * same transaction) and the hourly sweep walks EVERY waiting window
 * (keyset-paged). Pure sweep logic, writer contract, and wiring on
 * comment-stripped code. Real-Postgres races: development/sql/paidy-window-stuck-bell-once.sh.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAIDY_WINDOW_STUCK_HOURS, PAIDY_WINDOW_STUCK_MAX_PAGES, PAIDY_WINDOW_STUCK_PAGE, paidyWindowStuckBell,
  paidyWindowStuckCutoff, ringPaidyWindowStuckBell, type StuckPaidyWindow, sweepStuckPaidyWindows,
  type WindowRingOutcome, type WindowSweepDeps,
} from "../supabase/functions/_shared/paidy-window-stuck-bell.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");

const windows = (n: number, start = 0): StuckPaidyWindow[] => Array.from({ length: n }, (_, i) => ({
  attempt_id: `00000000-0000-0000-0000-${String(start + i).padStart(12, "0")}`,
  cash_order_id: `10000000-0000-0000-0000-${String(start + i).padStart(12, "0")}`,
  paidy_payment_id: `pay_${start + i}`,
  expires_at: new Date(Date.UTC(2026, 9, 11, 0, 0, start + i)).toISOString(),
  reference: `CJ-W-${start + i}`,
}));

function source(all: StuckPaidyWindow[], outcome: (w: StuckPaidyWindow) => WindowRingOutcome) {
  const stamped = new Set<string>();
  const calls: string[] = [];
  const deps: WindowSweepDeps = {
    missing: (after, limit) => Promise.resolve(all
      .filter((w) => !stamped.has(w.attempt_id))
      .filter((w) => !after || w.expires_at > after.at || (w.expires_at === after.at && w.attempt_id > after.id))
      .slice(0, limit)),
    ring: (id) => {
      calls.push(id);
      const r = outcome(all.find((w) => w.attempt_id === id)!);
      if (r === "rung" || r === "exists") stamped.add(id);
      return Promise.resolve(r);
    },
  };
  return { deps, calls };
}

Deno.test("bell text is unchanged from the second-hold fix", () => {
  const b = paidyWindowStuckBell("CJ-W-000123", "pay_abc");
  assertEquals(b.title, "A Paidy approval is still waiting to be checked");
  assertEquals(b.body, 'CJ-W-000123 · pay_abc · the customer cannot pay this order until Paidy is checked. Check the Paidy dashboard, then use "End Paidy window" on the order if Paidy holds nothing.');
});

Deno.test("cutoff: 3 hours before now", () => {
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);
  assertEquals(PAIDY_WINDOW_STUCK_HOURS, 3);
  assertEquals(paidyWindowStuckCutoff(now), new Date(now - 3 * 3_600_000).toISOString());
});

Deno.test("sweep: more than two pages — every window is rung once", async () => {
  const all = windows(PAIDY_WINDOW_STUCK_PAGE * 2 + 13);
  const s = source(all, () => "rung");
  const r = await sweepStuckPaidyWindows(s.deps);
  assertEquals(r.rung, all.length);
  assertEquals(new Set(s.calls).size, all.length);
  assertEquals(s.calls.length, all.length);
});

Deno.test("sweep: windows whose ring keeps failing never hide later ones", async () => {
  const all = windows(PAIDY_WINDOW_STUCK_PAGE + 7);
  const failing = new Set(all.slice(0, PAIDY_WINDOW_STUCK_PAGE).map((w) => w.attempt_id));
  const s = source(all, (w) => failing.has(w.attempt_id) ? "failed" : "rung");
  const r = await sweepStuckPaidyWindows(s.deps);
  assertEquals([r.failed, r.rung], [PAIDY_WINDOW_STUCK_PAGE, 7]);
  assertEquals(s.calls.length, all.length);
});

Deno.test("sweep: outcomes counted separately", async () => {
  const all = windows(3);
  const s = source(all, (w) => w.attempt_id.endsWith("1") ? "exists" : w.attempt_id.endsWith("2") ? "closed" : "rung");
  const r = await sweepStuckPaidyWindows(s.deps);
  assertEquals([r.rung, r.already, r.closed, r.failed], [1, 1, 1, 0]);
});

Deno.test("sweep: bounded per run", async () => {
  let pages = 0;
  const r = await sweepStuckPaidyWindows({
    missing: (_a, limit) => { pages++; return Promise.resolve(windows(limit, pages * limit)); },
    ring: () => Promise.resolve("failed"),
  });
  assertEquals([r.pages, pages], [PAIDY_WINDOW_STUCK_MAX_PAGES, PAIDY_WINDOW_STUCK_MAX_PAGES]);
});

Deno.test("writer: never throws; an error or an unknown answer is 'failed'", async () => {
  const bell = { title: "t", body: "b" };
  assertEquals(await ringPaidyWindowStuckBell({ rpc: () => Promise.resolve({ data: null, error: { message: "x" } }) }, "a", bell), "failed");
  assertEquals(await ringPaidyWindowStuckBell({ rpc: () => { throw new Error("net"); } }, "a", bell), "failed");
  assertEquals(await ringPaidyWindowStuckBell({ rpc: () => Promise.resolve({ data: true, error: null }) }, "a", bell), "failed");
  for (const ok of ["rung", "exists", "closed"] as const) {
    assertEquals(await ringPaidyWindowStuckBell({ rpc: () => Promise.resolve({ data: ok, error: null }) }, "a", bell), ok);
  }
  const seen: Record<string, unknown>[] = [];
  await ringPaidyWindowStuckBell({ rpc: (_fn: string, args: Record<string, unknown>) => { seen.push(args); return Promise.resolve({ data: "rung", error: null }); } }, "a1", bell);
  assertEquals(seen[0], { p_attempt_id: "a1", p_title: "t", p_body: "b", p_metadata: {} });
});

Deno.test("wiring: no direct window-stuck insert or stuck_bell_at stamp remains", () => {
  const sweep = code("supabase/functions/paidy-reconcile/index.ts");
  assert(!sweep.includes('type: "paidy_window_stuck"'));
  assert(!sweep.includes("stuck_bell_at: nowIso()"));
  assert(!sweep.includes('.is("stuck_bell_at", null)'));
  assertEquals((sweep.match(/supabase\.rpc\("paidy_window_stuck_missing", \{/g) ?? []).length, 1);
  assertEquals((sweep.match(/ring: \(attemptId, bell\) => ringPaidyWindowStuckBell\(supabase, attemptId, bell\),/g) ?? []).length, 1);
  assertEquals((sweep.match(/report\.window_stuck_bells \+= sweep\.rung;/g) ?? []).length, 1);
});

Deno.test("migration: unique index, writer and lister, service_role only", () => {
  const m = read("supabase/migrations/20261209130000_paidy_window_stuck_bell_once.sql");
  assert(m.includes("CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_notifications_paidy_window_stuck"));
  assert(m.includes("ON public.staff_notifications ((metadata->>'attempt_id'))\n  WHERE type = 'paidy_window_stuck';"));
  assert(m.includes("ON CONFLICT ((metadata->>'attempt_id')) WHERE type = 'paidy_window_stuck'"));
  assert(m.includes("SELECT * INTO v_w FROM public.paidy_checkout_attempts WHERE id = p_attempt_id FOR UPDATE;"));
  assert(m.includes("IF v_w.status <> 'open' OR v_w.authorization_noted_at IS NULL THEN"));
  assert(m.includes("UPDATE public.paidy_checkout_attempts SET stuck_bell_at = coalesce(stuck_bell_at, now()) WHERE id = p_attempt_id;"));
  for (const sig of ["ring_paidy_window_stuck_bell(uuid, text, text, jsonb)", "paidy_window_stuck_missing(timestamptz, timestamptz, uuid, integer)"]) {
    assert(m.includes(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`), sig);
    assert(m.includes(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`), sig);
  }
  assert(m.includes("RAISE EXCEPTION 'STOP — duplicate paidy_window_stuck bells exist on live"));
});
