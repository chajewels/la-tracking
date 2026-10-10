/**
 * Paidy second-hold fix (owner go 2026-10-10 15:02 JST).
 *
 * Paidy approved a payment the Hub could not file; pressing Paidy again
 * replaced her window and Paidy could take a second hold. The database
 * behaviour (window kept, second start refused, verified-empty reopens,
 * filing ends the window, note guards, grants) was proved on a scratch replay
 * whose Paidy bodies are byte-identical to live; these tests pin the pure rule
 * and keep the wiring and the migration honest in CI. Wiring greps run on
 * comment-stripped code.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { paidyAuthorizationNote } from "../supabase/functions/_shared/paidy-rules.ts";

const root = new URL("../", import.meta.url);
const raw = (p: string) => Deno.readTextFileSync(new URL(p, root));
const code = (p: string) => raw(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");
const MIG = "supabase/migrations/20261204100000_paidy_second_hold.sql";
const WEB = "supabase/functions/website/index.ts";
const SWEEP = "supabase/functions/paidy-reconcile/index.ts";

Deno.test("only an approval Paidy confirms for THIS order (or Paidy unreachable) is noted", () => {
  const order = { id: "o-1", ref: "CJ-W-900074" };
  assertEquals(paidyAuthorizationNote({ payment: { status: "AUTHORIZED", order: { order_ref: "CJ-W-900074" } } }, order), true);
  assertEquals(paidyAuthorizationNote({ payment: { status: "authorized", metadata: { cash_order_id: "o-1" } } }, order), true);
  assertEquals(paidyAuthorizationNote({ error: true }, order), true);
  assertEquals(paidyAuthorizationNote({ notFound: true }, order), false);
  assertEquals(paidyAuthorizationNote({ payment: { status: "AUTHORIZED", order: { order_ref: "CJ-W-900001" } } }, order), false);
  for (const st of ["CLOSED", "REJECTED", "", null]) {
    assertEquals(paidyAuthorizationNote({ payment: { status: st, order: { order_ref: "CJ-W-900074" } } }, order), false, String(st));
  }
});

Deno.test("website: the approval is noted BEFORE any refusal and before filing", () => {
  const c = code(WEB);
  const start = c.indexOf('segments[2] === "paidy" && !segments[3]');
  assert(start > 0, "filing endpoint found");
  const body = c.slice(start, start + 9000);
  const note = body.indexOf('rpc("note_paidy_window_authorization"');
  const lock = body.indexOf("await paymentLock(supabase");
  const offer = body.indexOf("await paidyOffer(");
  const file = body.indexOf("await filePaidyAuthorization(");
  assert(note > 0 && lock > note && offer > note && file > note, `order: note=${note} lock=${lock} offer=${offer} file=${file}`);
  assert(/if \(paidyAuthorizationNote\(authRead,/.test(body), "noted only through the pure rule");
  assert(body.includes("p_test: paidySecretIsTest()"), "the key family is recorded");
  assert(body.includes('authRead && "payment" in authRead ? authRead.payment'), "one Paidy read reused");
});

Deno.test("sweep: a window whose Paidy record ended is verified empty", () => {
  const c = code(SWEEP);
  assert(/\["closed", "rejected", "expired"\]\.includes\(String\(\(row as Record<string, any>\)\.status\)\)/.test(c));
  assert(!/if \(row\) continue;/.test(c), "the old unconditional skip is gone");
  assert(c.includes("if (w.authorization_noted_at && w.authorization_test === secretTest)"), "same-family 404 verifies a noted approval");
  assert(c.includes('type: "paidy_window_stuck"'), "one staff bell for a stuck noted window");
});

Deno.test("migration: md5-guarded patch, new writer service_role only, no replace of a noted approval", () => {
  const m = raw(MIG);
  assert(m.includes("pg_temp.cj_patch('public.start_paidy_checkout_attempt(uuid,uuid,integer)', '0ab389929a0e53cf8a2980a9dc2b4935'"));
  assert(m.includes("AND NOT (authorization_noted_at IS NOT NULL AND verified_empty_at IS NULL);"));
  assert(m.includes("ADD COLUMN IF NOT EXISTS authorization_noted_at timestamptz"));
  assert(m.includes("ADD COLUMN IF NOT EXISTS authorization_test boolean"));
  assert(/WHERE id = p_cash_order_id AND customer_id = p_customer_id FOR UPDATE;/.test(m), "the note takes the order lock");
  assert(m.includes("'approval_held'"), "a late approval opens a holding window");
  assert(m.includes("REVOKE ALL ON FUNCTION public.note_paidy_window_authorization(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;"));
  assert(m.includes("GRANT EXECUTE ON FUNCTION public.note_paidy_window_authorization(uuid, uuid, text, boolean) TO service_role;"));
  assert(m.includes("REVOKE ALL ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;"));
});
