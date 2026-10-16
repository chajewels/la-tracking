/**
 * Paidy error reporting (QA 2026-10-16 23:42 JST; owner go 23:51):
 *  O1 ringPaidyRecordedBell reads only a boolean answer; anything else is a
 *     failure, never "already exists".
 *  O2 paidy-reconcile's end-of-run summary queries count their errors
 *     (summary_errors) and a non-zero count makes the run not-ok.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ringPaidyRecordedBell } from "../supabase/functions/_shared/paidy-recorded-bell.ts";
import { countSummaryErrors } from "../supabase/functions/_shared/paidy-reconcile-queues.ts";

const root = new URL("../", import.meta.url);
const code = (p: string) => Deno.readTextFileSync(new URL(p, root)).split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");

const fakeDb = (answer: () => Promise<{ data: unknown; error: unknown }>) => ({ rpc: () => answer() });
const bell = { title: "t", body: "b" };
const meta = { cash_payment_id: "00000000-0000-4000-8000-000000000001" };
const quiet = <T>(f: () => Promise<T>) => async () => {
  const e = console.error; console.error = () => {};
  try { return await f(); } finally { console.error = e; }
};

Deno.test("O1: true = rung, false = exists", async () => {
  assertEquals(await ringPaidyRecordedBell(fakeDb(() => Promise.resolve({ data: true, error: null })), bell, meta), "rung");
  assertEquals(await ringPaidyRecordedBell(fakeDb(() => Promise.resolve({ data: false, error: null })), bell, meta), "exists");
});

Deno.test("O1: an unexpected answer is a failure, never 'exists'", quiet(async () => {
  for (const data of [null, undefined, "true", 1, 0, {}, []]) {
    assertEquals(await ringPaidyRecordedBell(fakeDb(() => Promise.resolve({ data, error: null })), bell, meta), "failed", String(data));
  }
}));

Deno.test("O1: an error or a throw is a failure", quiet(async () => {
  assertEquals(await ringPaidyRecordedBell(fakeDb(() => Promise.resolve({ data: null, error: { message: "x" } })), bell, meta), "failed");
  assertEquals(await ringPaidyRecordedBell(fakeDb(() => { throw new Error("down"); }), bell, meta), "failed");
}));

Deno.test("O1 wiring: the old 'anything not true is exists' mapping is gone", () => {
  const src = code("supabase/functions/_shared/paidy-recorded-bell.ts");
  assert(!src.includes('return data === true ? "rung" : "exists";'), "old mapping removed");
  assert(src.includes('if (data === false) return "exists";'));
});

Deno.test("O2: countSummaryErrors counts only answers that carry an error", () => {
  const seen: number[] = [];
  const n = countSummaryErrors(
    [{ error: null }, { error: { message: "a" } }, {}, { error: undefined }, { error: { message: "b" } }],
    (i) => seen.push(i),
  );
  assertEquals(n, 2);
  assertEquals(seen, [1, 4]);
  assertEquals(countSummaryErrors([]), 0);
});

Deno.test("O2 wiring: paidy-reconcile counts summary errors and a non-zero count makes the run not-ok", () => {
  const src = code("supabase/functions/paidy-reconcile/index.ts");
  assert(src.includes("const summary = await Promise.all(["));
  assert(src.includes("report.summary_errors = countSummaryErrors(summary,"));
  assert(src.includes("&& report.summary_errors === 0;"));
  assert(src.includes("summary_errors: 0,"));
  assert(!/\] = await Promise\.all\(\[\n\s*supabase\.from\("paidy_webhook_events"\)/.test(src), "errors no longer discarded by destructuring the await");
});
