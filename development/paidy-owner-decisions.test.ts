// Owner decisions 2026-10-06 (Paidy chat): name1 family-first; a staff cancel
// closes an open Paidy authorisation first.
import { assertEquals } from "jsr:@std/assert@1";
import { paidyCancelStep, paidyFamilyFirstName } from "../supabase/functions/_shared/paidy-rules.ts";
import { releasePaidyForCancel } from "../supabase/functions/_shared/paidy-cancel-release.ts";

Deno.test("name1: Latin name moves the last word to the front", () => {
  assertEquals(paidyFamilyFirstName("Maria Santos"), "Santos Maria");
  assertEquals(paidyFamilyFirstName("  Maria   Dela Cruz "), "Cruz Maria Dela");
});
Deno.test("name1: Japanese script kept as written; one word unchanged; empty", () => {
  assertEquals(paidyFamilyFirstName("山田 太郎"), "山田 太郎");
  assertEquals(paidyFamilyFirstName("ヤマダ タロウ"), "ヤマダ タロウ");
  assertEquals(paidyFamilyFirstName("Cynthia"), "Cynthia");
  assertEquals(paidyFamilyFirstName(null), "");
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
function fakeDb(rows: { id: string; paidy_payment_id: string; status: string }[], flipped: { id: string }[] = [{ id: "s1" }]) {
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      const c: Call = { table, op: "select", filters: [] };
      calls.push(c);
      const q: Record<string, unknown> = {
        select() { return q; },
        update(v: unknown) { c.op = "update"; c.values = v; return q; },
        insert(v: unknown) { c.op = "insert"; c.values = v; return Promise.resolve({ error: null }); },
        eq(k: string, v: unknown) { c.filters.push([k, v]); return q; },
        in(k: string, v: unknown) { c.filters.push([k, v]); return q; },
        then(res: (x: unknown) => unknown) {
          if (table === "paidy_payments" && c.op === "select") return Promise.resolve({ data: rows, error: null }).then(res);
          if (table === "payment_submissions" && c.op === "update") return Promise.resolve({ data: flipped, error: null }).then(res);
          return Promise.resolve({ data: null, error: null }).then(res);
        },
      };
      return q;
    },
  };
  return db;
}
const pay = (status: string, extra: Record<string, unknown> = {}) => ({ id: "pay_1", status, amount: 1000, captures: [], ...extra }) as never;

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
