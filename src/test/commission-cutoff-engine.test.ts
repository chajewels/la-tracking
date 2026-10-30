import { describe, expect, it } from "vitest";
import {
  computeAllMonths, computeMonth, fetchCommissionSplits, isMissingCutoffColumn, isPeriodClosed, listMonthKeys,
  periodKeyForDate, periodRange, type CommissionSplit, type SaleRow,
} from "@/lib/commissionEngine";

const split = (month: string, extra: Partial<CommissionSplit> = {}): CommissionSplit => ({
  month, closer_pct: 30, processor_pct: 20, coordinator_pct: 0, support_pct: 15, verifier_pct: 15,
  top_sales_pct: 15, top_sales_2_pct: 5, merge_groups: [], pool_per_item_php: 200, ...extra,
});
const sale = (id: string, sale_date: string, closer = "Ann", amount = 10000): SaleRow => ({
  id, sale_date, item_code: id, invoice_number: id, item_amount: amount, client_name: `c-${id}`, closer,
  processor: "Bea", coordinator: null, support: "Cy", verifier: "Di", status: "Paid", channel: "Chat", source: "DM",
  opened_in_chat: true, closed_in_chat: true, eligible: true, notes: null,
});

// Existing configuration: Apr 2026 onward, no cut-off anywhere (column absent / null).
const OLD = [split("2026-04-01")];
const NEW = [...OLD, split("2026-11-01", { cutoff_day: 20 })];

describe("commission period rule", () => {
  it("October 2026 stays Oct 1 - Oct 31", () => {
    expect(periodRange("2026-10", NEW)).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(periodKeyForDate("2026-10-01", NEW)).toBe("2026-10");
    expect(periodKeyForDate("2026-10-31", NEW)).toBe("2026-10");
  });

  it("with a Nov 2026 cut-off of 20: Nov = Nov 1-20, Nov 21 goes to Dec, Dec = Nov 21 - Dec 20", () => {
    expect(periodRange("2026-11", NEW)).toEqual({ start: "2026-11-01", end: "2026-11-20" });
    expect(periodKeyForDate("2026-11-20", NEW)).toBe("2026-11");
    expect(periodKeyForDate("2026-11-21", NEW)).toBe("2026-12");
    expect(periodKeyForDate("2026-11-30", NEW)).toBe("2026-12");
    expect(periodRange("2026-12", NEW)).toEqual({ start: "2026-11-21", end: "2026-12-20" });
    expect(periodKeyForDate("2026-12-20", NEW)).toBe("2026-12");
    expect(periodKeyForDate("2026-12-21", NEW)).toBe("2027-01");
    expect(periodRange("2027-01", NEW)).toEqual({ start: "2026-12-21", end: "2027-01-20" });
  });

  it("year end rolls Dec 21+ to January and handles February", () => {
    expect(periodKeyForDate("2026-12-31", NEW)).toBe("2027-01");
    expect(periodRange("2027-03", NEW)).toEqual({ start: "2027-02-21", end: "2027-03-20" });
  });

  it("null and undefined cut-off are both calendar months", () => {
    for (const s of [OLD, [split("2026-04-01", { cutoff_day: null })]]) {
      expect(periodKeyForDate("2026-09-30", s)).toBe("2026-09");
      expect(periodRange("2026-02", s)).toEqual({ start: "2026-02-01", end: "2026-02-28" });
      expect(periodRange("2028-02", s)).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    }
    expect(periodKeyForDate("2026-01-15", [])).toBe("2026-01");
  });

  it("closes the day after the cut-off (Philippine date): Oct on Nov 1, Nov 1-20 on Nov 21", () => {
    expect(isPeriodClosed("2026-10-15", NEW, "2026-10-31")).toBe(false);
    expect(isPeriodClosed("2026-10-15", NEW, "2026-11-01")).toBe(true);
    expect(isPeriodClosed("2026-11-05", NEW, "2026-11-20")).toBe(false);
    expect(isPeriodClosed("2026-11-05", NEW, "2026-11-21")).toBe(true);
    expect(isPeriodClosed("2026-11-25", NEW, "2026-11-21")).toBe(false);
    expect(isPeriodClosed("2026-11-25", NEW, "2026-12-21")).toBe(true);
  });
});

describe("commission engine with the cut-off", () => {
  const rows: SaleRow[] = [];
  for (const [m, last] of [["04", 30], ["05", 31], ["06", 30], ["07", 31], ["08", 31], ["09", 30], ["10", 31]] as const) {
    for (let d = 1; d <= last; d += 3) rows.push(sale(`${m}-${d}`, `2026-${m}-${String(d).padStart(2, "0")}`, d % 2 ? "Ann" : "Eve"));
  }

  it("Apr-Oct figures are identical with and without a later cut-off, and to a calendar-month grouping", () => {
    const before = computeAllMonths(rows, OLD);
    const after = computeAllMonths(rows, NEW);
    expect(after).toEqual(before);
    expect(listMonthKeys(rows, NEW)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    for (const m of before) {
      const calendar = rows.filter(r => r.sale_date.slice(0, 7) === m.monthKey);
      expect(computeMonth(m.monthKey, calendar, OLD)).toEqual(m);
    }
  });

  it("groups Nov 21 onward into December", () => {
    const more = [...rows, sale("n1", "2026-11-20"), sale("n2", "2026-11-21"), sale("n3", "2026-12-20"), sale("n4", "2026-12-21")];
    const by = Object.fromEntries(computeAllMonths(more, NEW).map(m => [m.monthKey, m.rows.map(r => r.id).sort()]));
    expect(by["2026-11"]).toEqual(["n1"]);
    expect(by["2026-12"]).toEqual(["n2", "n3"]);
    expect(by["2027-01"]).toEqual(["n4"]);
    expect(by["2026-10"]).toEqual(computeAllMonths(rows, OLD).find(m => m.monthKey === "2026-10")!.rows.map(r => r.id).sort());
  });
});

describe("reading commission_splits before the migration is applied", () => {
  const missing = { code: "42703", message: "column commission_splits.cutoff_day does not exist" };

  it("recognises the undefined-column error", () => {
    expect(isMissingCutoffColumn(missing)).toBe(true);
    expect(isMissingCutoffColumn({ message: "Could not find the 'cutoff_day' column of 'commission_splits' in the schema cache" })).toBe(true);
    expect(isMissingCutoffColumn({ code: "42501", message: "permission denied for table commission_splits" })).toBe(false);
    expect(isMissingCutoffColumn(null)).toBe(false);
  });

  it("retries once without cutoff_day and treats every cut-off as null", async () => {
    const calls: string[] = [];
    const out = await fetchCommissionSplits(async cols => {
      calls.push(cols);
      return cols.includes("cutoff_day") ? { data: null, error: missing } : { data: [split("2026-04-01")], error: null };
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain("cutoff_day");
    expect(out.hasCutoff).toBe(false);
    expect(out.splits[0].cutoff_day).toBeNull();
  });

  it("does not retry other errors, and keeps cutoff_day when the column exists", async () => {
    await expect(fetchCommissionSplits(async () => ({ data: null, error: { code: "42501", message: "denied" } }))).rejects.toMatchObject({ code: "42501" });
    const out = await fetchCommissionSplits(async () => ({ data: [split("2026-11-01", { cutoff_day: 20 })], error: null }));
    expect(out).toMatchObject({ hasCutoff: true });
    expect(out.splits[0].cutoff_day).toBe(20);
  });
});
