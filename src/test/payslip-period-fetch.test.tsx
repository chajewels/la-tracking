import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimesheetProfile } from "@/lib/timesheetEngine";

/** The payslip commission loads the commission PERIOD of the pay month (docs/COMMISSIONS.md). */

let splits: Record<string, unknown>[] = [];
let columnExists = true;
const salesRange: { gte?: string; lte?: string }[] = [];
const SPLIT = { closer_pct: 30, processor_pct: 20, coordinator_pct: 0, support_pct: 15, verifier_pct: 15,
  top_sales_pct: 15, top_sales_2_pct: 5, merge_groups: [], pool_per_item_php: 200 };

function query(table: string) {
  const rec: { gte?: string; lte?: string } = {};
  let cols = "";
  const result = () => {
    if (table === "commission_splits") {
      if (cols.includes("cutoff_day") && !columnExists) {
        return { data: null, error: { code: "42703", message: "column commission_splits.cutoff_day does not exist" } };
      }
      return { data: columnExists ? splits : splits.map(({ cutoff_day: _c, ...r }) => r), error: null };
    }
    return { data: [], error: null };
  };
  const q: Record<string, unknown> = {};
  q.select = (c: string) => { cols = c; return q; };
  q.gte = (_c: string, v: string) => { rec.gte = v; return q; };
  q.lte = (_c: string, v: string) => { rec.lte = v; return q; };
  q.order = () => q;
  q.range = async () => { if (table === "sales_log") salesRange.push(rec); return result(); };
  q.then = (res: (v: unknown) => unknown) => res(result());
  return q;
}
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async (name: string) => (name === "get_payslip_book"
      ? { data: { ok: true, month: "2026-09-01", can_manage: true, php_jpy_rate: "0.42", payslips: [], details: [] }, error: null }
      : { data: null, error: null }),
    from: (t: string) => query(t),
    storage: { from: () => ({}) },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import PayslipsTab from "@/components/timesheet/PayslipsTab";

const prof: TimesheetProfile = {
  id: "u1", user_id: "u1", template_type: "csr", job_title: null, timezone: "Asia/Manila", work_days: [1, 2, 3, 4, 5, 6],
  shift_start: null, shift_end: null, basic_salary: 12000, allowance: 2000, half_day_rate: null, full_day_rate: null,
  full_day_threshold_hours: null, dayoff_divisor: 4, active: true,
};

async function fetchedFor(monthKey: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PayslipsTab profiles={[prof]} entriesByUser={new Map()} nameByUser={new Map([["u1", "Kaila Cruz"]])}
        monthKey={monthKey} onMonthChange={() => {}} monthOptions={[monthKey]} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("payslips-table");
  await waitFor(() => expect(salesRange).toHaveLength(1));
  return salesRange[0];
}

beforeEach(() => {
  salesRange.length = 0;
  columnExists = true;
  splits = [{ month: "2026-04-01", ...SPLIT, cutoff_day: null }, { month: "2026-11-01", ...SPLIT, cutoff_day: 20 }];
});

describe("payslip commission period fetch", () => {
  it("December 2026 (Nov cut-off 20) fetches Nov 21 - Dec 20", async () => {
    expect(await fetchedFor("2026-12")).toEqual({ gte: "2026-11-21", lte: "2026-12-20" });
  });
  it("November 2026 fetches Nov 1 - Nov 20", async () => {
    expect(await fetchedFor("2026-11")).toEqual({ gte: "2026-11-01", lte: "2026-11-20" });
  });
  it("October 2026 fetches the calendar month", async () => {
    expect(await fetchedFor("2026-10")).toEqual({ gte: "2026-10-01", lte: "2026-10-31" });
  });
  it("a month with a null cut-off fetches the calendar month", async () => {
    splits = [{ month: "2026-04-01", ...SPLIT, cutoff_day: null }];
    expect(await fetchedFor("2026-12")).toEqual({ gte: "2026-12-01", lte: "2026-12-31" });
  });
  it("no cutoff_day column (migration not applied) fetches the calendar month", async () => {
    columnExists = false;
    expect(await fetchedFor("2026-11")).toEqual({ gte: "2026-11-01", lte: "2026-11-30" });
  });
});
