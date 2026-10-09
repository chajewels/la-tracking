/**
 * Staff guard on the 14 SECURITY DEFINER functions any signed-in user could
 * call (owner go 2026-10-09). docs/FIXED-BUGS.md "Staff-only report and
 * allocation functions". The behaviour proof (customer / anon refused; admin,
 * staff, finance, service_role and the SQL Editor allowed; only an
 * edit_schedule holder may override an allocation) ran on a replay of the repo;
 * these guards keep the migration honest in CI, where no database exists.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../", import.meta.url);
const MIG = "supabase/migrations/20261130160000_staff_guard_exposed_functions.sql";
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const GUARDED: Record<string, string | null> = {
  "admin_keep_allocation_override(uuid,numeric)": "edit_schedule",
  "audit_account(text)": null,
  "audit_all_accounts()": null,
  "audit_delete_cleanup_invariants()": null,
  "get_aging_buckets(text)": null,
  "get_cash_orders_monthly()": null,
  "get_forecast_6m()": null,
  "get_forecast_drilldown(text)": null,
  "get_monthly_analytics()": null,
  "get_monthly_sales(text,integer)": null,
  "get_staff_performance(integer)": null,
  "get_trade_kpis()": null,
  "get_trade_monthly_trends(integer)": null,
  "monthly_inflow_by_plan_6m()": null,
};

Deno.test("every exposed function is patched exactly once, md5-guarded both ways", async () => {
  const sql = code(await Deno.readTextFile(new URL(MIG, root)));
  const calls = [...sql.matchAll(/^SELECT pg_temp\.cj_guard\('public\.([^']+)', '([0-9a-f]{32})', '([0-9a-f]{32})', (NULL|'[a-z_]+')\);$/gm)];
  assertEquals(calls.length, Object.keys(GUARDED).length);
  for (const [, sig, oldMd5, newMd5, perm] of calls) {
    assert(sig in GUARDED, `unexpected function ${sig}`);
    assert(oldMd5 !== newMd5, `${sig}: before and after md5 are the same`);
    const want = GUARDED[sig];
    assertEquals(perm, want === null ? "NULL" : `'${want}'`, `${sig}: wrong permission`);
  }
});

Deno.test("the patcher refuses drift and refuses an unexpected result", async () => {
  const sql = code(await Deno.readTextFile(new URL(MIG, root)));
  assert(/IF md5\(v_def\) <> p_old_md5 THEN\s+RAISE EXCEPTION/.test(sql), "no drift refusal");
  assert(/IF md5\(pg_get_functiondef\(p_fn\)\) <> p_new_md5 THEN\s+RAISE EXCEPTION/.test(sql), "no result check");
});

Deno.test("assert_staff_caller: staff or permission, service_role, no-identity only; nobody calls it directly", async () => {
  const sql = code(await Deno.readTextFile(new URL(MIG, root)));
  assert(/^CREATE OR REPLACE FUNCTION public\.assert_staff_caller\(p_permission text DEFAULT NULL\)/m.test(sql));
  assert(/v_claims->>'role' = 'service_role'/.test(sql));
  assert(/public\.is_staff\(v_uid\)/.test(sql));
  assert(/public\.has_permission\(v_uid, p_permission\)/.test(sql));
  assert(/RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'/.test(sql));
  assert(/^REVOKE ALL ON FUNCTION public\.assert_staff_caller\(text\) FROM PUBLIC, anon, authenticated;$/m.test(sql));
});
