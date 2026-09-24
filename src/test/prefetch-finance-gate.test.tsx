import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The four get_daily_* RPCs refuse callers without view_finance (migration
// 20260924140200). The idle prefetcher must not fire them for such users.
const prefetchQuery = vi.fn();
let allowed = false;

vi.mock("@tanstack/react-query", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ prefetchQuery }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ session: { access_token: "t" }, user: { email: "staff@example.com" } }),
}));
vi.mock("@/contexts/PermissionsContext", () => ({
  usePermissions: () => ({ can: (k: string) => k === "view_finance" && allowed }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

const dailyKeys = ["daily-new-layaway", "daily-new-layaway-last-month", "daily-cash-orders", "daily-cash-orders-last-month"];
const prefetchedKeys = () => prefetchQuery.mock.calls.map((c) => String(c[0]?.queryKey?.[0]));

async function runPrefetch() {
  vi.resetModules();
  const { usePrefetchHeavyPages } = await import("@/hooks/usePrefetchHeavyPages");
  (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: () => void) => { cb(); return 1; };
  renderHook(() => usePrefetchHeavyPages());
}

describe("finance prefetch respects view_finance", () => {
  beforeEach(() => { prefetchQuery.mockReset(); });

  it("skips the four daily-sales RPCs without view_finance", async () => {
    allowed = false;
    await runPrefetch();
    expect(prefetchQuery).toHaveBeenCalled();
    for (const k of dailyKeys) expect(prefetchedKeys()).not.toContain(k);
  });

  it("warms them for a user who holds view_finance", async () => {
    allowed = true;
    await runPrefetch();
    for (const k of dailyKeys) expect(prefetchedKeys()).toContain(k);
  });
});
