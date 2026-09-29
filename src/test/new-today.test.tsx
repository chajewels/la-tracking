import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { isCreatedTodayPHT, phtStartOfTodayISO } from "@/lib/new-today";

/**
 * Dashboard "New Accounts Today" (2026-09-29, owner report): the buttons went
 * to the Customers directory, and "today" started at the BROWSER's midnight.
 */

vi.mock("@/hooks/useNewLayawayTodayCount", () => ({ useNewLayawayTodayCount: () => ({ count: 1 }) }));
vi.mock("@/hooks/useNewCashOrdersTodayCount", () => ({ useNewCashOrdersTodayCount: () => ({ count: 2 }) }));

import NewAccountsTodayAlert from "@/components/dashboard/NewAccountsTodayAlert";

describe("today is the PHT day", () => {
  it("starts at PHT midnight, whatever the browser's zone", () => {
    // 2026-09-29 10:30 JST = 09:30 PHT → PHT day starts 2026-09-28T16:00Z.
    const now = new Date("2026-09-29T01:30:00Z");
    expect(phtStartOfTodayISO(now)).toBe("2026-09-28T16:00:00.000Z");
  });

  it("23:30 JST is still the same PHT day (22:30 PHT)", () => {
    const now = new Date("2026-09-29T14:30:00Z");
    expect(phtStartOfTodayISO(now)).toBe("2026-09-28T16:00:00.000Z");
  });

  it("an order made at 23:30 PHT yesterday is not new today", () => {
    const now = new Date("2026-09-29T01:30:00Z");
    expect(isCreatedTodayPHT("2026-09-28T15:30:00Z", now)).toBe(false);
    expect(isCreatedTodayPHT("2026-09-28T16:05:00Z", now)).toBe(true);
    expect(isCreatedTodayPHT(null, now)).toBe(false);
  });
});

describe("New Accounts Today buttons", () => {
  it("open the Sales lists filtered to today's new ones, never the Customers directory", () => {
    render(<MemoryRouter><NewAccountsTodayAlert /></MemoryRouter>);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/sales?tab=layaway&new=today", "/sales?tab=cash&new=today"]);
    expect(screen.getByText("3 new")).toBeInTheDocument();
  });
});
