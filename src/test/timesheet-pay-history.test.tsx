import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import cholita from "@/test/fixtures/april-2026-cholita.json";
import cris from "@/test/fixtures/may-2026-cris-midnight.json";
import {
  ALLOWANCE_ABSENCE_RULE_FROM, computeAllMonthsSummary, computeMonth, dailyHours, isoDowOf, payProfileForMonth, paySettingFor, profilesForMonth,
  timesheetDatesOf,
  type PaySetting, type TimesheetEntry, type TimesheetProfile,
} from "@/lib/timesheetEngine";
import { buildTimesheetFigures } from "@/lib/payslips";
import { paySettingRefusal, timesheetMonthOptions } from "@/lib/timesheetPaySettings";

/**
 * Pay settings history + April–May 2026 + inactive staff in past months (owner 2026-10-27;
 * migration 20270204100000). The SQL harness (supabase/tests/payslips, phase 2) is the authority on
 * set_timesheet_pay_setting; this pins the engine and the screens.
 */

const rpc = vi.fn();
const update = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({
      update: (...a: unknown[]) => { update(...a); return { eq: async () => ({ error: null }) }; },
      upsert: async () => ({ error: null }),
    }),
  },
}));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { AssignmentDialog, ConsolidationTab, CostMasterTab } from "@/pages/Timesheet";

const prof = (over: Partial<TimesheetProfile> = {}): TimesheetProfile => ({
  id: "p", user_id: "u-brenda", template_type: "csr", job_title: null, timezone: "Asia/Manila", work_days: [1, 2, 3, 4, 5, 6],
  shift_start: null, shift_end: null, basic_salary: 15000, allowance: 6000, half_day_rate: null, full_day_rate: null,
  full_day_threshold_hours: null, dayoff_divisor: 4, active: true, ...over,
});
const SETTINGS: PaySetting[] = [
  { user_id: "u-brenda", effective_from: "2026-04-01", basic_salary: null, allowance: 4000 },
  { user_id: "u-brenda", effective_from: "2026-06-01", basic_salary: 15000, allowance: 6000 },
];
const fullMonth = (monthKey: string, userId = "u-brenda"): (TimesheetEntry & { user_id: string })[] => {
  const out: (TimesheetEntry & { user_id: string })[] = [];
  // Every non-Sunday of the 31-row window (spillover days included), so no week is forfeited.
  for (const date of timesheetDatesOf(monthKey)) {
    if (isoDowOf(date) === 7) continue;
    out.push({ user_id: userId, work_date: date, am_in: `${date}T09:00:00+08:00`, am_out: null, pm_in: null, pm_out: `${date}T17:00:00+08:00` });
  }
  return out;
};

describe("pay settings in force", () => {
  it("the same profile pays ₱4,000 allowance in May and ₱6,000 in June", () => {
    const p = prof();
    expect(payProfileForMonth(p, "2026-05", SETTINGS).allowance).toBe(4000);
    expect(payProfileForMonth(p, "2026-06", SETTINGS).allowance).toBe(6000);
    expect(payProfileForMonth(p, "2026-05", SETTINGS).basic_salary).toBe(15000); // null field → profile
    expect(computeMonth("2026-05", fullMonth("2026-05"), p, SETTINGS).allowance_paid).toBe(4000);
    expect(computeMonth("2026-06", fullMonth("2026-06"), p, SETTINGS).allowance_paid).toBe(6000);
  });

  it("before any row applies, and when the table is missing, the profile values are used", () => {
    const p = prof();
    expect(paySettingFor("u-brenda", "2026-03", SETTINGS)).toBeNull();
    expect(payProfileForMonth(p, "2026-03", SETTINGS)).toBe(p);
    expect(computeMonth("2026-05", fullMonth("2026-05"), p).allowance_paid).toBe(6000);
    expect(computeMonth("2026-05", fullMonth("2026-05"), p, []).allowance_paid).toBe(6000);
    expect(paySettingFor("someone-else", "2026-05", SETTINGS)).toBeNull();
  });

  it("Full Summary uses the settings of each month, and counts inactive staff only where they have entries", () => {
    const inactive = prof({ user_id: "u-cris", active: false, basic_salary: 12000, allowance: 2000 });
    const entries = [...fullMonth("2026-05"), ...fullMonth("2026-06"), ...fullMonth("2026-05", "u-cris")];
    const s = computeAllMonthsSummary([prof(), inactive], entries, SETTINGS);
    const may = s.rows.find(r => r.monthKey === "2026-05")!;
    const june = s.rows.find(r => r.monthKey === "2026-06")!;
    const brendaMay = computeMonth("2026-05", fullMonth("2026-05"), prof(), SETTINGS).net;
    const crisMay = computeMonth("2026-05", fullMonth("2026-05", "u-cris"), inactive).net;
    expect(may.csr).toBeCloseTo(brendaMay + crisMay, 6);
    expect(june.csr).toBeCloseTo(computeMonth("2026-06", fullMonth("2026-06"), prof(), SETTINGS).net, 6);
  });
});

describe("engine fidelity fixtures (no live data)", () => {
  it("Cholita, April 2026: basic ₱16,800, allowance ₱4,000, net ₱20,800, 162 hours", () => {
    const p = cholita.profile as TimesheetProfile;
    const settings = cholita.settings as PaySetting[];
    const inForce = payProfileForMonth(p, cholita.monthKey, settings);
    const m = computeMonth(cholita.monthKey, cholita.entries as TimesheetEntry[], p, settings);
    const f = buildTimesheetFigures("csr", m, inForce) as unknown as Record<string, number>;
    expect(inForce.basic_salary).toBe(cholita.expected.basic_salary);
    expect(f.monthly_allowance).toBe(cholita.expected.allowance);
    expect(f.allowance_paid).toBe(4000);
    expect(f.capped_gross).toBe(cholita.expected.capped_gross);
    expect(f.net).toBe(cholita.expected.net);
    expect(f.total_hours).toBe(cholita.expected.total_hours);
    expect(f.days_worked).toBe(cholita.expected.days_worked);
  });

  it("Cris-style May: 00:00 PM out reads as midnight (6.00 / 8.00 h); a paper-sheet month forfeits nothing", () => {
    const p = cris.profile as TimesheetProfile;
    const entries = cris.entries as TimesheetEntry[];
    expect(dailyHours(entries[0], "Asia/Manila")).toBe(6);
    expect(dailyHours(entries[1], "Asia/Manila")).toBe(8);
    const m = computeMonth(cris.monthKey, entries, p, cris.settings as PaySetting[]);
    expect(m.forfeitedWeeks).toBe(cris.expected.forfeited_weeks);
    expect(m.allowance_paid).toBe(cris.expected.allowance_paid);
    // The owner's real May allowance (₱2,000) is a May pay setting, paid as is.
    const withMay = [...(cris.settings as PaySetting[]), { user_id: "u-cris", effective_from: "2026-05-01", basic_salary: null, allowance: 2000 }];
    const may = computeMonth(cris.monthKey, entries, p, withMay);
    expect(may.forfeitedWeeks).toBe(0);
    expect(may.allowance_paid).toBe(2000);
  });

  it("the absence rule starts in June 2026: the same pattern a month later forfeits 2 weeks", () => {
    expect(ALLOWANCE_ABSENCE_RULE_FROM).toBe("2026-06");
    const p = cris.profile as TimesheetProfile;
    // Shift the May pattern to June (1-16 June worked, then nothing).
    const june = (cris.entries as TimesheetEntry[]).map(e => {
      const shift = (s: string | null) => (s ? s.replace("2026-05-", "2026-06-") : s);
      return { ...e, work_date: shift(e.work_date)!, am_in: shift(e.am_in), am_out: shift(e.am_out), pm_in: shift(e.pm_in), pm_out: shift(e.pm_out) };
    }).filter(e => e.work_date <= "2026-06-30");
    const m = computeMonth("2026-06", june, { ...p, allowance: 4000 }, []);
    expect(m.forfeitedWeeks).toBeGreaterThanOrEqual(cris.expected.rule_forfeited_weeks);
    expect(m.allowance_paid).toBeLessThan(4000);
  });
});

describe("inactive staff and April–May", () => {
  it("inactive staff appear only in months with entries in the 31-row window", () => {
    const inactive = prof({ user_id: "u-cris", active: false });
    const byUser = new Map([["u-cris", [{ work_date: "2026-05-02" }]]]);
    expect(profilesForMonth([prof(), inactive], byUser, "2026-05").map(p => p.user_id)).toEqual(["u-brenda", "u-cris"]);
    expect(profilesForMonth([prof(), inactive], byUser, "2026-06").map(p => p.user_id)).toEqual(["u-brenda"]);
    // 2 May is a spillover day of April's window (1 Apr + 30 days = 1 May): not in April.
    expect(profilesForMonth([prof(), inactive], byUser, "2026-04").map(p => p.user_id)).toEqual(["u-brenda"]);
  });

  it("month pickers reach back to April 2026 and keep 12 months", () => {
    expect(timesheetMonthOptions("2026-10")).toEqual([
      "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01", "2025-12", "2025-11",
    ]);
    const later = timesheetMonthOptions("2027-09");
    expect(later[0]).toBe("2027-09");
    expect(later[later.length - 1]).toBe("2026-04");
  });

  it("Consolidation and Cost Master label an inactive staff member with entries, read-only", () => {
    const inactive = prof({ user_id: "u-cris", active: false, basic_salary: 12000, allowance: 2000 });
    const entries = new Map<string, TimesheetEntry[]>([["u-cris", fullMonth("2026-05", "u-cris")]]);
    const names = new Map([["u-brenda", "Brendalyn Bumagat"], ["u-cris", "Maria Cris de Guzman"]]);
    const qc = new QueryClient();
    const { unmount } = render(
      <QueryClientProvider client={qc}>
        <ConsolidationTab profiles={[prof(), inactive]} entriesByUser={entries} nameByUser={names} monthKey="2026-05"
          onMonthChange={() => {}} canCorrect />
      </QueryClientProvider>);
    expect(screen.getByText("(inactive)")).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /Correct Maria Cris/ })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /Correct Brendalyn/ }).length).toBeGreaterThan(0);
    unmount();
    render(
      <QueryClientProvider client={qc}>
        <CostMasterTab profiles={[prof(), inactive]} entriesByUser={entries} nameByUser={names} monthKey="2026-06"
          onMonthChange={() => {}} canMarkPaid={false} />
      </QueryClientProvider>);
    expect(screen.queryByText("Maria Cris de Guzman")).toBeNull(); // no June entries
  });

  it("refusal: payslips already issued names the month", () => {
    expect(paySettingRefusal("payslips_issued", "2026-05")).toBe("A payslip for May 2026 or later is already issued — void it first.");
    expect(paySettingRefusal("weird", "2026-05")).not.toContain("weird");
  });
});

describe("Assignments: effective month", () => {
  beforeEach(() => { rpc.mockReset(); update.mockReset(); toastError.mockReset(); });
  const staff = { user_id: "u-brenda", full_name: "Brendalyn Bumagat" };

  it("a pay change asks for the effective month and goes through set_timesheet_pay_setting", async () => {
    rpc.mockResolvedValue({ data: { ok: true, profile_synced: true }, error: null });
    render(<AssignmentDialog open onOpenChange={() => {}} staff={staff} existing={prof()} onSaved={() => {}}
      paySettings={SETTINGS} payHistoryAvailable />);
    expect(within(screen.getByTestId("pay-history")).getByText("Jun 2026")).toBeInTheDocument();
    expect(screen.queryByLabelText("Effective from (month)")).toBeNull();
    fireEvent.change(screen.getAllByRole("spinbutton")[1], { target: { value: "7000" } });
    expect(screen.getByLabelText("Effective from (month)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_timesheet_pay_setting", expect.objectContaining({
      p_user_id: "u-brenda", p_basic_salary: 15000, p_allowance: 7000,
    })));
    expect(String(rpc.mock.calls[0][1].p_effective_from)).toMatch(/^\d{4}-\d{2}-01$/);
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0]).not.toHaveProperty("allowance");
    expect(update.mock.calls[0][0]).not.toHaveProperty("basic_salary");
  });

  it("a refusal saves nothing and says which month", async () => {
    rpc.mockResolvedValue({ data: { error: "payslips_issued", month: "2026-10-01" }, error: null });
    render(<AssignmentDialog open onOpenChange={() => {}} staff={staff} existing={prof()} onSaved={() => {}}
      paySettings={SETTINGS} payHistoryAvailable />);
    fireEvent.change(screen.getAllByRole("spinbutton")[1], { target: { value: "7000" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/^A payslip for .+ or later is already issued — void it first\.$/)));
    expect(update).not.toHaveBeenCalled();
  });

  it("before the migration a pay change is a plain profile update (no effective month)", async () => {
    render(<AssignmentDialog open onOpenChange={() => {}} staff={staff} existing={prof()} onSaved={() => {}} />);
    fireEvent.change(screen.getAllByRole("spinbutton")[1], { target: { value: "7000" } });
    expect(screen.queryByLabelText("Effective from (month)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ allowance: 7000 })));
    expect(rpc).not.toHaveBeenCalled();
  });
});
