/**
 * Paidy reassessment PR 5 — truthfulness (PA08 / PA11 / PA15), owner go
 * 2026-10-09 ("proceed to all recommended"). Plan:
 * claude/paidy-pr5-truthfulness-plan-2026-10-09.md.
 *
 *   PA08  mark-refund-issued proves the Paidy refund emails it claims were
 *         sent (key per refund id) and names the provider; an ADMIN may resend
 *         a refund email by hand — written reason, max 3, never while the
 *         address is suppressed, audit row first. Nothing re-sends by itself.
 *   PA11  the buyer history pages by primary key (keyset) and reads ids in
 *         chunks; "refunded" = a Paidy refund OR a Square refund that did not fail.
 *   PA15  she chooses where Paidy bills her among her complete Japanese
 *         address-book entries (default preselected); an id that is not one of
 *         them is refused; the window records the choice.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { paidyBillingChoice, paidyRefundReceivedKey } from "../supabase/functions/_shared/paidy-rules.ts";
import {
  latestByOriginalKey, MAX_MANUAL_RESENDS, MIN_RESEND_REASON, originalKeyOf, resendKey, resendRefusal,
  type ResendableEmail,
} from "../supabase/functions/_shared/order-email-resend.ts";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));

const JP = (id: string, is_default: boolean, extra: Record<string, unknown> = {}) => ({
  id, is_default, line1: "1-2-3 Tateishi", line2: null, city: "Katsushika-ku", region: "Tokyo",
  postal_code: "124-0012", country: "JP", ...extra,
});

Deno.test("PA15: billing choices are her complete JP entries, default first; the default is preselected", () => {
  const r = paidyBillingChoice([
    JP("a", false),
    JP("b", true),
    JP("ph", false, { country: "PH" }),
    JP("half", false, { postal_code: null }),
  ], null);
  assertEquals(r.choices.map((c) => c.id), ["b", "a"]);
  assertEquals(r.id, "b");
  assertEquals(r.source, "address_book");
  assert(r.address, "an address is built");
  assertEquals(r.reason, undefined);
});

Deno.test("PA15: her choice is used; an id that is not one of her complete JP entries is refused", () => {
  const entries = [JP("a", true), JP("b", false), JP("ph", false, { country: "PH" })];
  assertEquals(paidyBillingChoice(entries, null, "b").id, "b");
  const bad = paidyBillingChoice(entries, null, "ph");
  assertEquals(bad.reason, "billing_address_invalid");
  assertEquals(bad.address, undefined);
  assertEquals(paidyBillingChoice(entries, null, "someone-else").reason, "billing_address_invalid");
});

Deno.test("PA15: no address-book entry falls back to the customer record, then to the not-found reason", () => {
  const rec = { line1: "1-2-3", city: "Chiyoda-ku", region: "Tokyo", postal_code: "100-0001", country: "JP" };
  const r = paidyBillingChoice([], rec);
  assertEquals(r.source, "customer_record");
  assertEquals(r.id, null);
  assertEquals(paidyBillingChoice([], null).reason, "no_complete_jp_billing_address");
  assertEquals(paidyBillingChoice(null, null).choices, []);
});

Deno.test("PA08: the Paidy refund-received key is one helper, used by the sender and by both readers", async () => {
  assertEquals(paidyRefundReceivedKey("rf_123"), "refund-received-paidy-rf_123");
  const sync = await read("../supabase/functions/_shared/paidy-sync.ts");
  assertStringIncludes(sync, "idempotencyKey: paidyRefundReceivedKey(");
  assertEquals((sync.match(/`refund-received-paidy-\$\{/g) ?? []).length, 0, "no inline key left in the sender");
  const mark = await read("../supabase/functions/mark-refund-issued/index.ts");
  assertStringIncludes(mark, "if (await refundIssuedEmailSent(supabase, paidyRefundReceivedKey(id))) proven++;");
  assertStringIncludes(mark, 'refund_emails: { sent: proven, total: ids.length }, provider: "paidy",');
  assertStringIncludes(mark, 'refund_emails: { sent: proven, total: ids.length }, provider: "card",');
  const resend = await read("../supabase/functions/resend-order-email/index.ts");
  assertStringIncludes(resend, "key: paidyRefundReceivedKey(String(r.refund_id))");
});

Deno.test("PA08: resend guards — reason, item, suppression, cap — in that order", () => {
  const item: ResendableEmail = { kind: "refund_issued", key: "refund-issued-x", amount: 1000, last_status: "failed", last_at: null, resends_used: 0 };
  const ok = "Customer says it never arrived";
  assert(ok.length >= MIN_RESEND_REASON);
  assertEquals(resendRefusal({ reason: "short", item }), "reason_required");
  assertEquals(resendRefusal({ reason: "          ", item }), "reason_required");
  assertEquals(resendRefusal({ reason: 42, item }), "reason_required");
  assertEquals(resendRefusal({ reason: ok, item: null }), "not_resendable");
  assertEquals(resendRefusal({ reason: ok, item: { ...item, last_status: "suppressed", resends_used: 3 } }), "recipient_suppressed");
  assertEquals(resendRefusal({ reason: ok, item: { ...item, resends_used: MAX_MANUAL_RESENDS } }), "resend_cap_reached");
  assertEquals(resendRefusal({ reason: ok, item: { ...item, resends_used: MAX_MANUAL_RESENDS - 1 } }), null);
  assertEquals(MAX_MANUAL_RESENDS, 3);
});

Deno.test("PA08: resend keys are new per attempt and fold back to the original", () => {
  assertEquals(resendKey("refund-issued-x", 2), "refund-issued-x-resend-2");
  assertEquals(originalKeyOf("refund-issued-x-resend-2"), "refund-issued-x");
  assertEquals(originalKeyOf("refund-received-paidy-rf_9"), "refund-received-paidy-rf_9");
  const m = latestByOriginalKey([
    { key: "k-resend-1", status: "sent", created_at: "2026-10-09T02:00:00Z" },
    { key: "k", status: "failed", created_at: "2026-10-09T01:00:00Z" },
  ]);
  assertEquals(m.get("k"), { status: "sent", created_at: "2026-10-09T02:00:00Z" });
});

Deno.test("PA08: resend-order-email is admin-only, person-only, audits BEFORE it sends, never loops", async () => {
  const src = await read("../supabase/functions/resend-order-email/index.ts");
  assertStringIncludes(src, 'if (!ctx.user) return jsonResponse({ error: "Unauthorized" }, 401);');
  assertStringIncludes(src, 'return jsonResponse({ error: "admin_only" }, 403);');
  assertStringIncludes(src, 'if ((order as AnyRec).source_channel !== "web") return jsonResponse({ error: "not_web_order" }, 409);');
  const audit = src.indexOf('action: "order_email_resent"');
  const send = src.indexOf("await sendOrderUpdateEmail(");
  assert(audit > 0 && send > audit, "audit row inserted before the send");
  assertStringIncludes(src, "if (aErr) throw aErr;");
  assertEquals((src.match(/sendOrderUpdateEmail\(/g) ?? []).length, 1, "exactly one send per request");
  assertEquals((src.match(/\bwhile \(/g) ?? []).length, 0, "no retry loop");
  // The send sits in the request handler, outside every listing loop.
  assert(send > src.indexOf("Deno.serve("), "the send is in the handler, not in a helper loop");
  const cfg = await read("../supabase/config.toml");
  assert(/\[functions\.resend-order-email\]\s*\n\s*verify_jwt = true/.test(cfg), "verify_jwt = true for resend-order-email");
});

Deno.test("PA11: buyer history pages by primary key and reads ids in chunks; refunded = Paidy OR Square", async () => {
  const src = await read("../supabase/functions/website/index.ts");
  assertStringIncludes(src, 'if (after !== null) q = q.gt("id", after);');
  assertStringIncludes(src, 'await q.order("id", { ascending: true }).limit(PAGE);');
  assertStringIncludes(src, "const IN_CHUNK = 100;");
  assertStringIncludes(src, 'allRowsIn(pastIds, (chunk) => supabase.from("paidy_refunds")');
  assertStringIncludes(src, 'allRowsIn(pastIds, (chunk) => supabase.from("square_refunds").select("id, cash_order_id").in("cash_order_id", chunk).not("status", "in", "(FAILED,REJECTED)"))');
  assertStringIncludes(src, "const byRefund = new Set([...paidyRefunded, ...squareRefunded]");
  const start = src.indexOf("async function paidyOffer(");
  const end = src.indexOf("billing_choices: bill.choices", start);
  const body = src.slice(start, end);
  assertEquals((body.match(/\.range\(/g) ?? []).length, 0, "no offset paging left");
  assertEquals((body.match(/order\("completed_at"/g) ?? []).length, 0, "no non-unique sort left");
});

Deno.test("PA15: start validates the chosen id, answers 400 billing_address_invalid, records it on the window", async () => {
  const src = await read("../supabase/functions/website/index.ts");
  assertStringIncludes(src, 'if (startBody.billing_address_id != null && !wantedBilling) return jsonResponse({ error: "billing_address_invalid" }, 400);');
  assertStringIncludes(src, '.update({ billing_address_id: offer.billing_address_id ?? null }).eq("id", st.attempt_id);');
  assertStringIncludes(src, 'if (bill.reason === "billing_address_invalid") return { offered: false as const, reason: "billing_address_invalid"');
  const sql = await read("../supabase/migrations/20261130100000_paidy_pr5_billing_choice.sql");
  assertStringIncludes(sql, "ADD COLUMN IF NOT EXISTS billing_address_id uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL");
});
