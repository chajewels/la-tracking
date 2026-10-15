/**
 * Square operations panel — environment-true counters, card mark = refund
 * decision, truthful "Refund emails" panel on card orders (owner go 2026-10-15
 * on the QA rev. 2 dispositions A–C, claude/qa-brief-live-production-2026-10-11.md §7).
 *
 *   A  square-webhook tags every inbox row with the environment whose
 *      signature key verified it; square-reconcile tags what it enqueues with
 *      the environment it read; square_ops_health() counts the live
 *      environment only and reports the other one apart (SQL acceptance:
 *      development/sql/square-ops-environment-acceptance.sql, 13/13).
 *   B  mark_web_order_refund_issued_atomic (card) writes
 *      decision = 'order_cancelled_refunded' on the undecided COMPLETED refunds.
 *   C  resend-order-email lists the Square 「返金を受け付けました」 rows
 *      (never resendable from the panel — B02 re-sends them) and flags the
 *      card 「返金が完了しました」 row as skipped by design.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hmacSha256Base64, verifySquareSignature, verifySquareSignatureEnvironment } from "../supabase/functions/_shared/square.ts";
import { resendRefusal, type ResendableEmail } from "../supabase/functions/_shared/order-email-resend.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
const url = "https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/square-webhook";
const body = '{"event_id":"e1","type":"payment.updated"}';

Deno.test("A: the verifying key names the environment; unknown or missing → null (never a guess)", async () => {
  Deno.env.set("SQUARE_WEBHOOK_SIGNATURE_KEY", "sandbox-key-0123456789");
  Deno.env.set("SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY", "production-key-0123456789");
  assertEquals(await verifySquareSignatureEnvironment(url, body, await hmacSha256Base64("production-key-0123456789", url + body)), "production");
  assertEquals(await verifySquareSignatureEnvironment(url, body, await hmacSha256Base64("sandbox-key-0123456789", url + body)), "sandbox");
  assertEquals(await verifySquareSignatureEnvironment(url, body, await hmacSha256Base64("other", url + body)), null);
  assertEquals(await verifySquareSignatureEnvironment(url, body, null), null);
  // same acceptance as the boolean check — the two can never disagree
  assertEquals(await verifySquareSignature(url, body, await hmacSha256Base64("sandbox-key-0123456789", url + body)), true);
  Deno.env.delete("SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY");
  assertEquals(await verifySquareSignatureEnvironment(url, body, await hmacSha256Base64("production-key-0123456789", url + body)), null);
  Deno.env.delete("SQUARE_WEBHOOK_SIGNATURE_KEY");
  assertEquals(await verifySquareSignatureEnvironment(url, body, await hmacSha256Base64("sandbox-key-0123456789", url + body)), null);
});

Deno.test("A: the webhook stores the environment with the receipt and still answers 403 on a bad signature", async () => {
  const src = await read("../supabase/functions/square-webhook/index.ts");
  assertStringIncludes(src, "verifySquareSignatureEnvironment(NOTIFICATION_URL, raw,");
  assertStringIncludes(src, 'if (!environment) return jsonResponse({ error: "bad_signature" }, 403);');
  assertStringIncludes(src, "object_id: id, payload: body, environment }");
  assert(!src.includes("verifySquareSignature(NOTIFICATION_URL"), "the boolean check must not run a second time");
});

Deno.test("A: square-reconcile tags what it enqueues with the environment it read", async () => {
  const src = await read("../supabase/functions/square-reconcile/index.ts");
  assertStringIncludes(src, "source: string, environment: SquareEnvironment | null): Promise<boolean>");
  assertStringIncludes(src, 'outcome: source, environment }');
  assertStringIncludes(src, '"events_api", env))');
  assertStringIncludes(src, '"refund_discovery", dEnv))');
  assertStringIncludes(src, '"dispute_discovery", dEnv))');
});

Deno.test("A+B: the migration counts one environment at a time and the card mark decides the refunds", async () => {
  const sql = await read("../supabase/migrations/20261212100000_square_ops_environment_and_refund_decision.sql");
  assertStringIncludes(sql, "ADD COLUMN IF NOT EXISTS environment text");
  assertStringIncludes(sql, "CHECK (environment IS NULL OR environment IN ('sandbox', 'production'))");
  assertStringIncludes(sql, "WHEN 'test' THEN 'sandbox' ELSE 'production' END");
  assertStringIncludes(sql, "'other_environment',   public.square_ops_counts(v_other, false)");
  assertStringIncludes(sql, "92fb88df6f0e3286cd426870bfa346c0"); // live md5 of square_ops_health before
  assertStringIncludes(sql, "0637d241d65fa7c04312b147d1c9601b"); // live md5 of mark_web_order_refund_issued_atomic before
  assertStringIncludes(sql, "SET decision = 'order_cancelled_refunded', decided_at = now(), decided_by = p_user_id,");
  assertStringIncludes(sql, "WHERE cash_order_id = p_order_id AND status = 'COMPLETED' AND decision IS NULL;");
  // the counts helper is not for signed-in users; the environment reading is
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION public.square_ops_counts(text, boolean) FROM PUBLIC, anon, authenticated;");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.square_live_environment() TO authenticated, service_role;");
});

Deno.test("C: Square refund rows are listed but never resendable from the panel; the card mark row is 'skipped by design'", async () => {
  const src = await read("../supabase/functions/resend-order-email/index.ts");
  assertStringIncludes(src, 'kind: "refund_received_square", key: squareRefundReceivedKey(String(r.square_refund_id))');
  assertStringIncludes(src, "resendable: false");
  assertStringIncludes(src, 'cardMark.not_sent_reason = "card_refund_email_sent_by_square"');
  // only COMPLETED refunds — a PENDING / FAILED refund sent no email
  assertStringIncludes(src, '.eq("cash_order_id", orderId).eq("status", "COMPLETED")');
  // the send path only knows the two resendable kinds — a Square row can never reach it
  const squareRow: ResendableEmail = { kind: "refund_received_square", key: "refund-received-square-x", amount: 1000, resendable: false, last_status: "sent", last_at: "2026-10-11T04:39:40Z", resends_used: 0 };
  assertEquals(resendRefusal({ reason: "customer says she did not get it", item: squareRow }), "not_resendable");
  const paidyRow: ResendableEmail = { kind: "refund_received_paidy", key: "refund-received-paidy-x", amount: 1000, last_status: "failed", last_at: null, resends_used: 0 };
  assertEquals(resendRefusal({ reason: "customer says she did not get it", item: paidyRow }), null);
});
