/**
 * Repo structure catch-up (Paidy V03 finding F2, owner go 2026-10-09).
 * docs/MIGRATIONS.md "Structure catch-up". The full proof is
 * scripts/structure-drift-audit (replay + compare against live); these guards
 * keep the record-only files and the audit query honest in CI, where no
 * database exists.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, root));
const CATCHUP = [
  "supabase/migrations/20260705230001_record_live_only_structure.sql",
  "supabase/migrations/20260917070101_record_live_only_triggers_and_grants.sql",
  "supabase/migrations/20261023235900_record_live_only_policies.sql",
  "supabase/migrations/20261130140000_record_live_structure_tail.sql",
];
const code = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

Deno.test("every migration version is unique", async () => {
  const seen = new Map<string, string>();
  for await (const e of Deno.readDir(new URL("supabase/migrations/", root))) {
    if (!e.name.endsWith(".sql")) continue;
    const v = e.name.slice(0, 14);
    assert(!seen.has(v), `duplicate version ${v}: ${seen.get(v)} and ${e.name}`);
    seen.set(v, e.name);
  }
});

Deno.test("catch-up files only ever add what is missing (no-op on live)", async () => {
  for (const f of CATCHUP) {
    const sql = code(await read(f));
    assert(!/\bDROP\s+TABLE\b/i.test(sql), `${f}: drops a table`);
    assert(!/\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+public\./i.test(sql), `${f}: touches data`);
    assert(!/^CREATE TABLE (?!IF NOT EXISTS)/m.test(sql), `${f}: unguarded CREATE TABLE`);
    assert(!/^ALTER TABLE \S+ ADD COLUMN (?!IF NOT EXISTS)/m.test(sql), `${f}: unguarded ADD COLUMN`);
    assert(!/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/m.test(sql), `${f}: unguarded CREATE INDEX`);
    assert(!/^CREATE (POLICY|TRIGGER) /m.test(sql), `${f}: policy/trigger outside a create-if-missing block`);
  }
});

Deno.test("the tail sets live's grants only when they differ", async () => {
  const sql = code(await read(CATCHUP[3]));
  assert(/IF v_now IS DISTINCT FROM/.test(sql));
  assertEquals((sql.match(/^SELECT pg_temp\.cj_set_exec\(/gm) ?? []).length, 108);
});

Deno.test("the structure audit query is one read-only SELECT", async () => {
  const sql = code(await read("scripts/structure-drift-audit.sql"));
  assert(/^WITH acl AS/m.test(sql));
  assert(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(sql.replace(/'[^']*'/g, "")), "writes");
  assertEquals((sql.match(/;/g) ?? []).length, 1);
});
