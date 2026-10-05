/**
 * Task H9 (2026-10-06): the Paidy Checkout payload and the webhook aligned with
 * Paidy's own docs (paidy.com/docs/en/paidycheckout.html, webhook.html).
 * Pure helpers in _shared/paidy-rules.ts, plus source checks that the edge
 * functions wire them in.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAIDY_WEBHOOK_IPS, isPaidyWebhookIp, paidyBillingAddress, paidyBuyerHistory, paidyCaptureDeadlineText,
  paidyCheckoutPayload, paidyCustomerRecordAddress, paidyDob, paidyHistoryFromLayaway, paidyPointsBeforeOrder,
  paidyWebhookIpCheckOn,
} from "../supabase/functions/_shared/paidy-rules.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
/** Source with comment lines stripped, so an assertion tests code, not prose (CLAUDE.md). */
const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const jpComplete = { line1: "1-2-3 Tateishi", line2: "Room 101", city: "Katsushika-ku", region: "Tokyo", postal_code: "1240012", country: "JP" };
const jpNoRegion = { line1: "1-2-3 Tateishi", line2: null, city: "Katsushika-ku", region: null, postal_code: "1240012", country: "JP" };

// ── P2-2 billing_address ────────────────────────────────────────────────────
Deno.test("billing: default complete → the default entry", () => {
  const r = paidyBillingAddress(jpComplete, { ...jpComplete, line1: "other" });
  assertEquals(r.source, "address_book");
  assertEquals(r.address?.line2, "1-2-3 Tateishi");
  assertEquals(r.address?.zip, "124-0012");
});
Deno.test("billing: default incomplete + customer record complete → customer record", () => {
  const r = paidyBillingAddress(jpNoRegion, { ...jpComplete, line1: "9-9 Customer St" });
  assertEquals(r.source, "customer_record");
  assertEquals(r.address?.line2, "9-9 Customer St");
});
Deno.test("billing: both incomplete → undefined with a non-PII reason code", () => {
  const r = paidyBillingAddress(jpNoRegion, jpNoRegion);
  assertEquals(r.address, undefined);
  assertEquals(r.source, null);
  assertEquals(r.reason, "no_complete_jp_billing_address");
  assertEquals(paidyBillingAddress(null, null).address, undefined);
});
Deno.test("billing: customers columns map to the address shape (no region column exists)", () => {
  const a = paidyCustomerRecordAddress({ address_line1: "1-2-3", city: "Katsushika-ku", postal_code: "1240012", country: "JP" });
  assertEquals(a, { line1: "1-2-3", line2: null, city: "Katsushika-ku", region: null, postal_code: "1240012", country: "JP" });
  assertEquals(paidyCustomerRecordAddress(null), null);
});

// ── P2-3 history includes completed yen layaway ──────────────────────────────
Deno.test("history: a completed JPY layaway counts; a forfeited one does not", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  const layaway = paidyHistoryFromLayaway([
    { status: "completed", currency: "JPY", total_amount: 300000, completed_at: "2026-10-01T00:00:00Z", order_date: "2026-04-01" },
    { status: "forfeited", currency: "JPY", total_amount: 999999, completed_at: null, order_date: "2026-05-01" },
    { status: "completed", currency: "PHP", total_amount: 50000, completed_at: "2026-10-02T00:00:00Z", order_date: "2026-04-01" },
  ]);
  const cash = [{ status: "completed", currency: "JPY", total_amount: 20000, completed_at: "2026-09-01T00:00:00Z", order_date: "2026-09-01" }];
  const h = paidyBuyerHistory([...cash, ...layaway], now);
  assertEquals(h.order_count, 2);
  assertEquals(h.ltv, 320000);
  assertEquals(h.last_order_amount, 300000);
  assertEquals(h.last_order_at, 5);
});
Deno.test("history: a layaway row is never marked Paidy-paid or refunded", () => {
  const [r] = paidyHistoryFromLayaway([{ status: "completed", currency: "JPY", total_amount: 1000, completed_at: "2026-10-01T00:00:00Z" }]);
  assertEquals(r.paid_by_paidy, false);
  assertEquals(r.refunded, false);
});

// ── P2-4 buyer.dob ───────────────────────────────────────────────────────────
Deno.test("dob: YYYY-MM-DD passes; null / garbage / impossible dates omitted", () => {
  assertEquals(paidyDob("1990-02-03"), "1990-02-03");
  assertEquals(paidyDob(null), undefined);
  assertEquals(paidyDob(undefined), undefined);
  assertEquals(paidyDob("garbage"), undefined);
  assertEquals(paidyDob("1990-02-30"), undefined);
  assertEquals(paidyDob("03/02/1990"), undefined);
});

// ── P2-5 number_of_points ───────────────────────────────────────────────────
Deno.test("points: member 120 → 120; no member → omitted", () => {
  assertEquals(paidyPointsBeforeOrder({ remaining_points: 120 }, 0), 120);
  assertEquals(paidyPointsBeforeOrder(null, 0), undefined);
  assertEquals(paidyPointsBeforeOrder(undefined, 0), undefined);
});
Deno.test("points: those spent on THIS order (deducted at Confirm) are added back — 'prior to this order'", () => {
  assertEquals(paidyPointsBeforeOrder({ remaining_points: 120 }, 30), 150);
  assertEquals(paidyPointsBeforeOrder({ remaining_points: -5 }, 0), 0);
  assertEquals(paidyPointsBeforeOrder({ remaining_points: "120.9" }, 0), 120);
});

// ── P2-6 webhook source IP ──────────────────────────────────────────────────
Deno.test("webhook IP: each of Paidy's 5 published IPs passes", () => {
  assertEquals(PAIDY_WEBHOOK_IPS.length, 5);
  for (const ip of ["13.114.134.35", "13.113.94.100", "18.182.135.232", "52.199.50.20", "52.199.62.26"]) {
    assert(isPaidyWebhookIp(ip), ip);
  }
});
Deno.test("webhook IP: others, empty and null are refused; first x-forwarded-for entry decides", () => {
  assertEquals(isPaidyWebhookIp("1.2.3.4"), false);
  assertEquals(isPaidyWebhookIp(""), false);
  assertEquals(isPaidyWebhookIp(null), false);
  assertEquals(isPaidyWebhookIp("13.114.134.35, 10.0.0.1"), true);
  assertEquals(isPaidyWebhookIp("10.0.0.1, 13.114.134.35"), false);
});
Deno.test("webhook IP check: only the exact 'off' disables it", () => {
  assertEquals(paidyWebhookIpCheckOn("off"), false);
  assertEquals(paidyWebhookIpCheckOn(undefined), true);
  assertEquals(paidyWebhookIpCheckOn("on"), true);
  assertEquals(paidyWebhookIpCheckOn("OFF "), true);
});

// ── P3-1 / P3-2 payload ─────────────────────────────────────────────────────
const payloadArgs = {
  amount: 50800, orderRef: "CJ-W-000123", cashOrderId: "co-1", customerId: "cu-1", userId: "CJ-2026-00008",
  email: "a@example.com", name1: "Largo Cynthia", phone: "09012345678", dob: "1990-02-03",
  history: { order_count: 1, ltv: 20000, last_order_amount: 20000, last_order_at: 3 },
  registered: "2026-01-01", billing: undefined, numberOfPoints: 120,
  items: [{ id: "SKU1", quantity: 1, title: "Ring", unit_price: 50000 }], shipping: 800,
  shippingAddress: { line1: "Room 1", line2: "1-2-3", city: "Katsushika-ku", state: "Tokyo", zip: "124-0012" },
};
Deno.test("payload: order has no tax key; metadata has the three keys", () => {
  const p = paidyCheckoutPayload(payloadArgs);
  assertEquals("tax" in p.order, false);
  assertEquals(p.metadata, { cash_order_id: "co-1", customer_id: "cu-1", source: "web" });
  assertEquals(p.buyer.dob, "1990-02-03");
  assertEquals(p.buyer_data.number_of_points, 120);
  assertEquals(p.amount, 50800);
  assertEquals(p.currency, "JPY");
});
Deno.test("payload: missing dob / points / billing stay absent (undefined)", () => {
  const p = paidyCheckoutPayload({ ...payloadArgs, dob: undefined, numberOfPoints: undefined });
  assertEquals(p.buyer.dob, undefined);
  assertEquals(p.buyer_data.number_of_points, undefined);
  assertEquals(p.buyer_data.billing_address, undefined);
  assertEquals(JSON.parse(JSON.stringify(p)).buyer.dob, undefined);
});

// ── P3-5 bell text ──────────────────────────────────────────────────────────
Deno.test("bell: Paidy's expires_at date in JST; 30 days only as fallback", () => {
  assertEquals(paidyCaptureDeadlineText("2026-11-05T16:30:00Z"), "capture by 2026-11-06 JST");
  assertEquals(paidyCaptureDeadlineText(null), "valid 30 days");
  assertEquals(paidyCaptureDeadlineText("nope"), "valid 30 days");
});

// ── wiring (source, comments stripped) ─────────────────────────────────────
Deno.test("wiring: website builds the payload with the helpers and never sends tax: 0", () => {
  const w = code("supabase/functions/website/index.ts");
  assert(/paidyCheckoutPayload\(\{/.test(w));
  assertEquals(/tax:\s*0/.test(w), false);
  assert(/\.from\("layaway_accounts"\)[\s\S]{0,200}\.eq\("status", "completed"\)/.test(w));
  assert(/paidyBillingAddress\(/.test(w));
  assert(/paidyPointsBeforeOrder\(/.test(w));
  assert(/paidyDob\(/.test(w));
});
Deno.test("wiring: webhook checks the source IP before any write", () => {
  const w = code("supabase/functions/paidy-webhook/index.ts");
  const gate = w.indexOf("isPaidyWebhookIp(");
  const insert = w.indexOf('.from("paidy_webhook_events")');
  assert(gate > 0 && insert > gate);
  assert(/Deno\.env\.get\("PAIDY_WEBHOOK_IP_CHECK"\)/.test(w));
  assert(/ignored:\s*true/.test(w));
});
Deno.test("wiring: the authorised bell uses Paidy's expires_at", () => {
  const f = code("supabase/functions/_shared/paidy-filing.ts");
  assert(/paidyCaptureDeadlineText\(payment\.expires_at\)/.test(f));
  assertEquals(/valid 30 days/.test(f), false);
});
