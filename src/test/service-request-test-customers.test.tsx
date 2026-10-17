import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * Bell, badge and queue agree on test customers (docs/SERVICE-REQUESTS.md,
 * docs/FIXED-BUGS.md 2026-10-17). A test customer's request rang the bell,
 * lit the badge, and was missing from the queue the bell linked to.
 */

// One recording builder stands in for serviceRequests(): every chained call is
// logged, and awaiting the chain resolves to whatever the test set.
type Call = [string, unknown[]];
let calls: Call[] = [];
let result: Record<string, unknown> = {};
function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq", "order"]) {
    b[m] = (...args: unknown[]) => { calls.push([m, args]); return b; };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}

vi.mock("@/components/services/service-request-types", async (orig) => ({
  ...(await orig<typeof import("@/components/services/service-request-types")>()),
  serviceRequests: () => builder(),
}));
vi.mock("@/components/services/ServiceRequestDrawer", () => ({
  default: ({ request }: { request: { item_title: string } | null }) =>
    request ? <div data-testid="drawer">{request.item_title}</div> : null,
}));
vi.mock("@/components/services/LinkedJobCell", () => ({ default: () => null }));

import { useServiceRequestCount } from "@/hooks/useServiceRequestCount";
import ServiceRequestsTab from "@/components/services/ServiceRequestsTab";

const row = (over: Record<string, unknown> = {}) => ({
  id: "r1", customer_id: "c1", cash_order_id: null, layaway_account_id: null, service_job_id: null,
  item_title: "Gold ring", kind: "resize", details: "Make it 7", ring_size: "7", status: "requested",
  staff_note: null, customer_note: null, created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z",
  customers: { id: "c1", full_name: "Ana Real", is_test: false }, cash_orders: null, layaway_accounts: null,
  service_jobs: null, ...over,
});

function Search() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function mountTab(url: string, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <ServiceRequestsTab />
        <Search />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  result = {};
});

describe("sidebar badge count", () => {
  it("inner-joins customers and counts only non-test open requests", async () => {
    result = { count: 2, error: null };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result: hook } = renderHook(() => useServiceRequestCount(), { wrapper });
    await waitFor(() => expect(hook.current.count).toBe(2));

    expect(calls).toEqual([
      ["select", ["id, customers!inner(is_test)", { count: "exact", head: true }]],
      ["in", ["status", ["requested", "received", "in_progress"]]],
      ["eq", ["customers.is_test", false]],
    ]);
  });
});

describe("queue deep link ?open=", () => {
  it("opens the named request and strips the deep-link params", async () => {
    result = { data: [row()], error: null };
    mountTab("/services?tab=requests&open=r1&convert=1&fee=3000");
    expect(await screen.findByTestId("drawer")).toHaveTextContent("Gold ring");
    expect(screen.queryByText(/not in this queue/)).toBeNull();
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe("?tab=requests"));
  });

  it("a test customer's request is not in the queue: says so, strips the params, opens nothing", async () => {
    result = { data: [row(), row({ id: "r-test", customers: { id: "c9", full_name: "Test", is_test: true } })], error: null };
    mountTab("/services?tab=requests&open=r-test&convert=1&fee=3000&return=/orders");
    expect(await screen.findByText("That request is not in this queue (test customer or removed).")).toBeInTheDocument();
    expect(screen.queryByTestId("drawer")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe("?tab=requests"));
  });

  it("an empty queue still answers instead of waiting forever", async () => {
    result = { data: [], error: null };
    mountTab("/services?tab=requests&open=gone");
    expect(await screen.findByText(/not in this queue/)).toBeInTheDocument();
  });

  it("does not call a fresh request missing off a stale cache — waits for the refetch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["service-requests"], [row()]); // cached before r2 existed
    result = { data: [row({ id: "r2", item_title: "New bangle" }), row()], error: null };
    mountTab("/services?tab=requests&open=r2", client);
    expect(await screen.findByTestId("drawer")).toHaveTextContent("New bangle");
    expect(screen.queryByText(/not in this queue/)).toBeNull();
  });
});
