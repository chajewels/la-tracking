import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import GeoBreakdown from "@/components/dashboard/GeoBreakdown";
import type { DbCustomer } from "@/hooks/use-supabase-data";

const customer = (id: string, full_name: string, customer_code: string, location: string) =>
  ({ id, full_name, customer_code, location }) as unknown as DbCustomer;

const account = (customer_id: string) => ({
  status: "active",
  customer_id,
  currency: "PHP",
  remaining_balance: 1000,
  is_test: false,
});

describe("GeoBreakdown — Uncategorized customer links", () => {
  const customers = [
    customer("c-nagoya", "Carolyne Ikema", "CJ-2026-06912", "Nagoya"),
    customer("c-japan", "Japan Customer", "CJ-2026-00001", "Japan"),
  ];
  const accounts = [account("c-nagoya"), account("c-nagoya"), account("c-japan")];

  const renderIt = () =>
    render(
      <MemoryRouter>
        <GeoBreakdown accounts={accounts} customers={customers} countOnly />
      </MemoryRouter>,
    );

  it("links each Uncategorized customer to her profile with her account count", () => {
    renderIt();
    fireEvent.click(screen.getByText("Uncategorized"));
    const link = screen.getByRole("link", { name: /Carolyne Ikema/ });
    expect(link.getAttribute("href")).toBe("/customers/c-nagoya");
    expect(link.textContent).toContain("CJ-2026-06912");
    expect(link.textContent).toContain("2 accounts");
  });

  it("keeps other continents without customer links", () => {
    renderIt();
    fireEvent.click(screen.getByText("Asia"));
    expect(screen.queryByRole("link")).toBeNull();
  });
});
