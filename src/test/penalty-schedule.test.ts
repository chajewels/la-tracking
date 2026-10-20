import { describe, expect, it } from "vitest";
import {
  buildTriggerDates,
  penaltyCapFor,
  planItemPenalties,
  type PenaltyStage,
} from "../../supabase/functions/_shared/penalty-schedule.ts";

// R7 (owner 2026-10-20) moved the penalty engine's trigger dates, cap and
// per-row loop into _shared/penalty-schedule.ts. "No rule change, behaviour
// identical, proven by tests": the REFERENCE functions below are the engine's
// inline code as it stood on origin/main 19ba7afc (penalty-engine/index.ts
// getPenaltyCap, the cap/override/bump block, the trigger builder and the
// trigger loop), copied unchanged except for being wrapped in functions. The
// helper must return the same result for every input.

function refDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function refCap(
  currency: string,
  installmentNumber: number,
  planMonths: number,
  overrideCap: number | undefined,
  acct: { is_reactivated: boolean; status: string },
  hasEarlierUnpaid: boolean,
): number {
  const getPenaltyCap = (
    currency: string,
    installmentNumber: number,
    planMonths: number,
  ): number => {
    if (installmentNumber === planMonths)
      return currency === "PHP" ? 3000 : 6000;
    return currency === "PHP" ? 1000 : 2000;
  };
  let cap =
    overrideCap !== undefined
      ? installmentNumber >= planMonths
        ? currency === "PHP"
          ? 3000
          : 6000
        : overrideCap
      : getPenaltyCap(currency, installmentNumber, planMonths);
  if (
    acct.is_reactivated &&
    acct.status === "extension_active" &&
    installmentNumber === planMonths &&
    !hasEarlierUnpaid
  ) {
    cap += currency === "PHP" ? 1000 : 2000;
  }
  return cap;
}

function refLoop(input: {
  dueDateYmd: string;
  graceConsumed: boolean;
  now: Date;
  existingKeys: Set<string>;
  currentTotal: number;
  cap: number;
  getAmount: (stage: string) => number;
  waived?: Map<string, { id: string; penaltyDate: string }>;
  waiverGraceDays: number;
}) {
  const dueDate = new Date(input.dueDateYmd + "T00:00:00Z");
  const dueDayOfMonth = dueDate.getUTCDate();
  const week1Offset = input.graceConsumed ? 0 : 7;
  const triggerDates: Array<{
    date: Date;
    stage: "week1" | "week2";
    cycle: number;
  }> = [];
  const phase1Date = new Date(dueDate);
  phase1Date.setUTCDate(phase1Date.getUTCDate() + week1Offset);
  triggerDates.push({ date: phase1Date, stage: "week1", cycle: 1 });
  const phase2Date = new Date(dueDate);
  phase2Date.setUTCDate(phase2Date.getUTCDate() + 14);
  triggerDates.push({ date: phase2Date, stage: "week2", cycle: 1 });
  for (let m = 1; m <= 12; m++) {
    const monthlyDate = new Date(
      Date.UTC(
        dueDate.getUTCFullYear(),
        dueDate.getUTCMonth() + m,
        Math.min(
          dueDayOfMonth,
          refDaysInMonth(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + m),
        ),
      ),
    );
    triggerDates.push({ date: monthlyDate, stage: "week1", cycle: m + 1 });
    const plus14Date = new Date(monthlyDate);
    plus14Date.setUTCDate(plus14Date.getUTCDate() + 14);
    triggerDates.push({ date: plus14Date, stage: "week2", cycle: m + 1 });
  }

  const existingKeys = new Set(input.existingKeys);
  const inserts: Array<{
    stage: string;
    cycle: number;
    amount: number;
    penaltyDate: string;
  }> = [];
  const waivedUpdates: Array<{ id: string; penaltyAmount: number }> = [];
  let newPenaltyForItem = 0;
  for (const trigger of triggerDates) {
    if (input.now < trigger.date) break;
    const key = `${trigger.stage}:${trigger.cycle}`;
    if (existingKeys.has(key)) continue;
    let penaltyAmount = input.getAmount(trigger.stage);
    const projectedTotal =
      input.currentTotal + newPenaltyForItem + penaltyAmount;
    if (projectedTotal > input.cap) {
      penaltyAmount = Math.max(
        0,
        input.cap - input.currentTotal - newPenaltyForItem,
      );
      if (penaltyAmount <= 0) break;
    }
    const penaltyDate = trigger.date.toISOString().split("T")[0];
    const waivedRow = input.waived?.get(key);
    if (waivedRow) {
      const graceEnd = new Date(`${waivedRow.penaltyDate}T00:00:00Z`);
      graceEnd.setUTCDate(graceEnd.getUTCDate() + input.waiverGraceDays);
      if (input.now <= graceEnd) continue;
      waivedUpdates.push({ id: waivedRow.id, penaltyAmount });
    } else {
      inserts.push({
        stage: trigger.stage,
        cycle: trigger.cycle,
        amount: penaltyAmount,
        penaltyDate,
      });
    }
    existingKeys.add(key);
    if (!input.waived?.has(key)) newPenaltyForItem += penaltyAmount;
  }
  return { inserts, waivedUpdates, newPenaltyForItem };
}

// Small deterministic PRNG so the comparison is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("penalty-schedule equals the engine's former inline code", () => {
  it("cap: every currency / installment / override / bump combination", () => {
    for (const currency of ["PHP", "JPY"]) {
      for (const planMonths of [3, 6, 8]) {
        for (let inst = 1; inst <= planMonths + 1; inst++) {
          for (const overrideCap of [undefined, 1500, 4000]) {
            for (const status of ["active", "overdue", "extension_active"]) {
              for (const isReactivated of [false, true]) {
                for (const hasEarlierUnpaid of [false, true]) {
                  const want = refCap(
                    currency,
                    inst,
                    planMonths,
                    overrideCap,
                    { is_reactivated: isReactivated, status },
                    hasEarlierUnpaid,
                  );
                  const got = penaltyCapFor({
                    currency,
                    installmentNumber: inst,
                    planMonths,
                    overrideCap,
                    isReactivated,
                    status,
                    hasEarlierUnpaid,
                  });
                  expect(got).toBe(want);
                }
              }
            }
          }
        }
      }
    }
  });

  it("trigger loop: 3,000 random rows (dates, grace, keys, caps, waived slots) give the same plan", () => {
    const r = rng(20261020);
    const stages: PenaltyStage[] = ["week1", "week2"];
    for (let n = 0; n < 3000; n++) {
      const y = 2025 + Math.floor(r() * 2);
      const mo = 1 + Math.floor(r() * 12);
      const d = 1 + Math.floor(r() * 31);
      const due = new Date(
        Date.UTC(y, mo - 1, Math.min(d, refDaysInMonth(y, mo - 1))),
      );
      const dueYmd = due.toISOString().slice(0, 10);
      const now = new Date(
        due.getTime() + Math.floor(r() * 420) * 86_400_000 + 5 * 60_000,
      );
      const graceConsumed = r() < 0.5;
      const currency = r() < 0.5 ? "PHP" : "JPY";
      const step = currency === "PHP" ? 500 : 1000;
      const existingKeys = new Set<string>();
      const waived = new Map<string, { id: string; penaltyDate: string }>();
      for (let c = 1; c <= 13; c++) {
        for (const st of stages) {
          const roll = r();
          if (roll < 0.15) existingKeys.add(`${st}:${c}`);
          else if (roll < 0.22) {
            const pd = new Date(
              due.getTime() + Math.floor(r() * 400) * 86_400_000,
            )
              .toISOString()
              .slice(0, 10);
            waived.set(`${st}:${c}`, {
              id: `w-${n}-${st}-${c}`,
              penaltyDate: pd,
            });
          }
        }
      }
      const cap = [1000, 2000, 3000, 4000, 6000, 8000, 1500][
        Math.floor(r() * 7)
      ];
      const currentTotal = Math.floor(r() * 5) * step;
      const waiverGraceDays = Math.floor(r() * 10);
      const getAmount = () => step;

      const ref = refLoop({
        dueDateYmd: dueYmd,
        graceConsumed,
        now,
        existingKeys,
        currentTotal,
        cap,
        getAmount,
        waived,
        waiverGraceDays,
      });
      const got = planItemPenalties({
        triggers: buildTriggerDates(dueYmd, graceConsumed),
        now,
        existingKeys,
        currentTotal,
        cap,
        amountFor: getAmount,
        waivedSlots: waived,
        waiverGraceDays,
      });
      expect(got.inserts).toEqual(ref.inserts);
      expect(got.reinstate).toEqual(
        ref.waivedUpdates.map((w) => ({ id: w.id, amount: w.penaltyAmount })),
      );
      expect(got.insertedTotal).toBe(ref.newPenaltyForItem);
    }
  });

  it("planItemPenalties never mutates the caller's key set (the engine adds newKeys itself)", () => {
    const keys = new Set(["week1:1"]);
    planItemPenalties({
      triggers: buildTriggerDates("2026-01-10", true),
      now: new Date("2026-06-01T00:05:00Z"),
      existingKeys: keys,
      currentTotal: 0,
      cap: 3000,
      amountFor: () => 500,
      waiverGraceDays: 7,
    });
    expect([...keys]).toEqual(["week1:1"]);
  });
});
