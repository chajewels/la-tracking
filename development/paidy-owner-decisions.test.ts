// Owner decisions 2026-10-06 / 2026-10-08 (Paidy chat): name1 = family + given
// as entered (P05); a staff cancel closes an open Paidy authorisation first.
import { assertEquals } from "jsr:@std/assert@1";
import { paidyBuyerName, paidyCancelStep, paidyNameField, paidyNotOfferedReason, paidyRequirements, paidyRequirementsMet } from "../supabase/functions/_shared/paidy-rules.ts";
import { releasePaidyForCancel } from "../supabase/functions/_shared/paidy-cancel-release.ts";

Deno.test("P05 name1: family + given as entered, never guessed; either missing → empty", () => {
  assertEquals(paidyBuyerName("Santos", "Maria"), "Santos Maria");
  assertEquals(paidyBuyerName(" 山田 ", "太郎"), "山田 太郎");
  assertEquals(paidyBuyerName("Dela Cruz", "Maria"), "Dela Cruz Maria");
  assertEquals(paidyBuyerName("Santos", ""), "");
  assertEquals(paidyBuyerName(null, "Maria"), "");
});
Deno.test("P05 requirements: each field reported; Paidy refused while any is missing", () => {
  const full = paidyRequirements({ family_name: "Santos", given_name: "Maria", mobile_number: "090-1234-5678", billingAddressFound: true });
  assertEquals(full, { family_name: true, given_name: true, jp_mobile: true, jp_billing_address: true });
  assertEquals(paidyRequirementsMet(full), true);
  const noMobile = paidyRequirements({ family_name: "Santos", given_name: "Maria", mobile_number: "+63 917 000 1234", billingAddressFound: true });
  assertEquals(noMobile.jp_mobile, false);
  assertEquals(paidyRequirementsMet(noMobile), false);
  const base = {
    mode: "on" as const, publicKey: "pk_live_abcdefgh1234", customerIsTest: false,
    order: { currency: "JPY", status: "pending", payment_status: "pending_transfer", remaining_balance: 1000, source_channel: "web", ready_confirmed_at: "2026-10-08" },
    address: { line1: "1-1", city: "葛飾区", region: "東京都", postal_code: "124-0012", country: "JP" },
    pendingSubmissions: 0, totalPaid: 0, paymentLock: null, buyerName: "Santos Maria", breakdownOk: true, paymentMethod: "paidy",
  };
  assertEquals(paidyNotOfferedReason({ ...base, requirements: full }), null);
  assertEquals(paidyNotOfferedReason({ ...base, requirements: noMobile }), "no_jp_mobile");
  assertEquals(paidyNotOfferedReason({ ...base, requirements: { ...full, jp_billing_address: false } }), "no_jp_billing_address");
  assertEquals(paidyNotOfferedReason({ ...base, requirements: { ...full, given_name: false } }), "no_buyer_name");
  assertEquals(paidyNameField("  Maria  Clara "), "Maria Clara");
  assertEquals(paidyNameField("x".repeat(61)), null);
});
Deno.test("cancel step from Paidy's read-back", () => {
  assertEquals(paidyCancelStep("captured"), "refuse");
  assertEquals(paidyCancelStep("authorized"), "close");
  assertEquals(paidyCancelStep("expired"), "close");
  assertEquals(paidyCancelStep("closed"), "mark");
  assertEquals(paidyCancelStep("rejected"), "mark");
  assertEquals(paidyCancelStep("unknown"), "retry");
});

// --- releasePaidyForCancel with a recording fake ---------------------------
type Call = { table: string; op: string; values?: unknown; filters: [string, unknown][] };
function fakeDb(input: { id: string; paidy_payment_id: string; status: string }[], flipped: { id: string }[] = [{ id: "s1" }]) {
  const rows: Record<string, unknown>[] = input.map((r) => ({ cash_order_id: "o1", ...r }));
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      const c: Call = { table, op: "select", filters: [] };
      calls.push(c);
      // Rows matching every eq/in filter recorded so far (paidy_payments only).
      const match = () => rows.filter((r) => c.filters.every(([k, v]) =>
        Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
      const result = () => {
        if (table === "paidy_payments" && c.op === "select") return { data: match(), error: null };
        if (table === "paidy_payments" && c.op === "update") {
          const hit = match();
          hit.forEach((r) => Object.assign(r, c.values as object));
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        if (table === "payment_submissions" && c.op === "update") return { data: flipped, error: null };
        return { data: null, error: null };
      };
      const q: Record<string, unknown> = {
        select() { return q; },
        update(v: unknown) { c.op = "update"; c.values = v; return q; },
        insert(v: unknown) { c.op = "insert"; c.values = v; return Promise.resolve({ error: null }); },
        eq(k: string, v: unknown) { c.filters.push([k, v]); return q; },
        in(k: string, v: unknown) { c.filters.push([k, v]); return q; },
        maybeSingle() { const r = result(); return Promise.resolve({ data: (r.data as unknown[] | null)?.[0] ?? null, error: null }); },
        then(res: (x: unknown) => unknown) { return Promise.resolve(result()).then(res); },
      };
      return q;
    },
  };
  return Object.assign(db, { rows });
}
const FUTURE = new Date(Date.now() + 20 * 86400000).toISOString();
const pay = (status: string, extra: Record<string, unknown> = {}) => ({ id: "pay_1", status, amount: 1000, captures: [], created_at: new Date().toISOString(), expires_at: FUTURE, ...extra }) as never;

Deno.test("release: authorised → closed at Paidy, row closed, submission rejected quietly", async () => {
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_1", status: "authorized" }]);
  let closedId = "";
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.resolve(pay("AUTHORIZED")),
    close: (id) => { closedId = id; return Promise.resolve(pay("CLOSED")); },
  });
  assertEquals(res, { ok: true, closed: 1 });
  assertEquals(closedId, "pay_1");
  const upd = db.calls.find((c) => c.table === "paidy_payments" && c.op === "update");
  assertEquals((upd?.values as Record<string, unknown>).status, "closed");
  const sub = db.calls.find((c) => c.table === "payment_submissions" && c.op === "update");
  assertEquals((sub?.values as Record<string, unknown>).status, "rejected");
  assertEquals(db.calls.some((c) => c.table === "audit_logs" && c.op === "insert"), true);
});
Deno.test("release: captured → refused, nothing written, no close", async () => {
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_1", status: "authorized" }]);
  let closeCalled = false;
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.resolve(pay("CLOSED", { captures: [{ id: "cap_1", amount: 1000, created_at: "2026-10-06" }] })),
    close: () => { closeCalled = true; return Promise.resolve(pay("CLOSED")); },
  });
  assertEquals(res.ok, false);
  assertEquals(closeCalled, false);
  assertEquals(db.calls.some((c) => c.op === "update"), false);
});
Deno.test("release: Paidy unreachable → refused, nothing written", async () => {
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_1", status: "authorized" }]);
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.reject(new Error("timeout")),
    close: () => Promise.resolve(pay("CLOSED")),
  });
  assertEquals(res.ok === false && res.code, "paidy_unverified");
  assertEquals(db.calls.some((c) => c.op === "update"), false);
});
Deno.test("release: close refused by Paidy → cancel refused, nothing written", async () => {
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_1", status: "authorized" }]);
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.resolve(pay("AUTHORIZED")),
    close: () => Promise.reject(new Error("409")),
  });
  assertEquals(res.ok === false && res.code, "paidy_close_failed");
  assertEquals(db.calls.some((c) => c.op === "update"), false);
});
Deno.test("release: no open authorisation → ok, nothing to do", async () => {
  const db = fakeDb([]);
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.reject(new Error("must not be called")),
    close: () => Promise.reject(new Error("must not be called")),
  });
  assertEquals(res, { ok: true, closed: 0 });
});

// --- Reassessment P08: a cancel that stopped half-way is finished by the next ---
Deno.test("release retry: row already closed by an earlier attempt → no Paidy call, submission still rejected", async () => {
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_1", status: "closed" }]);
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.reject(new Error("must not be called")),
    close: () => Promise.reject(new Error("must not be called")),
  });
  assertEquals(res, { ok: true, closed: 0 });
  const sub = db.calls.find((c) => c.table === "payment_submissions" && c.op === "update");
  assertEquals((sub?.values as Record<string, unknown>).status, "rejected");
});
Deno.test("release: close answer lost but Paidy shows CLOSED → treated as closed", async () => {
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_1", status: "authorized" }]);
  let gets = 0;
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.resolve(pay(++gets === 1 ? "AUTHORIZED" : "CLOSED")),
    close: () => Promise.reject(new Error("timeout")),
  });
  assertEquals(res, { ok: true, closed: 1 });
  assertEquals(db.rows[0].status, "closed");
});
Deno.test("release: close answer lost and Paidy shows a capture → refused, row untouched", async () => {
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_1", status: "authorized" }]);
  let gets = 0;
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.resolve(++gets === 1 ? pay("AUTHORIZED") : pay("CLOSED", { captures: [{ id: "cap_1", amount: 1000 }] })),
    close: () => Promise.reject(new Error("timeout")),
  });
  assertEquals(res.ok === false && res.code, "paidy_already_captured");
  assertEquals(db.rows[0].status, "authorized");
});
Deno.test("release: row turned captured between read and write → refused (compare-and-set lost)", async () => {
  const db = fakeDb([{ id: "r1", paidy_payment_id: "pay_1", status: "authorized" }]);
  const res = await releasePaidyForCancel(db, "o1", "u1", {
    get: () => Promise.resolve(pay("AUTHORIZED")),
    close: () => { db.rows[0].status = "captured"; return Promise.resolve(pay("CLOSED")); },
  });
  assertEquals(res.ok === false && res.code, "paidy_already_captured");
  assertEquals(db.calls.some((c) => c.table === "payment_submissions"), false);
});
