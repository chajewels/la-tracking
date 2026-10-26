import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimesheetEntry, TimesheetProfile } from "@/lib/timesheetEngine";
import type { TimesheetCorrection } from "@/lib/timesheetCorrections";

/**
 * Timesheet → Consolidation corrections (owner 2026-10-26; migration 20270202100000).
 * The SQL harness (supabase/tests/timesheet-corrections) is the authority on refusals and the
 * day lock; this pins the screens: the dialog, the Consolidation cells and the My Timesheet lock.
 */

const rpc = vi.fn();
const upsert = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({ upsert: (...a: unknown[]) => upsert(...a) }),
  },
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn(), warning: vi.fn() } }));

import CorrectDayDialog from "@/components/timesheet/CorrectDayDialog";
import { ConsolidationTab, MyTimesheetTab } from "@/pages/Timesheet";
import { LOCKED_MESSAGE, changedPunchLines, correctionsByDay, correctionRefusal, isDayLockedError } from "@/lib/timesheetCorrections";
import { isoToWall, zonedWallToISO } from "@/lib/timesheetTime";

const KAILA = "u-kaila";
const prof = (over: Partial<TimesheetProfile> = {}): TimesheetProfile => ({
  id: "p", user_id: KAILA, template_type: "csr", job_title: null, timezone: "Asia/Manila", work_days: [1, 2, 3, 4, 5, 6],
  shift_start: null, shift_end: null, basic_salary: 13500, allowance: 2000, half_day_rate: null, full_day_rate: null,
  full_day_threshold_hours: null, dayoff_divisor: 4, active: true, ...over,
});
const entry = (date: string, amIn: string | null, pmOut: string | null = null): TimesheetEntry =>
  ({ work_date: date, am_in: amIn, am_out: null, pm_in: null, pm_out: pmOut });
const corr = (over: Partial<TimesheetCorrection>): TimesheetCorrection => ({
  id: "c1", user_id: KAILA, work_date: "2026-10-20",
  old_punches: { am_in: "2026-10-20T01:00:00.000Z", am_out: null, pm_in: null, pm_out: null },
  new_punches: { am_in: "2026-10-20T02:00:00.000Z", am_out: null, pm_in: null, pm_out: null },
  comment: "Started at 10, not 9", corrected_by: "u-brenda", corrected_by_name: "Brendalyn Bumagat",
  corrected_at: "2026-10-21T03:00:00Z", ...over,
});

const mount = (ui: JSX.Element) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  rpc.mockReset();
  upsert.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe("time helpers (moved, unchanged)", () => {
  it("compose and read wall time in the profile timezone", () => {
    expect(zonedWallToISO("2026-10-20", "09:00", "Asia/Manila")).toBe("2026-10-20T01:00:00.000Z");
    expect(zonedWallToISO("2026-10-20", "09:00", "Asia/Tokyo")).toBe("2026-10-20T00:00:00.000Z");
    expect(isoToWall("2026-10-20T01:00:00.000Z", "Asia/Manila")).toBe("09:00");
    expect(isoToWall(null, "Asia/Manila")).toBe("");
  });
});

describe("correction rules", () => {
  it("lists only the punches that changed, old → new", () => {
    expect(changedPunchLines(corr({}), "Asia/Manila")).toEqual(["AM in 09:00 → 10:00"]);
    expect(changedPunchLines(corr({ new_punches: { am_in: "2026-10-20T01:00:00.000Z", am_out: null, pm_in: null, pm_out: "2026-10-20T10:00:00.000Z" } }), "Asia/Manila"))
      .toEqual(["PM out — → 18:00"]);
  });

  it("groups by (user, day), newest first", () => {
    const m = correctionsByDay([corr({ id: "old", corrected_at: "2026-10-21T01:00:00Z" }), corr({ id: "new", corrected_at: "2026-10-22T01:00:00Z" })]);
    expect(m.get(`${KAILA}|2026-10-20`)?.map(c => c.id)).toEqual(["new", "old"]);
  });

  it("refusals in plain English; day_locked recognised", () => {
    for (const c of ["permission_denied", "comment_required", "invalid_date", "invalid_punch", "invalid_order", "save_failed", "x"]) {
      expect(correctionRefusal(c)).not.toMatch(/_/);
    }
    expect(isDayLockedError({ message: "day_locked" })).toBe(true);
    expect(isDayLockedError({ message: "other" })).toBe(false);
  });
});

describe("Correct day dialog", () => {
  const open = (over: Partial<Parameters<typeof CorrectDayDialog>[0]> = {}) => {
    const onSaved = vi.fn();
    mount(<CorrectDayDialog open onClose={() => {}} onSaved={onSaved} staffName="Kaila Cruz" profile={prof()} workDate="2026-10-20"
      entry={{ work_date: "2026-10-20", am_in: "2026-10-20T01:00:00.000Z", am_out: "2026-10-20T04:00:00.000Z", pm_in: "2026-10-20T05:00:00.000Z", pm_out: null }}
      history={[]} {...over} />);
    return onSaved;
  };

  it("title, and punches pre-filled in the staff member's timezone", () => {
    open();
    expect(screen.getByText("Correct day — Kaila Cruz, 20 Oct 2026")).toBeInTheDocument();
    expect((screen.getByLabelText("AM in") as HTMLInputElement).value).toBe("09:00");
    expect((screen.getByLabelText("PM in") as HTMLInputElement).value).toBe("13:00");
    expect((screen.getByLabelText("PM out") as HTMLInputElement).value).toBe("");
  });

  it("pre-fills in a non-Manila profile timezone too", () => {
    open({ profile: prof({ timezone: "Asia/Tokyo" }) });
    expect((screen.getByLabelText("AM in") as HTMLInputElement).value).toBe("10:00");
  });

  it("previews hours and daily pay with the same rules, incl. a midnight PM out", () => {
    open();
    fireEvent.change(screen.getByLabelText("PM out"), { target: { value: "00:00" } });
    // (24 − 9) − (13 − 12) = 14 h; CSR full day = 13,500 / 27 = ₱500
    expect(screen.getByTestId("correct-preview")).toHaveTextContent("Hours 14 · Daily pay ₱500");
    fireEvent.change(screen.getByLabelText("PM out"), { target: { value: "14:00" } });
    // 3 h morning + 1 h afternoon = 4 h → half day ₱400
    expect(screen.getByTestId("correct-preview")).toHaveTextContent("Hours 4 · Daily pay ₱400");
  });

  it("needs a change AND a reason of 3+ characters, then saves with the composed instants", async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const onSaved = open();
    const save = screen.getByTestId("correct-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("PM out"), { target: { value: "18:00" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason for correction"), { target: { value: "ab" } });
    expect(save).toBeDisabled();
    expect(screen.getByText(/at least 3 characters/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason for correction"), { target: { value: "  Forgot to punch out  " } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("correct_timesheet_day", {
      p_user_id: KAILA, p_work_date: "2026-10-20",
      p_am_in: "2026-10-20T01:00:00.000Z", p_am_out: "2026-10-20T04:00:00.000Z",
      p_pm_in: "2026-10-20T05:00:00.000Z", p_pm_out: "2026-10-20T10:00:00.000Z",
      p_comment: "Forgot to punch out",
    });
  });

  it("a refusal shows plain English and keeps the dialog", async () => {
    rpc.mockResolvedValue({ data: { error: "invalid_order" }, error: null });
    const onSaved = open();
    fireEvent.change(screen.getByLabelText("PM out"), { target: { value: "12:30" } });
    fireEvent.change(screen.getByLabelText("Reason for correction"), { target: { value: "Fix" } });
    fireEvent.click(screen.getByTestId("correct-save"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("The times must be in order: AM in, AM out, PM in, PM out."));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("shows the history newest first: when, who, old → new, comment", () => {
    open({ history: [
      corr({ id: "b", corrected_at: "2026-10-22T03:00:00Z", comment: "Second fix", corrected_by_name: "Cynthia Largo" }),
      corr({ id: "a" }),
    ] });
    const items = within(screen.getByTestId("correct-history")).getAllByTestId("correct-history-item");
    expect(items[0]).toHaveTextContent("22 Oct 2026, 11:00 PHT · Cynthia Largo");
    expect(items[0]).toHaveTextContent("Second fix");
    expect(items[1]).toHaveTextContent("AM in 09:00 → 10:00");
    expect(items[1]).toHaveTextContent("Started at 10, not 9");
  });
});

describe("Consolidation cells", () => {
  const base = {
    profiles: [prof()],
    entriesByUser: new Map([[KAILA, [entry("2026-10-20", "2026-10-20T01:00:00.000Z", "2026-10-20T10:00:00.000Z")]]]),
    nameByUser: new Map([[KAILA, "Kaila Cruz"]]),
    monthKey: "2026-10",
    onMonthChange: () => {},
    corrections: [corr({})],
  };

  it("Admin / Brenda: every day cell is a button; corrected cells carry a marker; it opens the dialog", () => {
    mount(<ConsolidationTab {...base} canCorrect />);
    expect(screen.getAllByLabelText("Corrected")).toHaveLength(1);
    const buttons = screen.getAllByRole("button", { name: "Correct Kaila Cruz, 2026-10-20" });
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[0]);
    expect(screen.getByText("Correct day — Kaila Cruz, 20 Oct 2026")).toBeInTheDocument();
    expect(screen.getByTestId("correct-history")).toHaveTextContent("Started at 10, not 9");
  });

  it("anyone else: read-only (no buttons), marker still shown", () => {
    mount(<ConsolidationTab {...base} />);
    expect(screen.queryAllByRole("button", { name: /^Correct / })).toHaveLength(0);
    expect(screen.getAllByLabelText("Corrected")).toHaveLength(1);
  });
});

describe("My Timesheet lock", () => {
  const tab = (corrections: TimesheetCorrection[]) => mount(
    <MyTimesheetTab profile={prof()} entries={[entry("2026-10-20", "2026-10-20T02:00:00.000Z"), entry("2026-10-21", null)]}
      monthKey="2026-10" onMonthChange={() => {}} onEntrySaved={() => {}} userId={KAILA} corrections={corrections} />,
  );

  it("a corrected day shows who, when and the latest comment, and its punches are locked", () => {
    tab([corr({}), corr({ id: "older", corrected_at: "2026-10-20T03:00:00Z", comment: "first try" })]);
    const note = screen.getByTestId("my-correction");
    expect(note).toHaveTextContent("Corrected by Brendalyn Bumagat on 21 Oct 2026: Started at 10, not 9");
    expect(note).toHaveTextContent(LOCKED_MESSAGE);
    const row = note.previousElementSibling as HTMLElement;
    for (const sel of within(row).getAllByRole("combobox")) expect(sel).toBeDisabled();
    expect(within(row).getByTitle(LOCKED_MESSAGE)).toBeDisabled(); // paste
    expect(within(row).getByLabelText("Corrected")).toBeInTheDocument();
  });

  it("an uncorrected day stays editable; a database day_locked refusal shows the same message", async () => {
    upsert.mockResolvedValue({ error: { message: "day_locked" } });
    tab([corr({})]);
    const rows = screen.getAllByRole("row");
    const oct21 = rows.find(r => r.querySelector("td")?.textContent?.trim() === "21") as HTMLElement;
    const [hour, minute] = within(oct21).getAllByRole("combobox");
    expect(hour).toBeEnabled();
    fireEvent.change(hour, { target: { value: "09" } });
    fireEvent.change(minute, { target: { value: "00" } });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(LOCKED_MESSAGE));
  });
});
