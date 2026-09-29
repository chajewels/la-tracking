import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Dashboard Loyalty Redemptions KPI (owner report 2026-09-29): the card read
 * "—" because the query filtered on a status the enum does not have
 * ('voided'), and it counted rows. It now sums POINTS of CONFIRMED redemptions
 * per PHT month.
 */

const calls: { method: string; args: unknown[] }[] = [];
let rows: { points_redeemed: number; created_at: string }[] = [];

vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "gte", "eq", "not", "in"]) {
    chain[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return chain; };
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
  return { supabase: { from: () => chain } };
});

import { useRedemptionsKpi } from "@/hooks/useDashboardExtras";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("Loyalty Redemptions KPI", () => {
  it("sums points of confirmed redemptions this PHT month, and never filters on a status the enum lacks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T10:00:00Z"));
    rows = [
      { points_redeemed: 100_000, created_at: "2026-09-10T00:00:00Z" },
      { points_redeemed: 19_520, created_at: "2026-09-28T12:00:00Z" },
      // 23:30 PHT on Aug 31 is still August.
      { points_redeemed: 104_290, created_at: "2026-08-31T15:30:00Z" },
      // 00:30 PHT on Sep 1 is September.
      { points_redeemed: 500, created_at: "2026-08-31T16:30:00Z" },
    ];
    const { result } = renderHook(() => useRedemptionsKpi(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.thisMonthPoints).toBe(120_020);
    expect(result.current.data?.thisMonthCount).toBe(3);
    expect(result.current.data?.lastMonthPoints).toBe(104_290);
    expect(result.current.data?.series).toHaveLength(6);
    expect(calls).toContainEqual({ method: "eq", args: ["status", "confirmed"] });
    expect(JSON.stringify(calls)).not.toContain("voided");
    vi.useRealTimers();
  });
});
