/**
 * "fix 6c" (owner 2026-10-11; QA residual): the first bell of a Paidy case is
 * written by ONE atomic writer (ring_paidy_case_bell — unique index + stamp in
 * the same transaction), used by openPaidyCase and by the hourly sweep, and
 * the sweep walks EVERY unrung case (keyset-paged). Pure sweep logic, the
 * writer's contract against a modelled database, and wiring on
 * comment-stripped code. The real-Postgres races are in
 * development/sql/paidy-case-bell-once.sh.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CaseRingOutcome, type CaseSweepDeps, PAIDY_CASE_BELL_MAX_PAGES, PAIDY_CASE_BELL_PAGE, ringPaidyCaseBell,
  sweepUnrungPaidyCases, type UnrungPaidyCase,
} from "../supabase/functions/_shared/paidy-case-bell.ts";
import { openPaidyCase } from "../supabase/functions/_shared/paidy-sync.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");

const unrung = (n: number, start = 0): UnrungPaidyCase[] => Array.from({ length: n }, (_, i) => ({
  case_id: `00000000-0000-0000-0000-${String(start + i).padStart(12, "0")}`, kind: "record_failed",
  paidy_payment_id: `pay_${start + i}`, cash_order_id: null, detail: { captured_jpy: 1000 },
  opened_at: new Date(Date.UTC(2026, 9, 11, 0, 0, start + i)).toISOString(), reference: `CJ-W-${start + i}`,
}));

/** A keyset source over a fixed list; a ring that fails leaves the case listed. */
function source(all: UnrungPaidyCase[], outcome: (c: UnrungPaidyCase) => CaseRingOutcome) {
  const rung = new Set<string>();
  const calls: string[] = [];
  const deps: CaseSweepDeps = {
    missing: (after, limit) => Promise.resolve(all
      .filter((c) => !rung.has(c.case_id))
      .filter((c) => !after || c.opened_at > after.at || (c.opened_at === after.at && c.case_id > after.id))
      .slice(0, limit)),
    ring: (caseId) => {
      calls.push(caseId);
      const c = all.find((x) => x.case_id === caseId)!;
      const r = outcome(c);
      if (r === "rung" || r === "exists") rung.add(caseId);
      return Promise.resolve(r);
    },
  };
  return { deps, calls };
}

Deno.test("sweep: more than one page of unrung cases — every one is rung", async () => {
  const all = unrung(PAIDY_CASE_BELL_PAGE * 2 + 37);
  const s = source(all, () => "rung");
  const r = await sweepUnrungPaidyCases(s.deps);
  assertEquals(r.rung, all.length);
  assertEquals(new Set(s.calls).size, all.length);
});

Deno.test("sweep: cases whose ring keeps failing never hide the ones after them", async () => {
  const all = unrung(PAIDY_CASE_BELL_PAGE + 25);
  const failing = new Set(all.slice(0, PAIDY_CASE_BELL_PAGE).map((c) => c.case_id));
  const s = source(all, (c) => failing.has(c.case_id) ? "failed" : "rung");
  const r = await sweepUnrungPaidyCases(s.deps);
  assertEquals(r.failed, PAIDY_CASE_BELL_PAGE);
  assertEquals(r.rung, 25);
  assertEquals(s.calls.length, all.length); // each case tried exactly once per run
});

Deno.test("sweep: another worker already rang it → counted as exists, not rung", async () => {
  const all = unrung(3);
  const s = source(all, (c) => c.case_id.endsWith("1") ? "exists" : c.case_id.endsWith("2") ? "closed" : "rung");
  const r = await sweepUnrungPaidyCases(s.deps);
  assertEquals([r.rung, r.already, r.closed, r.failed], [1, 1, 1, 0]);
});

Deno.test("sweep: bounded per run", async () => {
  let pages = 0;
  const r = await sweepUnrungPaidyCases({
    missing: (_a, limit) => { pages++; return Promise.resolve(unrung(limit, pages * limit)); },
    ring: () => Promise.resolve("failed"),
  });
  assertEquals(r.pages, PAIDY_CASE_BELL_MAX_PAGES);
  assertEquals(pages, PAIDY_CASE_BELL_MAX_PAGES);
});

Deno.test("sweep: the late bell carries the case's own text and late:true", async () => {
  const seen: { bell: { title: string; body: string }; md: Record<string, unknown> }[] = [];
  await sweepUnrungPaidyCases({
    missing: (after) => Promise.resolve(after ? [] : unrung(1)),
    ring: (_id, bell, md) => { seen.push({ bell, md }); return Promise.resolve("rung"); },
  });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].bell.title, "Paidy capture could not be recorded");
  assert(seen[0].bell.body.includes("pay_0") && seen[0].bell.body.includes("CJ-W-0"));
  assertEquals(seen[0].md, { cash_order_id: null, late: true });
});

Deno.test("writer: never throws; an error or an unknown answer is 'failed'", async () => {
  const bell = { title: "t", body: "b" };
  assertEquals(await ringPaidyCaseBell({ rpc: () => Promise.resolve({ data: null, error: { message: "x" } }) }, "c", bell, {}), "failed");
  assertEquals(await ringPaidyCaseBell({ rpc: () => { throw new Error("net"); } }, "c", bell, {}), "failed");
  assertEquals(await ringPaidyCaseBell({ rpc: () => Promise.resolve({ data: true, error: null }) }, "c", bell, {}), "failed");
  for (const ok of ["rung", "exists", "closed"] as const) {
    assertEquals(await ringPaidyCaseBell({ rpc: () => Promise.resolve({ data: ok, error: null }) }, "c", bell, {}), ok);
  }
});

Deno.test("openPaidyCase: a new case rings through the one writer; an existing case does not ring", async () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let isNew = true;
  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "open_paidy_case") return Promise.resolve({ data: { ok: true, case_id: "case-1", new: isNew }, error: null });
      if (fn === "ring_paidy_case_bell") return Promise.resolve({ data: "rung", error: null });
      return Promise.resolve({ data: null, error: { message: fn } });
    },
    from: () => { throw new Error("openPaidyCase must not write tables directly"); },
  };
  const bell = { title: "T", body: "B" };
  await openPaidyCase(db, { kind: "record_failed", paidy_payment_id: "pay_1", cash_order_id: "o1", bell });
  assertEquals(calls.map((c) => c.fn), ["open_paidy_case", "ring_paidy_case_bell"]);
  assertEquals(calls[1].args, { p_case_id: "case-1", p_title: "T", p_body: "B", p_metadata: { cash_order_id: "o1" } });
  isNew = false; calls.length = 0;
  await openPaidyCase(db, { kind: "record_failed", paidy_payment_id: "pay_1", bell });
  assertEquals(calls.map((c) => c.fn), ["open_paidy_case"]);
});

Deno.test("wiring: no direct case-bell insert or bell_rung_at stamp remains in edge code", () => {
  const sync = code("supabase/functions/_shared/paidy-sync.ts");
  const sweep = code("supabase/functions/paidy-reconcile/index.ts");
  assert(!/paidy_case_\$\{/.test(sync), "paidy-sync must not build a case-bell type itself");
  assert(!sync.includes('from("paidy_cases").update({ bell_rung_at'));
  assert(!sweep.includes('from("paidy_cases").update({ bell_rung_at'));
  assert(!sweep.includes('.contains("metadata", { case_id: c.id })'));
  assertEquals((sweep.match(/sweepUnrungPaidyCases\(\{/g) ?? []).length, 1);
  assertEquals((sweep.match(/supabase\.rpc\("paidy_case_bell_missing", \{/g) ?? []).length, 1);
  assertEquals((sweep.match(/report\.case_bells_rung \+= sweep\.rung;/g) ?? []).length, 1);
  assertEquals((sync.match(/await ringPaidyCaseBell\(supabase, r\.case_id, c\.bell,/g) ?? []).length, 1);
});

Deno.test("migration: unique index, writer and lister, service_role only", () => {
  const m = read("supabase/migrations/20261209100000_paidy_case_bell_once.sql");
  assert(m.includes("CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_notifications_paidy_case"));
  assert(m.includes("ON public.staff_notifications ((metadata->>'case_id'))\n  WHERE type LIKE 'paidy\\_case\\_%';"));
  assert(m.includes("ON CONFLICT ((metadata->>'case_id')) WHERE type LIKE 'paidy\\_case\\_%'"));
  assert(m.includes("SELECT * INTO v_case FROM public.paidy_cases WHERE id = p_case_id FOR UPDATE;"));
  assert(m.includes("UPDATE public.paidy_cases SET bell_rung_at = coalesce(bell_rung_at, now()) WHERE id = p_case_id;"));
  for (const sig of ["ring_paidy_case_bell(uuid, text, text, jsonb)", "paidy_case_bell_missing(timestamptz, uuid, integer)"]) {
    assert(m.includes(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`), sig);
    assert(m.includes(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`), sig);
  }
  assert(m.includes("RAISE EXCEPTION 'STOP — duplicate paidy_case bells exist on live"));
});
