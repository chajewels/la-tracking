// CI guard: a NEW policy may not admit signed-out visitors by accident
// (docs/OPEN-BUGS.md "anon holds full table-level grants", fix option (b),
// built 2026-10-03). Supabase grants `anon` broadly at the table level, so RLS
// policies are the only gate; one `TO public USING (true)` meant for staff
// would open a table to the internet.
//
// Every migration NEWER than BASELINE is scanned. A CREATE/ALTER POLICY that
// applies to anon or public (no TO clause means PUBLIC) must reference an auth
// predicate (auth.uid / auth.role / auth.jwt / has_role / is_staff / is_admin /
// service_role) in USING or WITH CHECK — or be listed in ALLOWED as a
// deliberate public surface, with the reason.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const BASELINE = "20261026100000"; // last migration audited by hand (2026-10-03)

// table.policy → why it is public on purpose
const ALLOWED = {
  "announcements.Public can read active announcements": "storefront/portal banner content",
  "loyalty_banners.Anon can read active banners": "loyalty portal content",
  "loyalty_rewards.Anon can read active rewards": "loyalty portal catalogue",
  "loyalty_tiers.anon_read_tiers": "tier ladder shown before sign-in",
  "notify_loyalty_launch.anon_insert_notify": "sign-up form, email-format check",
  "payment_methods.Anyone can view active payment methods": "transfer instructions shown to customers",
  "payment_submissions.Anon can insert submissions with token": "portal token gate",
  "payment_submissions.Anon can view own submissions by token": "portal token gate",
  "payment_submissions.Anon can cancel cash order submissions": "portal token gate",
  "promo_categories.Public can read categories": "promotions content",
  "promo_category_assignments.Public can read category assignments": "promotions content",
  "promotions.Active promos visible to all": "promotions content",
};

const AUTH = /(auth\.uid|auth\.role|auth\.jwt|has_role|is_staff|is_admin|service_role|current_user|x-portal-token)/i;
const strip = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const unq = (s) => s.replace(/^"|"$/g, "").replace(/^public\./, "");

const findings = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql") && f.slice(0, 14) > BASELINE).sort()) {
  const sql = strip(readFileSync(join(DIR, file), "utf8"));
  const re = /\b(CREATE|ALTER)\s+POLICY\s+("[^"]+"|\S+)\s+ON\s+([\w."]+)([\s\S]*?);/gi;
  for (const m of sql.matchAll(re)) {
    const [, verb, rawName, rawTable, rest] = m;
    const name = unq(rawName), table = unq(rawTable.replace(/^"public"\./, ""));
    const to = /\bTO\s+([\s\S]*?)(?=\bUSING\b|\bWITH\s+CHECK\b|$)/i.exec(rest);
    // CREATE without TO = PUBLIC. ALTER without TO keeps the old roles: only
    // judged when its predicate changes (USING / WITH CHECK present).
    const roles = to ? to[1].toLowerCase() : verb.toUpperCase() === "CREATE" ? "public" : null;
    if (verb.toUpperCase() === "ALTER" && !to && !/\b(USING|WITH\s+CHECK)\b/i.test(rest)) continue;
    const admitsAnon = roles === null || /\b(anon|public)\b/.test(roles);
    if (!admitsAnon) continue;
    if (AUTH.test(rest)) continue;
    if (ALLOWED[`${table}.${name}`]) continue;
    findings.push(`${file}: ${verb.toUpperCase()} POLICY "${name}" ON ${table} admits ${roles ?? "its existing roles"} with no auth predicate`);
  }
}
if (findings.length) {
  console.error("anon-policies: a policy would let signed-out visitors in.");
  console.error("Add an auth predicate, scope it TO authenticated, or — if it is meant to be public — add it to ALLOWED with the reason:");
  for (const f of findings) console.error("  " + f);
  process.exit(1);
}
console.log("anon-policies: no new policy admits anon/public without an auth predicate");
