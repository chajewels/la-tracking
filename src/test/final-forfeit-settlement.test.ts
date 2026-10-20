import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FINAL_FORFEIT_SETTLEMENT_TYPE,
  planSettlementPenalties,
  settlementAmount,
  settlementDayOpen,
  type SettlementPenalty,
  type SettlementRow,
} from "../../supabase/functions/_shared/final-forfeit-settlement.ts";

// R7 same-day settlement after final forfeiture (owner 2026-10-20).
// docs/PENALTY-AND-FORFEITURE.md "Same-day settlement after final forfeiture".
// The SQL function is exercised for real in development/final-forfeit-settlement.sql
// (throwaway Postgres); here: the pure rules and the source order of the callers.

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}
const code = (p: string) => stripComments(readFileSync(p, "utf8"));
const sql = (p: string) => readFileSync(p, "utf8").replace(/--.*$/gm, "");

// An 18788-shaped DIRTY plan: 6 months, installments 3–5 unpaid and at their
// cap, installment 6 due on the forfeiture date 2026-09-20, reactivated, final
// forfeiture on 2026-10-20 (the extension end).
function dirtyPlan(currency: "PHP" | "JPY") {
  const step = currency === "PHP" ? 500 : 1000;
  const row = (n: number, due: string, status: string): SettlementRow => ({
    id: `r${n}`,
    installment_number: n,
    due_date: due,
    status,
    paid_amount: n <= 2 ? 4697 : 0,
    base_installment_amount: 4697,
  });
  const rows = [
    row(1, "2026-04-20", "paid"),
    row(2, "2026-05-20", "paid"),
    row(3, "2026-06-20", "overdue"),
    row(4, "2026-07-20", "overdue"),
    row(5, "2026-08-20", "overdue"),
    row(6, "2026-09-20", "overdue"),
    { ...row(7, "2026-10-20", "pending"), base_installment_amount: 0 },
  ];
  const pen = (
    id: string,
    s: string,
    stage: "week1" | "week2",
    cycle: number,
    date: string,
  ): SettlementPenalty => ({
    id,
    schedule_id: s,
    penalty_stage: stage,
    penalty_cycle: cycle,
    penalty_amount: step,
    status: "unpaid",
    penalty_date: date,
  });
  const penalties = [
    pen("p1", "r3", "week1", 1, "2026-06-20"),
    pen("p2", "r3", "week2", 1, "2026-07-04"),
    pen("p3", "r4", "week1", 1, "2026-07-20"),
    pen("p4", "r4", "week2", 1, "2026-08-03"),
    pen("p5", "r5", "week1", 1, "2026-08-20"),
    pen("p6", "r5", "week2", 1, "2026-09-03"),
    pen("p7", "r6", "week1", 1, "2026-09-20"),
    pen("p8", "r6", "week2", 1, "2026-10-04"),
  ];
  return {
    day: "2026-10-20",
    currency,
    planMonths: 6,
    isReactivated: true,
    rows,
    penalties,
    allocSumBySchedule: new Map([
      ["r1", 4697],
      ["r2", 4697],
    ]),
    amounts: { week1: step, week2: step },
    waiverGraceDays: 7,
  };
}

describe("R7 — submitted on the final-forfeiture day only (PHT)", () => {
  const ff = "2026-10-20T00:10:01Z"; // the 00:10 UTC run = 08:10 PHT on 2026-10-20
  it("same PHT day: open; the next PHT day: closed", () => {
    expect(settlementDayOpen(ff, Date.parse("2026-10-20T00:15:00Z"))).toBe(
      true,
    );
    expect(settlementDayOpen(ff, Date.parse("2026-10-20T15:59:59Z"))).toBe(
      true,
    ); // 23:59:59 PHT
    expect(settlementDayOpen(ff, Date.parse("2026-10-20T16:00:00Z"))).toBe(
      false,
    ); // 00:00 PHT next day
    expect(settlementDayOpen(ff, Date.parse("2026-10-21T00:15:00Z"))).toBe(
      false,
    );
    expect(settlementDayOpen(null)).toBe(false);
  });
});

describe("R7 — that day's penalty = exactly what the engine would have charged", () => {
  for (const currency of ["PHP", "JPY"] as const) {
    const step = currency === "PHP" ? 500 : 1000;
    it(`${currency} DIRTY: installment 6, week1:2 dated the day, one step`, () => {
      expect(planSettlementPenalties(dirtyPlan(currency))).toEqual([
        {
          stage: "week1",
          cycle: 2,
          amount: step,
          penaltyDate: "2026-10-20",
          scheduleId: "r6",
          installmentNumber: 6,
        },
      ]);
    });

    it(`${currency}: nothing when the installment is already at its cap`, () => {
      const p = dirtyPlan(currency);
      // Fill installment 6 to the DIRTY final cap (3000 / 6000).
      p.penalties.push({
        id: "x1",
        schedule_id: "r6",
        penalty_stage: "week2",
        penalty_cycle: 2,
        penalty_amount: step * 4,
        status: "paid",
        penalty_date: "2026-10-04",
      });
      expect(planSettlementPenalties(p)).toEqual([]);
    });

    it(`${currency} CLEAN: the extension bump applies (cap 4000 / 8000), capped amount when only part fits`, () => {
      const p = dirtyPlan(currency);
      for (const r of p.rows)
        if (r.installment_number < 6) {
          r.status = "paid";
          r.paid_amount = 4697;
        }
      p.penalties = p.penalties.filter((x) => x.schedule_id === "r6");
      p.penalties.push({
        id: "y",
        schedule_id: "r6",
        penalty_stage: "week2",
        penalty_cycle: 2,
        penalty_amount: step * 5.5,
        status: "unpaid",
        penalty_date: "2026-10-04",
      });
      // current 1000 + 2750 = 3750 (PHP) of a 4000 cap → 250 left.
      const got = planSettlementPenalties(p);
      expect(got).toHaveLength(1);
      expect(got[0].amount).toBe(step / 2);
    });
  }

  it("no trigger falls due that day → nothing", () => {
    const p = { ...dirtyPlan("PHP"), day: "2026-10-21" };
    expect(planSettlementPenalties(p)).toEqual([]);
  });

  it("an earlier slot the engine missed is NOT charged — only that day's slot", () => {
    const p = dirtyPlan("PHP");
    p.penalties = p.penalties.filter((x) => x.id !== "p8"); // week2:1 (2026-10-04) never charged
    const got = planSettlementPenalties(p);
    expect(got.map((g) => `${g.stage}:${g.cycle}@${g.penaltyDate}`)).toEqual([
      "week1:2@2026-10-20",
    ]);
  });

  it("a waived slot dated that day is held by the waiver grace → nothing", () => {
    const p = dirtyPlan("PHP");
    p.penalties.push({
      id: "w",
      schedule_id: "r6",
      penalty_stage: "week1",
      penalty_cycle: 2,
      penalty_amount: 500,
      status: "waived",
      penalty_date: "2026-10-20",
    });
    expect(planSettlementPenalties(p)).toEqual([]);
  });
});

describe("R7 — full amount only; a later Confirm still completes", () => {
  it("amount = total + non-waived penalties + that day's penalty − payments, floored at 0", () => {
    expect(
      settlementAmount({
        totalAmount: 28182,
        nonWaivedPenalties: 4500,
        newPenalties: 500,
        payments: 9395,
      }),
    ).toBe(23787);
    expect(
      settlementAmount({
        totalAmount: 100,
        nonWaivedPenalties: 0,
        newPenalties: 0,
        payments: 150,
      }),
    ).toBe(0);
    expect(
      settlementAmount({
        totalAmount: 1000.1,
        nonWaivedPenalties: 0.2,
        newPenalties: 0,
        payments: 0,
      }),
    ).toBe(1000.3);
  });

  it("paying exactly that amount leaves allocate_payment_atomic's remaining at 0 (status → completed), on any day", () => {
    const totalAmount = 28182,
      pen = 5000,
      paid = 9395;
    const amount = settlementAmount({
      totalAmount,
      nonWaivedPenalties: pen,
      newPenalties: 0,
      payments: paid,
    });
    // allocate_payment_atomic: new_remaining = greatest(0, total_amount + pen_active − (paid + amount))
    expect(Math.max(0, totalAmount + pen - (paid + amount))).toBe(0);
    // The confirm guard checks status + amount only — never the date.
    const src = code("supabase/functions/review-payment-submission/index.ts");
    const guard = src.slice(
      src.indexOf(
        "submission.submission_type === FINAL_FORFEIT_SETTLEMENT_TYPE",
      ),
      src.indexOf("const { data: flipped"),
    );
    expect(guard).not.toMatch(/settlementDayOpen|phtDay|Asia\/Manila/);
    expect(guard).toMatch(/sAcc\?\.status !== "final_forfeited"/);
  });
});

describe("R7 — callers and the SQL function (source order)", () => {
  const migration = sql(
    "supabase/migrations/20261226100000_final_forfeit_same_day_settlement.sql",
  );
  const fn = migration.slice(
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.settle_final_forfeited_same_day_atomic",
    ),
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.release_final_forfeit_settlement_hold",
    ),
  );

  it("refuses before writing: permission, status, day, pending submission (INVARIANT 12), second settlement, proof, amount, stock", () => {
    const firstWrite = fn.indexOf("UPDATE public.website_product_variants");
    for (const refusal of [
      "'permission_denied'",
      "'not_final_forfeited'",
      "'settlement_day_passed'",
      "'submission_pending'",
      "'already_settled'",
      "'proof_required'",
      "'amount_mismatch'",
      "'out_of_stock'",
      "'penalty_slot_taken'",
    ]) {
      const i = fn.indexOf(refusal);
      expect(i, refusal).toBeGreaterThan(-1);
      expect(i, refusal).toBeLessThan(firstWrite);
    }
    expect(fn.indexOf("IF p_preview THEN")).toBeLessThan(firstWrite);
    expect(fn).toMatch(/has_permission\(p_user_id, 'record_payment'\)/);
    // one settlement per account: a REJECTED one frees the slot, anything else blocks
    expect(fn).toMatch(
      /submission_type = 'final_forfeit_settlement'\s+AND status::text <> 'rejected'/,
    );
  });

  it("inserts the submission BEFORE the penalty (trg_auto_waive_same_day would waive it otherwise)", () => {
    const sub = fn.indexOf("INSERT INTO public.payment_submissions");
    const pen = fn.indexOf("INSERT INTO public.penalty_fees");
    expect(sub).toBeGreaterThan(-1);
    expect(sub).toBeLessThan(pen);
    expect(fn).toMatch(
      /'final_forfeit_settlement'\s*\)\s*RETURNING id INTO v_sub_id/,
    );
  });

  it("undoes THIS settlement's auto-waives (a penalty the engine charged earlier that day) before the penalty insert", () => {
    const sub = fn.indexOf("RETURNING id INTO v_sub_id");
    const revert = fn.indexOf(
      "WHERE source_submission_id = v_sub_id AND is_auto = true AND status = 'approved'",
    );
    const pen = fn.indexOf("INSERT INTO public.penalty_fees");
    expect(revert).toBeGreaterThan(sub);
    expect(revert).toBeLessThan(pen);
    expect(fn).toMatch(/UPDATE public\.penalty_fees SET status = 'unpaid', waived_at = NULL/);
  });

  it("both functions are service_role only", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.settle_final_forfeited_same_day_atomic\([^)]*\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.settle_final_forfeited_same_day_atomic\([^)]*\) TO service_role;/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.release_final_forfeit_settlement_hold\(uuid\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.release_final_forfeit_settlement_hold\(uuid\) TO service_role;/,
    );
  });

  it("settle-final-forfeited: record_payment, the engine's own helpers, the atomic RPC", () => {
    const src = code("supabase/functions/settle-final-forfeited/index.ts");
    expect(src).toMatch(/requirePermission\(ctx, "record_payment"\)/);
    expect(src).toMatch(/planSettlementPenalties\(/);
    expect(src).toMatch(/rpc\(\s*"settle_final_forfeited_same_day_atomic"/);
    expect(src).not.toMatch(/penalty-engine|auto-forfeit-settlement/); // Independence untouched
  });

  it("review-payment-submission: full-amount check before the CAS flip, loyalty restore like reactivation, release on reject", () => {
    const src = code("supabase/functions/review-payment-submission/index.ts");
    expect(src.indexOf('code: "settlement_not_full"')).toBeLessThan(
      src.indexOf("const { data: flipped"),
    );
    expect(src).toMatch(/trigger_event: "account_reactivated"/);
    expect(src).toMatch(
      /rpc\("release_final_forfeit_settlement_hold", \{ p_submission_id: submission_id \}\)/,
    );
    expect(src).toMatch(
      /action === "rejected" && submission\.submission_type === FINAL_FORFEIT_SETTLEMENT_TYPE/,
    );
    expect(FINAL_FORFEIT_SETTLEMENT_TYPE).toBe("final_forfeit_settlement");
  });

  it("Hub: the button only on a final_forfeited plan, for record_payment", () => {
    const src = code("src/pages/AccountDetail.tsx");
    expect(src).toMatch(
      /account\.status === 'final_forfeited' && can\('record_payment'\) && \(\s*<FinalForfeitSettlement/,
    );
  });
});
