/**
 * Paidy reassessment PA12 / PA13 (owner brief 2026-10-08).
 *   PA12: a successful HTTP answer from Paidy is a usable FINANCIAL object only
 *         when it carries the requested payment id, whole-yen amount, JPY,
 *         a boolean test flag and well-formed capture/refund arrays. Anything
 *         else is paidy_bad_response — an "unknown" the callers keep and
 *         re-read, never a verified uncaptured state.
 *   PA13: staff Reject on a Paidy submission refuses explicitly when the
 *         read-back is unknown; it never falls through to the ordinary reject.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PaidyError, paidy } from "../supabase/functions/_shared/paidy.ts";
import { validatePaidyPaymentObject } from "../supabase/functions/_shared/paidy-rules.ts";

const good = {
  id: "pay_abcdef12345", status: "AUTHORIZED", amount: 12000, currency: "JPY", test: true,
  created_at: "2026-10-08T00:00:00Z", expires_at: "2026-11-07T00:00:00Z", order: { order_ref: "CJ-W-000123" },
  captures: [], refunds: [],
};

Deno.test("PA12: a complete payment object passes and keeps its fields", () => {
  const r = validatePaidyPaymentObject(good, "pay_abcdef12345");
  assert(r.ok, JSON.stringify(r));
  assertEquals(r.payment.id, "pay_abcdef12345");
  assertEquals(r.payment.status, "AUTHORIZED");
});

Deno.test("PA12: status is normalised (lower case from a lax source still passes)", () => {
  const r = validatePaidyPaymentObject({ ...good, status: "authorized" }, "pay_abcdef12345");
  assert(r.ok);
  assertEquals(r.payment.status, "AUTHORIZED");
});

Deno.test("PA12: the adverse case — HTTP 200 { status: CLOSED } with nothing else is NOT a payment", () => {
  const r = validatePaidyPaymentObject({ status: "CLOSED" }, "pay_abcdef12345");
  assert(!r.ok);
  assertEquals(r.reason, "missing_id");
});

Deno.test("PA12: a payment answered for a DIFFERENT id than requested is refused", () => {
  const r = validatePaidyPaymentObject({ ...good, id: "pay_other0000000" }, "pay_abcdef12345");
  assert(!r.ok);
  assertEquals(r.reason, "id_mismatch");
});

Deno.test("PA12: wrong currency, non-yen amount, non-boolean test flag, empty status are refused", () => {
  assertEquals((validatePaidyPaymentObject({ ...good, currency: "USD" }, good.id) as { reason: string }).reason, "currency");
  assertEquals((validatePaidyPaymentObject({ ...good, amount: 120.5 }, good.id) as { reason: string }).reason, "amount");
  assertEquals((validatePaidyPaymentObject({ ...good, amount: "12000" }, good.id) as { ok: boolean }).ok, true, "a numeric string of whole yen is accepted");
  assertEquals((validatePaidyPaymentObject({ ...good, test: "true" }, good.id) as { reason: string }).reason, "test_flag");
  assertEquals((validatePaidyPaymentObject({ ...good, status: "" }, good.id) as { reason: string }).reason, "status");
});

Deno.test("PA12: an unknown FUTURE status is not refused by the validator — the outcome classifier answers unknown", () => {
  const r = validatePaidyPaymentObject({ ...good, status: "PENDING_REVIEW" }, good.id);
  assert(r.ok);
  assertEquals(r.payment.status, "PENDING_REVIEW");
});

Deno.test("PA12: CLOSED without a captures array is INCOMPLETE — it must never read as uncaptured", () => {
  const { captures: _c, ...noCaptures } = good;
  const r = validatePaidyPaymentObject({ ...noCaptures, status: "CLOSED" }, good.id);
  assert(!r.ok);
  assertEquals(r.reason, "closed_without_captures");
  // AUTHORIZED may omit the arrays (nothing has happened yet): treated as empty.
  const a = validatePaidyPaymentObject({ ...noCaptures, status: "AUTHORIZED" }, good.id);
  assert(a.ok);
  assertEquals(a.payment.captures, []);
});

Deno.test("PA12: malformed capture / refund entries are refused, never silently dropped", () => {
  assertEquals((validatePaidyPaymentObject({ ...good, captures: [{ amount: 100 }] }, good.id) as { reason: string }).reason, "capture_shape");
  assertEquals((validatePaidyPaymentObject({ ...good, captures: [{ id: "cap_1", amount: 99.9 }] }, good.id) as { reason: string }).reason, "capture_shape");
  assertEquals((validatePaidyPaymentObject({ ...good, captures: "none" }, good.id) as { reason: string }).reason, "captures_shape");
  assertEquals((validatePaidyPaymentObject({ ...good, refunds: [{ id: "ref_1" }] }, good.id) as { reason: string }).reason, "refund_shape");
  assertEquals((validatePaidyPaymentObject({ ...good, refunds: [{ id: 7, amount: 100 }] }, good.id) as { reason: string }).reason, "refund_shape");
});

Deno.test("PA12: a refund naming a capture the payment does not have is refused", () => {
  const r = validatePaidyPaymentObject({
    ...good, status: "CLOSED",
    captures: [{ id: "cap_1", amount: 12000, created_at: "2026-10-08T01:00:00Z" }],
    refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-08T02:00:00Z", capture_id: "cap_999" }],
  }, good.id);
  assert(!r.ok);
  assertEquals(r.reason, "refund_capture_link");
  const ok = validatePaidyPaymentObject({
    ...good, status: "CLOSED",
    captures: [{ id: "cap_1", amount: 12000, created_at: "2026-10-08T01:00:00Z" }],
    refunds: [{ id: "ref_1", amount: 2000, created_at: "2026-10-08T02:00:00Z", capture_id: "cap_1" }],
  }, good.id);
  assert(ok.ok);
});

// ---------------------------------------------------------------------------
// The client itself: a 200 that fails validation is a PaidyError the callers
// already treat as "unknown — keep and re-read" (never a verified state).
// ---------------------------------------------------------------------------
function withFetch(body: string, status = 200, fn: () => Promise<void>) {
  return async () => {
    const real = globalThis.fetch;
    Deno.env.set("PAIDY_SECRET_KEY", "sk_test_unit");
    globalThis.fetch = (() => Promise.resolve(new Response(body, { status, headers: { "Content-Type": "application/json" } }))) as typeof fetch;
    try { await fn(); } finally { globalThis.fetch = real; }
  };
}

Deno.test("PA12 client: HTTP 200 {status:CLOSED} → paidy_bad_response (502), not a payment", withFetch('{"status":"CLOSED"}', 200, async () => {
  const e = await assertRejects(() => paidy.get("pay_abcdef12345"), PaidyError);
  assertEquals((e as PaidyError).code, "paidy_bad_response");
  assertEquals((e as PaidyError).status, 502);
}));

Deno.test("PA12 client: invalid JSON on a 200 → paidy_bad_response", withFetch("<html>oops</html>", 200, async () => {
  const e = await assertRejects(() => paidy.get("pay_abcdef12345"), PaidyError);
  assertEquals((e as PaidyError).code, "paidy_bad_response");
}));

Deno.test("PA12 client: a 200 for another payment id → paidy_bad_response (id_mismatch)", withFetch(JSON.stringify({ ...good, id: "pay_someoneelse1" }), 200, async () => {
  const e = await assertRejects(() => paidy.get("pay_abcdef12345"), PaidyError);
  assert((e as PaidyError).message.includes("id_mismatch"));
}));

Deno.test("PA12 client: a complete 200 is returned normalised", withFetch(JSON.stringify({ ...good, status: "authorized" }), 200, async () => {
  const p = await paidy.get("pay_abcdef12345");
  assertEquals(p.status, "AUTHORIZED");
  assertEquals(p.amount, 12000);
}));

Deno.test("PA12 client: a 4xx is still the provider's own error, never paidy_bad_response", withFetch('{"code":"payment.not_found","description":"no"}', 404, async () => {
  const e = await assertRejects(() => paidy.get("pay_abcdef12345"), PaidyError);
  assertEquals((e as PaidyError).status, 404);
  assertEquals((e as PaidyError).code, "payment.not_found");
}));

// ---------------------------------------------------------------------------
// PA13: the Reject branch in review-payment-submission refuses an unknown
// outcome explicitly (source wiring; the function needs a live DB to run).
// ---------------------------------------------------------------------------
Deno.test("PA13: Reject refuses an unknown Paidy read-back instead of falling through", async () => {
  const src = await Deno.readTextFile(new URL("../supabase/functions/review-payment-submission/index.ts", import.meta.url));
  const rejectBranch = src.slice(src.indexOf("paidy.get before reject failed"), src.indexOf("// SQUARE: Reject voids the hold"));
  assert(rejectBranch.length > 200, "reject branch not found");
  assert(rejectBranch.includes('error: "paidy_unverified"'), "the unverified refusal is in the reject branch");
  assert(/else\s*\{[^}]*paidy_unknown_outcome/s.test(rejectBranch) || rejectBranch.includes("paidy_unknown_outcome"), "an explicit unknown-outcome refusal exists");
  // The ordinary reject must be unreachable for an unknown outcome: the branch
  // ends in a return for every outcome that is not authorized/expired/closed/rejected.
  assert(rejectBranch.includes("outcome === \"captured\"") && rejectBranch.includes("outcome === \"authorized\" || outcome === \"expired\"") && rejectBranch.includes("outcome === \"closed\" || outcome === \"rejected\""));
});
