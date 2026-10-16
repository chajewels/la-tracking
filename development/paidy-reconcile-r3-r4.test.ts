/**
 * paidy-reconcile recovery limits R3 / R4 (owner go 2026-10-16 15:41 JST; QA
 * assessment 2026-10-11 13:15 JST). Pure sweep logic, wiring on comment-stripped
 * code, migration contents. Real-Postgres query shapes:
 * development/sql/paidy-reconcile-r3-r4.sh.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAIDY_STUCK_CONFIRM_MAX_PAGES, PAIDY_STUCK_CONFIRM_PAGE, paidyStuckConfirmLeaseCut, type StuckConfirm,
  type StuckConfirmSweepDeps, sweepStuckConfirms,
} from "../supabase/functions/_shared/paidy-reconcile-queues.ts";
import { PAIDY_CONFIRM_LEASE_MS } from "../supabase/functions/_shared/paidy-rules.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");

const rows = (n: number, start = 0): StuckConfirm[] => Array.from({ length: n }, (_, i) => {
  const at = new Date(Date.UTC(2026, 9, 16, 0, 0, start + i)).toISOString();
  return {
    submission_id: `00000000-0000-0000-0000-${String(start + i).padStart(12, "0")}`,
    cash_order_id: `10000000-0000-0000-0000-${String(start + i).padStart(12, "0")}`,
    payment_method: "paidy", reference_number: null, processing_started_at: at, paidy_payment_id: `pay_${start + i}`, sort_at: at,
  };
});

/** A lister that never removes rows (every stuck Confirm stays stuck) and keysets like the SQL. */
function persistent(all: StuckConfirm[]) {
  const handled: string[] = [];
  const deps: StuckConfirmSweepDeps = {
    list: (after, limit) => Promise.resolve(all
      .filter((r) => !after || r.sort_at > after.at || (r.sort_at === after.at && r.submission_id > after.id))
      .slice(0, limit)),
    handle: (r) => { handled.push(r.submission_id); return Promise.resolve(); },
  };
  return { deps, handled };
}

Deno.test("lease cut: now minus the Confirm lease", () => {
  const now = Date.UTC(2026, 9, 16, 6, 0, 0);
  assertEquals(paidyStuckConfirmLeaseCut(now), new Date(now - PAIDY_CONFIRM_LEASE_MS).toISOString());
});

Deno.test("R3: more than 100 stuck Confirms that stay stuck — every one is read once per run", async () => {
  const all = rows(PAIDY_STUCK_CONFIRM_PAGE * 2 + 37);
  const s = persistent(all);
  const r = await sweepStuckConfirms(s.deps);
  assertEquals(r.seen, all.length);
  assertEquals(s.handled.length, all.length);
  assertEquals(new Set(s.handled).size, all.length);
  assertEquals(r.pages, 3);
  assertEquals(r.oldest?.submission_id, all[0].submission_id);
});

Deno.test("R3: the second run reads the same full set again (nothing is starved behind the first 100)", async () => {
  const all = rows(PAIDY_STUCK_CONFIRM_PAGE + 5);
  const s = persistent(all);
  await sweepStuckConfirms(s.deps);
  await sweepStuckConfirms(s.deps);
  assertEquals(s.handled.length, all.length * 2);
  assert(s.handled.includes(all[all.length - 1].submission_id));
});

Deno.test("R3: keyset cursor is (sort_at, submission_id) of the last row", async () => {
  const seen: ({ at: string; id: string } | null)[] = [];
  const all = rows(PAIDY_STUCK_CONFIRM_PAGE + 1);
  const s = persistent(all);
  await sweepStuckConfirms({ list: (a, l) => { seen.push(a); return s.deps.list(a, l); }, handle: s.deps.handle });
  assertEquals(seen[0], null);
  assertEquals(seen[1], { at: all[PAIDY_STUCK_CONFIRM_PAGE - 1].sort_at, id: all[PAIDY_STUCK_CONFIRM_PAGE - 1].submission_id });
});

Deno.test("R3: bounded per run; an empty list reads one page and reports no oldest", async () => {
  let pages = 0;
  const r = await sweepStuckConfirms({
    list: (_a, limit) => { pages++; return Promise.resolve(rows(limit, pages * limit)); },
    handle: () => Promise.resolve(),
  });
  assertEquals([r.pages, pages], [PAIDY_STUCK_CONFIRM_MAX_PAGES, PAIDY_STUCK_CONFIRM_MAX_PAGES]);
  const e = await sweepStuckConfirms({ list: () => Promise.resolve([]), handle: () => Promise.resolve() });
  assertEquals([e.seen, e.pages, e.oldest], [0, 1, null]);
});

Deno.test("wiring R3: step 5 reads through paidy_stuck_confirms only; the unordered first-100 read is gone", () => {
  const src = code("supabase/functions/paidy-reconcile/index.ts");
  assertEquals((src.match(/supabase\.rpc\("paidy_stuck_confirms", \{/g) ?? []).length, 1);
  assert(src.includes("p_lease_cut: leaseCut, p_after_at: after?.at ?? null, p_after_id: after?.id ?? null, p_limit: limit,"));
  assert(!src.includes('.eq("status", "confirmed").is("confirmed_payment_id", null).limit(100)'), "old unordered read removed");
  assert(src.includes("if (!paidyConfirmLeaseExpired(s.processing_started_at)) return;"), "defensive lease check kept");
  assert(src.includes('{ cash_order_id: s.cash_order_id, submission_id: s.submission_id, paidy_payment_id: pid }'));
  assert(src.includes('{ cash_order_id: s.cash_order_id, submission_id: s.submission_id, paidy_payment_id: `submission:${s.submission_id}` }'));
});

Deno.test("wiring R4: window verification and orphan cases rotate by a last-tried stamp, written on every attempt", () => {
  const src = code("supabase/functions/paidy-reconcile/index.ts");
  assert(src.includes('.order("verify_tried_at", { ascending: true, nullsFirst: true }).order("expires_at", { ascending: true })'));
  assert(src.includes('await supabase.from("paidy_checkout_attempts").update({ verify_tried_at: nowIso() }).eq("id", w.id).eq("status", "open");'));
  assert(src.includes('.order("sweep_tried_at", { ascending: true, nullsFirst: true }).order("opened_at", { ascending: true }).limit(50);'));
  assert(src.includes('await supabase.from("paidy_cases").update({ sweep_tried_at: nowIso() }).eq("id", c.id);'));
  // the stamp comes BEFORE the Paidy read, so a failed read still rotates
  const win = src.indexOf("update({ verify_tried_at: nowIso() })");
  assert(win > 0 && win < src.indexOf("live = await paidy.get(pid);", win));
  const orph = src.indexOf("update({ sweep_tried_at: nowIso() })");
  assert(orph > 0 && orph < src.indexOf("live = await paidy.get(String(c.paidy_payment_id));", orph));
  assert(!/\n\s*\.order\("opened_at", \{ ascending: true \}\)\.limit\(50\);/.test(src), "old opened_at-only order removed");
});

Deno.test("wiring R4: a started cancel intent whose bell rang no longer fills the batch", () => {
  const src = code("supabase/functions/paidy-reconcile/index.ts");
  assert(src.includes('.lte("updated_at", cut)\n        .or("stage.neq.started,bell_rung_at.is.null")\n        .order("updated_at", { ascending: true }).limit(20);'));
});

Deno.test("wiring R4: lag figures for the two recovery queues and stuck Confirms", () => {
  const src = code("supabase/functions/paidy-reconcile/index.ts");
  for (const f of ["oldest_window_verify_minutes", "oldest_orphan_case_minutes", "oldest_stuck_confirm_minutes"]) {
    assert(src.includes(`${f}: null as number | null`), f);
    assert(src.includes(`report.${f} =`), f);
  }
});

Deno.test("migration: additive columns, partial indexes, lister, service_role only", () => {
  const m = read("supabase/migrations/20261219100000_paidy_reconcile_r3_r4.sql");
  assert(m.includes("ALTER TABLE public.paidy_checkout_attempts ADD COLUMN IF NOT EXISTS verify_tried_at timestamptz;"));
  assert(m.includes("ALTER TABLE public.paidy_cases ADD COLUMN IF NOT EXISTS sweep_tried_at timestamptz;"));
  for (const ix of ["idx_paidy_checkout_attempts_verify_queue", "idx_paidy_cases_orphan_queue", "idx_payment_submissions_stuck_confirm"]) {
    assert(m.includes(`CREATE INDEX IF NOT EXISTS ${ix}`), ix);
  }
  assert(m.includes("AND (s.processing_started_at IS NULL OR s.processing_started_at <= p_lease_cut)"));
  assert(m.includes("OR (coalesce(s.processing_started_at, '-infinity'::timestamptz), s.id) > (p_after_at, p_after_id))"));
  assert(m.includes("ORDER BY coalesce(s.processing_started_at, '-infinity'::timestamptz), s.id"));
  const sig = "paidy_stuck_confirms(timestamptz, timestamptz, uuid, integer)";
  assert(m.includes(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`));
  assert(m.includes(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`));
  assert(!/CREATE OR REPLACE FUNCTION public\.(?!paidy_stuck_confirms\b)/.test(m), "no existing function is redefined");
  assert(!/\bDEFAULT\s+now\(\)/i.test(m) && !/\bUPDATE\s+public\./i.test(m), "no default, no backfill");
});
