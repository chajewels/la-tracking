/**
 * Paidy QC PR-A (owner go 2026-10-09 19:44 JST, all recommended options).
 * Assessment: project doc claude/paidy-qc-assessment-2026-10-09.md.
 *
 * The database behaviour (H1 staff exit, M2, M3, M4, M6, L4, L7, M7, L10) was
 * proved on a scratch replay whose Paidy bodies are byte-identical to live;
 * these tests pin the pure rules and keep the wiring and the migration honest
 * in CI, where no database exists. Wiring greps run on comment-stripped code.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  paidyAdoptBlock, paidyAuthorizationLapsed, paidyMismatchReleases, paidyNoteDecision, paidyProviderOutcome,
  paidyWebhookSource,
} from "../supabase/functions/_shared/paidy-rules.ts";

const root = new URL("../", import.meta.url);
const raw = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (p: string) => raw(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");
const MIG = "supabase/migrations/20261201100000_paidy_qc_pr_a.sql";
const hdrs = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

// ---------------------------------------------------------------- pure rules

Deno.test("H1: a browser-supplied Paidy id is noted only when Paidy says it is THIS order's", () => {
  const order = { id: "o-1", ref: "CJ-W-900074" };
  assertEquals(paidyNoteDecision({ notFound: true }, order), "unknown_to_paidy");
  assertEquals(paidyNoteDecision({ error: true }, order), "note_unverified");
  assertEquals(paidyNoteDecision({ payment: { order: { order_ref: "CJ-W-900074" } } }, order), "note");
  assertEquals(paidyNoteDecision({ payment: { order: { order_ref: "X" }, metadata: { cash_order_id: "o-1" } } }, order), "note");
  assertEquals(paidyNoteDecision({ payment: { order: { order_ref: "CJ-W-900001" }, metadata: { cash_order_id: "o-2" } } }, order), "other_order");
  assertEquals(paidyNoteDecision({ payment: { order: null } }, { id: "o-1", ref: "" }), "other_order");
});

Deno.test("M1: another order's (order_ref) or the other environment's (test_flag) authorisation is never closed", () => {
  assertEquals(paidyMismatchReleases("order_ref"), false);
  assertEquals(paidyMismatchReleases("test_flag"), false);
  assertEquals(paidyMismatchReleases(null), false);
  for (const m of ["amount", "not_jpy", "not_authorized", "unknown_payment"]) assertEquals(paidyMismatchReleases(m), true, m);
});

Deno.test("L1: adoption applies the switches the website applies", () => {
  const web = { source_channel: "web", payment_method: "paidy" };
  assertEquals(paidyAdoptBlock("off", web, { is_test: true }), "paidy_off");
  assertEquals(paidyAdoptBlock("test", web, { is_test: false }), "not_test_customer");
  assertEquals(paidyAdoptBlock("test", web, null), "not_test_customer");
  assertEquals(paidyAdoptBlock("on", { source_channel: "web", payment_method: "transfer" }, {}), "method_not_paidy");
  assertEquals(paidyAdoptBlock("on", web, {}), null);
  assertEquals(paidyAdoptBlock("test", web, { is_test: true }), null);
  assertEquals(paidyAdoptBlock("on", { source_channel: "hub", payment_method: null }, {}), null);
});

Deno.test("L2: an AUTHORIZED read-back with no dates is still authorised, never 'expired'", () => {
  assertEquals(paidyAuthorizationLapsed({}), false);
  assertEquals(paidyProviderOutcome({ status: "AUTHORIZED", captures: [] }), "authorized");
  assertEquals(paidyProviderOutcome({ status: "AUTHORIZED", captures: [], expires_at: "2000-01-01T00:00:00Z" }), "expired");
});

Deno.test("M5: a source is recognised only when every address it carries is Paidy's", () => {
  assertEquals(paidyWebhookSource(hdrs({ "cf-connecting-ip": "13.114.134.35", "x-forwarded-for": "13.114.134.35" })).recognised, true);
  assertEquals(paidyWebhookSource(hdrs({ "x-forwarded-for": "9.9.9.9, 52.199.50.20" })).recognised, true);
  assertEquals(paidyWebhookSource(hdrs({ "cf-connecting-ip": "13.114.134.35", "x-forwarded-for": "1.2.3.4" })).recognised, false, "a forged cf header alone is not enough");
  assertEquals(paidyWebhookSource(hdrs({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "13.114.134.35" })).recognised, false, "a forged xff hop alone is not enough");
  assertEquals(paidyWebhookSource(hdrs({})).recognised, false);
  assertEquals(paidyWebhookSource(hdrs({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" })).ips, "1.2.3.4|5.6.7.8");
});

// -------------------------------------------------------------------- wiring

Deno.test("H1 wiring: the abandon callback asks Paidy before it notes an id", () => {
  const w = code("supabase/functions/website/index.ts");
  const at = w.indexOf('segments[3] === "abandon"');
  const get = w.indexOf("read = { payment: await paidy.get(body.paidy_payment_id) };", at);
  const decide = w.indexOf("noteCheck = paidyNoteDecision(read,", at);
  const note = w.indexOf('supabase.rpc("note_paidy_checkout_attempt_payment"', at);
  assert(at > 0 && get > at && decide > get && note > decide, "Paidy read → decision → note");
  assertStringIncludes(w, 'if (noteCheck === "note" || noteCheck === "note_unverified") {');
});

Deno.test("H1 wiring: the sweep stamps a 404 per key family and verifies only when both have answered", () => {
  const r = code("supabase/functions/paidy-reconcile/index.ts");
  assertStringIncludes(r, 'const mine = secretTest ? "not_found_test_at" : "not_found_live_at";');
  assertStringIncludes(r, 'const other = secretTest ? "not_found_live_at" : "not_found_test_at";');
  assert(/if \(stamped && \(stamped as Record<string, any>\)\[other\]\) \{[\s\S]{0,160}verified_empty_at: at/.test(r));
});

Deno.test("H1/M2 wiring: paidy-staff-action is a person-only, confirm_payment function that reads Paidy before the database", () => {
  const f = code("supabase/functions/paidy-staff-action/index.ts");
  assertStringIncludes(f, "const ctx = await requireAuth(req);");
  assert(!/allowServiceRole/.test(f), "no service-role path");
  assertStringIncludes(f, 'await requirePermission(ctx, "confirm_payment");');
  const get = f.indexOf("live = await paidy.get(pid);");
  const end = f.indexOf('supabase.rpc("staff_end_paidy_checkout_window"');
  assert(get > 0 && end > get, "Paidy first, then the window");
  assertStringIncludes(f, 'return fail("paidy_unavailable"');
  const rel = f.indexOf("const release = await releasePaidyAuthorization(supabase, live, {");
  assert(rel > 0 && f.indexOf("if (!paidyReleased(release)) {", rel) > rel, "close is classified by Paidy's answer");
  const toml = raw("supabase/config.toml");
  assertStringIncludes(toml, "[functions.paidy-staff-action]\n    verify_jwt = true");
});

Deno.test("M1 wiring: the filing never closes on order_ref / test_flag; the website routes it to its own order", () => {
  const f = code("supabase/functions/_shared/paidy-filing.ts");
  const guard = f.indexOf("if (mismatch && !paidyMismatchReleases(mismatch)) {");
  const close = f.indexOf("const release = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why: `mismatch: ${mismatch}` });");
  assert(guard > 0 && close > guard, "the no-close return comes before the release");
  const w = code("supabase/functions/website/index.ts");
  assertStringIncludes(w, 'if (filed.error === "paidy_mismatch" && filed.detail === "order_ref") {');
  assertStringIncludes(w, 'await adoptOrphanAuthorization(supabase, payment, "website_paidy");');
});

Deno.test("L1 wiring: webhook / sweep adoption and the sweep refile both apply paidyAdoptBlock", () => {
  assertStringIncludes(code("supabase/functions/_shared/paidy-filing.ts"), "const blocked = paidyAdoptBlock(mode, order, customer);");
  assertStringIncludes(code("supabase/functions/_shared/paidy-filing.ts"), "payment_status, payment_method, currency");
  assertStringIncludes(code("supabase/functions/paidy-reconcile/index.ts"), "const blocked = paidyAdoptBlock(mode, o, o.customer);");
});

Deno.test("M4 wiring: Confirm and the sync end a provider-ended submission through ONE RPC", () => {
  const r = code("supabase/functions/review-payment-submission/index.ts");
  const s = code("supabase/functions/_shared/paidy-sync.ts");
  for (const src of [r, s]) assertStringIncludes(src, 'supabase.rpc("end_paidy_submission_provider_ended_atomic", {');
  const end = r.slice(r.indexOf("const endSubmission = async"), r.indexOf("let live: PaidyPayment;"));
  assert(!/\.from\("payment_submissions"\)\.update\(/.test(end) && !/\.from\("audit_logs"\)\.insert\(/.test(end), "no separate writes left in endSubmission");
  assertStringIncludes(end, "p_claim_at: claimAt");
  const replay = code("supabase/functions/paidy-reconcile/index.ts");
  assertStringIncludes(replay, 'const kind = fu.payload?.kind === "provider_ended" ? "provider_ended" : "staff";');
});

Deno.test("M6 wiring: the Square capture checks the Paidy lock first", () => {
  const r = code("supabase/functions/review-payment-submission/index.ts");
  const lock = r.indexOf('supabase.rpc("cash_order_payment_lock", { p_cash_order_id: cashOrder.id });');
  const cap = r.indexOf("live = await square.complete(env, sp.square_payment_id, live.version_token ?? null);");
  assert(lock > 0 && cap > lock, "lock check before square.complete");
  assertStringIncludes(r, 'String(payLock ?? "").startsWith("paidy")');
  assertStringIncludes(code("supabase/functions/_shared/paidy-filing.ts"), 'if (err === "stale_authorization" || err === "card_payment_unresolved") {');
});

Deno.test("M5/L9 wiring: unrecognised deliveries are capped (429), the source is stored, a late finish uses waitUntil", () => {
  const w = code("supabase/functions/paidy-webhook/index.ts");
  assertStringIncludes(w, "source_ip: source.ips, source_recognised: recognisedSource");
  assert(/\.eq\("source_recognised", false\)\.gte\("received_at", since\)/.test(w));
  assertStringIncludes(w, 'return jsonResponse({ error: "rate_limited" }, 429);');
  assertStringIncludes(w, "rt.waitUntil(late)");
});

Deno.test("L8 wiring: an unsendable follow-up is marked failed with a bell, never done", () => {
  const r = code("supabase/functions/paidy-reconcile/index.ts");
  assertStringIncludes(r, 'update({ status: "failed", last_error: "unsendable_followup" })');
});

// ----------------------------------------------------------------- migration

Deno.test("migration: every existing function is patched from its live md5, nothing else", () => {
  const sql = code(MIG);
  const calls = [...sql.matchAll(/SELECT pg_temp\.cj_patch\('public\.([a-z_]+)\(/g)].map((m) => m[1]);
  assertEquals(calls.sort(), ["expire_paidy_checkout_attempts", "file_paidy_submission_atomic", "get_paidy_settings", "record_paidy_refund", "resolve_paidy_case"]);
  for (const md5 of ["29887dd66f546ab4038e20a49e6b28ee", "195964b6fa65d2936fa41a0eb08699d6", "b6d33a3a3c60760c0ce040f18ae727f8", "b74650c77ac470c8fcf9043dba26a6f8", "c5cf9d1780d07709195e27af2fa9c79c"]) {
    assertStringIncludes(sql, `', '${md5}', jsonb_build_array(`);
  }
  assert(/IF md5\(v_def\) <> p_before THEN\s+RAISE EXCEPTION/.test(sql));
});

Deno.test("migration: M2 refusal, M3 order, M6 before the insert, L7 before the insert", () => {
  const sql = raw(MIG);
  assertStringIncludes(sql, "RETURN jsonb_build_object('error', 'authorization_open', 'paidy_payment_id', v_rec.paidy_payment_id);");
  const m6 = sql.indexOf("IF public.cash_order_payment_lock(v_order.id, v_rec.id, true) = 'card_payment_unresolved' THEN");
  assert(m6 > 0 && sql.indexOf("-- The record is written BEFORE the one-payment check", m6) > m6);
  const l7 = sql.indexOf("RETURN jsonb_build_object('ok', false, 'error', 'refund_exceeds_capture', 'inserted', false,");
  assert(l7 > 0 && sql.indexOf("INSERT INTO public.paidy_refunds (paidy_payment_row", l7) > l7);
});

Deno.test("migration: new functions and paidy_mode() are service_role only", () => {
  const sql = code(MIG);
  for (const sig of ["staff_end_paidy_checkout_window(uuid,uuid,text,jsonb)", "end_paidy_submission_provider_ended_atomic(uuid,uuid,text,text,text,uuid,timestamptz,jsonb,jsonb)", "paidy_mode()"]) {
    assertStringIncludes(sql, `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
    assertStringIncludes(sql, `GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
  }
  assertStringIncludes(sql, "IF NOT public.has_permission(p_user_id, 'confirm_payment') THEN");
  assertStringIncludes(sql, "IF v_att.expires_at > now() THEN");
});
