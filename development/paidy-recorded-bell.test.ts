/**
 * Paidy reassessment F2 (owner 2026-10-10, option A): the "Paidy payment
 * recorded" bell is built in one place, and the hourly sweep rings it late
 * when the first ring never happened. Pure rules + wiring on comment-stripped
 * code.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAIDY_RECORDED_BELL_GRACE_MINUTES, PAIDY_RECORDED_BELL_SINCE, PAIDY_RECORDED_BELL_TYPE,
  paidyRecordedBell, paidyRecordedBellSince, paidyRecordedBellUntil,
} from "../supabase/functions/_shared/paidy-recorded-bell.ts";

const root = new URL("../", import.meta.url);
const code = (p: string) => Deno.readTextFileSync(new URL(p, root)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");

Deno.test("bell text: completed order, automatic", () => {
  const b = paidyRecordedBell({ reference: "CJ-W-000123", amountJpy: 50000, senderName: "Test Customer", automatic: true, fullyPaid: true, remainingJpy: 0 });
  assertEquals(b.type, PAIDY_RECORDED_BELL_TYPE);
  assertEquals(b.title, "Paidy payment recorded — order completed, ready to ship");
  assertEquals(b.body, "CJ-W-000123 · ¥50,000 · Test Customer · recorded automatically after the capture in the Paidy dashboard · the order is completed and ready to ship");
});

Deno.test("bell text: part paid by a staff Confirm, rung late", () => {
  const b = paidyRecordedBell({ reference: "20123", amountJpy: 1000.4, senderName: null, automatic: false, fullyPaid: false, remainingJpy: 2500, late: true });
  assertEquals(b.title, "Paidy payment recorded");
  assertEquals(b.body, "20123 · ¥1,000 ·  · recorded by a staff Confirm · ¥2,500 still due · this bell was sent late by the hourly Paidy check");
});

Deno.test("window: never before the feature shipped, never inside the grace period", () => {
  const ship = Date.parse(PAIDY_RECORDED_BELL_SINCE);
  assertEquals(paidyRecordedBellSince(ship + 3_600_000), PAIDY_RECORDED_BELL_SINCE.replace("Z", ".000Z"));
  const later = ship + 30 * 86_400_000;
  assertEquals(paidyRecordedBellSince(later), new Date(later - 7 * 86_400_000).toISOString());
  assertEquals(paidyRecordedBellUntil(later), new Date(later - PAIDY_RECORDED_BELL_GRACE_MINUTES * 60_000).toISOString());
});

Deno.test("wiring: the recording path uses the shared builder", () => {
  const rps = code("supabase/functions/review-payment-submission/index.ts");
  assert(rps.includes("const bell = paidyRecordedBell({"));
  assert(rps.includes("await paidyBell(supabase, bell.type, bell.title, bell.body,"));
  assert(!rps.includes('"Paidy payment recorded — order completed, ready to ship"'), "no second copy of the wording");
});

Deno.test("wiring: the sweep checks for the bell before ringing, once per cash payment", () => {
  const rec = code("supabase/functions/paidy-reconcile/index.ts");
  const check = rec.indexOf('.eq("type", PAIDY_RECORDED_BELL_TYPE).contains("metadata", { cash_payment_id: pay.id })');
  const ring = rec.indexOf("report.recorded_bells_late++;");
  assert(check > 0 && ring > check, `check=${check} ring=${ring}`);
  assert(rec.includes("at > Date.parse(until)"), "grace period honoured");
  assert(rec.includes("const automatic = sub.reviewer_user_id == null;"));
  assert(rec.includes("late: true,"));
});
