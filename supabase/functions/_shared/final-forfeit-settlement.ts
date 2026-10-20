/**
 * SAME-DAY FINAL-FORFEIT SETTLEMENT (owner rule R7, approved 2026-10-20).
 * docs/PENALTY-AND-FORFEITURE.md "Same-day settlement after final forfeiture".
 *
 * On the final-forfeiture date itself (the PHT calendar day of the account's
 * `final_forfeited` audit row) staff may record ONE full settlement payment,
 * submitted with proof that day: the remaining balance plus exactly what the
 * penalty engine would have charged that day (same installment, same next
 * stage:cycle slot, same amount — or nothing, e.g. at the cap). Confirmation
 * may come later. Confirming it completes the account.
 *
 * Pure: no network, no database. settle-final-forfeited gathers the inputs;
 * settle_final_forfeited_same_day_atomic re-checks and writes.
 */
import { phtDay } from "./extension-rules.ts";
import {
  buildTriggerDates,
  penaltyCapFor,
  planItemPenalties,
  type PenaltyStage,
  type PlannedInsert,
} from "./penalty-schedule.ts";

/** payment_submissions.submission_type of a settlement (no new column). */
export const FINAL_FORFEIT_SETTLEMENT_TYPE = "final_forfeit_settlement";

/** The day a settlement may be SUBMITTED: the PHT day of the final forfeiture. */
export function settlementDayOpen(
  finalForfeitedAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  return (
    !!finalForfeitedAt && phtDay(finalForfeitedAt) === phtDay(new Date(nowMs))
  );
}

/** Two-decimal rounding for money (PHP keeps cents; JPY amounts are whole). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The full settlement amount, on allocate_payment_atomic's own formula
 * (total_amount + non-waived penalties − non-voided payments, floored at 0), so
 * confirming exactly this amount leaves 0 and completes the account.
 */
export function settlementAmount(input: {
  totalAmount: number;
  nonWaivedPenalties: number;
  newPenalties: number;
  payments: number;
}): number {
  return Math.max(
    0,
    round2(
      input.totalAmount +
        input.nonWaivedPenalties +
        input.newPenalties -
        input.payments,
    ),
  );
}

export type SettlementRow = {
  id: string;
  installment_number: number;
  due_date: string;
  status: string;
  paid_amount: number;
  base_installment_amount: number;
};
export type SettlementPenalty = {
  id: string;
  schedule_id: string;
  penalty_stage: PenaltyStage;
  penalty_cycle: number;
  penalty_amount: number;
  status: string;
  penalty_date: string;
};
export type SettlementPenaltyInsert = PlannedInsert & {
  scheduleId: string;
  installmentNumber: number;
};

/**
 * What the penalty engine would have charged on `day` (YYYY-MM-DD, the
 * final-forfeiture day) for this account, computed the way the engine does —
 * same row selection (pending / overdue / partially_paid, due on or before
 * the day), Guard 1 (paid < base), Guard 2 (valid allocations < base), the
 * same cap (overrides, CLEAN bump as the extension_active account it was that
 * morning), the same grace rule and the same trigger loop at the 00:05 UTC run
 * — limited to the trigger slots that fall due ON that day ("that day's"
 * penalty: earlier slots count as taken). The R3 end-date skip is not applied:
 * R7 is the owner's exception that charges that day's penalty.
 */
export function planSettlementPenalties(input: {
  day: string;
  currency: string;
  planMonths: number;
  isReactivated: boolean;
  rows: SettlementRow[];
  allocSumBySchedule: Map<string, number>;
  penalties: SettlementPenalty[];
  overrideCap?: number;
  amounts: { week1: number; week2: number };
  waiverGraceDays: number;
}): SettlementPenaltyInsert[] {
  const { day, currency, rows, penalties } = input;
  const planMonths = input.planMonths || 6;
  const now = new Date(`${day}T00:05:00Z`);

  let items = rows.filter(
    (r) =>
      ["pending", "overdue", "partially_paid"].includes(r.status) &&
      r.due_date <= day,
  );
  const hasEarlierUnpaid = items.some((r) => r.installment_number < planMonths);
  items = items.filter(
    (r) => Number(r.paid_amount) < Number(r.base_installment_amount),
  );
  items = items.filter(
    (r) =>
      (input.allocSumBySchedule.get(r.id) || 0) <
      Number(r.base_installment_amount) - 0.01,
  );
  items.sort((a, b) => a.installment_number - b.installment_number);

  const out: SettlementPenaltyInsert[] = [];
  for (const item of items) {
    const own = penalties.filter((p) => p.schedule_id === item.id);
    const existingKeys = new Set(
      own
        .filter((p) => p.status !== "waived")
        .map((p) => `${p.penalty_stage}:${p.penalty_cycle}`),
    );
    const waivedSlots = new Map(
      own
        .filter((p) => p.status === "waived")
        .map(
          (p) =>
            [
              `${p.penalty_stage}:${p.penalty_cycle}`,
              { id: p.id, penaltyDate: p.penalty_date },
            ] as const,
        ),
    );
    const currentTotal = own
      .filter((p) => p.status === "unpaid" || p.status === "paid")
      .reduce((s, p) => s + Number(p.penalty_amount), 0);
    const cap = penaltyCapFor({
      currency,
      installmentNumber: item.installment_number,
      planMonths,
      overrideCap: input.overrideCap,
      isReactivated: input.isReactivated,
      status: "extension_active",
      hasEarlierUnpaid,
    });
    if (currentTotal >= cap) continue;

    const graceConsumed =
      penalties.some(
        (p) => p.schedule_id !== item.id && p.status === "unpaid",
      ) ||
      rows.some(
        (r) =>
          r.id !== item.id &&
          (r.status === "overdue" || r.status === "partially_paid"),
      );

    const triggers = buildTriggerDates(item.due_date, graceConsumed);
    // Only that day's slots: every slot that fell due before the day is taken.
    for (const t of triggers) {
      if (t.date.toISOString().slice(0, 10) < day)
        existingKeys.add(`${t.stage}:${t.cycle}`);
    }
    const plan = planItemPenalties({
      triggers,
      now,
      existingKeys,
      currentTotal,
      cap,
      amountFor: (stage) =>
        stage === "week1" ? input.amounts.week1 : input.amounts.week2,
      waivedSlots,
      waiverGraceDays: input.waiverGraceDays,
    });
    for (const ins of plan.inserts) {
      out.push({
        ...ins,
        scheduleId: item.id,
        installmentNumber: item.installment_number,
      });
    }
  }
  return out;
}
