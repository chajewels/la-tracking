/**
 * PENALTY SCHEDULE — the penalty engine's trigger dates, cap and per-row
 * planning, moved out of penalty-engine/index.ts VERBATIM (owner-approved
 * 2026-10-20, R7) so the same-day final-forfeit settlement charges exactly
 * what the engine would have charged that day. No rule changed here: the
 * engine calls these functions with the same inputs it used inline, and
 * src/test/penalty-schedule.test.ts compares them with the old inline code.
 *
 * Pure: no network, no database. CLAUDE.md "PENALTY STANDARD" is the rule.
 */

export type PenaltyStage = "week1" | "week2";
export type PenaltyTrigger = { date: Date; stage: PenaltyStage; cycle: number };

/** Days in a 0-based month (month may run past 11; JS rolls the year). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The engine's alternating trigger pattern for one schedule row:
 *   week1:1 → due + 7 (or + 0 once grace is consumed), week2:1 → due + 14,
 *   then for m = 1..12: week1:(m+1) → due + m months (clamped day),
 *                       week2:(m+1) → that date + 14.
 */
export function buildTriggerDates(
  dueDateYmd: string,
  graceConsumed: boolean,
): PenaltyTrigger[] {
  const dueDate = new Date(dueDateYmd + "T00:00:00Z");
  const dueDayOfMonth = dueDate.getUTCDate();
  const week1Offset = graceConsumed ? 0 : 7;
  const triggerDates: PenaltyTrigger[] = [];

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
          daysInMonth(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + m),
        ),
      ),
    );
    triggerDates.push({ date: monthlyDate, stage: "week1", cycle: m + 1 });

    const plus14Date = new Date(monthlyDate);
    plus14Date.setUTCDate(plus14Date.getUTCDate() + 14);
    triggerDates.push({ date: plus14Date, stage: "week2", cycle: m + 1 });
  }
  return triggerDates;
}

/**
 * The engine's cap for one row: final installment 3000 / 6000, others
 * 1000 / 2000; an active penalty_cap_overrides row replaces the non-final cap;
 * a CLEAN reactivated extension_active account gets +1000 / +2000 on the final
 * installment (DIRTY gets no bump).
 */
export function penaltyCapFor(input: {
  currency: string;
  installmentNumber: number;
  planMonths: number;
  overrideCap?: number;
  isReactivated: boolean;
  status: string;
  hasEarlierUnpaid: boolean;
}): number {
  const { currency, installmentNumber, planMonths, overrideCap } = input;
  const base =
    installmentNumber === planMonths
      ? currency === "PHP"
        ? 3000
        : 6000
      : currency === "PHP"
        ? 1000
        : 2000;
  let cap =
    overrideCap !== undefined
      ? installmentNumber >= planMonths
        ? currency === "PHP"
          ? 3000
          : 6000
        : overrideCap
      : base;
  if (
    input.isReactivated &&
    input.status === "extension_active" &&
    installmentNumber === planMonths &&
    !input.hasEarlierUnpaid
  ) {
    cap += currency === "PHP" ? 1000 : 2000;
  }
  return cap;
}

export type PlannedInsert = {
  stage: PenaltyStage;
  cycle: number;
  amount: number;
  penaltyDate: string;
};
export type PlannedReinstate = { id: string; amount: number };

/**
 * One row's run of the engine's trigger loop: every trigger due at `now` whose
 * stage:cycle is not taken, capped. A waived row at a slot is held while
 * `now <= penalty_date + waiverGraceDays`, else reinstated. Reinstated amounts
 * are NOT counted toward the cap inside the loop (the engine counts them only
 * after the write lands) — kept exactly as it was.
 */
export function planItemPenalties(input: {
  triggers: PenaltyTrigger[];
  now: Date;
  existingKeys: Set<string>;
  currentTotal: number;
  cap: number;
  amountFor: (stage: PenaltyStage) => number;
  waivedSlots?: Map<string, { id: string; penaltyDate: string }>;
  waiverGraceDays: number;
}): {
  inserts: PlannedInsert[];
  reinstate: PlannedReinstate[];
  newKeys: string[];
  insertedTotal: number;
} {
  const {
    triggers,
    now,
    existingKeys,
    currentTotal,
    cap,
    amountFor,
    waivedSlots,
    waiverGraceDays,
  } = input;
  const inserts: PlannedInsert[] = [];
  const reinstate: PlannedReinstate[] = [];
  const newKeys: string[] = [];
  const taken = new Set(existingKeys);
  let insertedTotal = 0;

  for (const trigger of triggers) {
    if (now < trigger.date) break;

    const key = `${trigger.stage}:${trigger.cycle}`;
    if (taken.has(key)) continue;

    let penaltyAmount = amountFor(trigger.stage);

    const projectedTotal = currentTotal + insertedTotal + penaltyAmount;
    if (projectedTotal > cap) {
      penaltyAmount = Math.max(0, cap - currentTotal - insertedTotal);
      if (penaltyAmount <= 0) break;
    }

    const penaltyDate = trigger.date.toISOString().split("T")[0];
    const waivedRow = waivedSlots?.get(key);

    if (waivedRow) {
      const graceEnd = new Date(`${waivedRow.penaltyDate}T00:00:00Z`);
      graceEnd.setUTCDate(graceEnd.getUTCDate() + waiverGraceDays);
      if (now <= graceEnd) continue;
      reinstate.push({ id: waivedRow.id, amount: penaltyAmount });
    } else {
      inserts.push({
        stage: trigger.stage,
        cycle: trigger.cycle,
        amount: penaltyAmount,
        penaltyDate,
      });
    }

    taken.add(key);
    newKeys.push(key);
    if (!waivedRow) insertedTotal += penaltyAmount;
  }
  return { inserts, reinstate, newKeys, insertedTotal };
}
