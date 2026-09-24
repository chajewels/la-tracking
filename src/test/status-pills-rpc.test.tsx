import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// The sidebar's "Email status unknown" / "Portal link status unknown" pills
// were permanently unknown: the hooks called supabase.rpc DETACHED, and
// supabase-js's rpc() reads this.rest, so every call threw before a request
// went out. This mock's rpc() needs `this` exactly like the real client.
const calls: string[] = [];
vi.mock("@/integrations/supabase/client", () => {
  class FakeClient {
    rest = {
      rpc: async (fn: string) => {
        calls.push(fn);
        if (fn === "email_delivery_report") return { data: { status: "ok", last_sent_at: null }, error: null };
        if (fn === "portal_token_expiry_report") return { data: { status: "ok", expiring_in_window: 0 }, error: null };
        return { data: [], error: null };
      },
    };
    rpc(fn: string) { return this.rest.rpc(fn); }
  }
  return { supabase: new FakeClient() };
});

import { EmailHealthPill } from "@/components/system/EmailHealthIndicator";
import { PortalTokenPill } from "@/components/system/PortalTokenIndicator";
import { supabase } from "@/integrations/supabase/client";

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);

describe("sidebar status pills reach their RPCs", () => {
  it("the mock behaves like supabase-js: a detached rpc() throws", async () => {
    const detached = (supabase as unknown as { rpc: (fn: string) => unknown }).rpc;
    expect(() => detached("email_delivery_report")).toThrow(/reading 'rest'/);
  });

  it("the email pill shows the real status, not 'unknown'", async () => {
    wrap(<EmailHealthPill />);
    await waitFor(() => expect(screen.getByText("Email OK")).toBeInTheDocument());
    expect(screen.queryByText("Email status unknown")).not.toBeInTheDocument();
    expect(calls).toContain("email_delivery_report");
  });

  it("the portal-link pill shows the real status, not 'unknown'", async () => {
    wrap(<PortalTokenPill />);
    await waitFor(() => expect(screen.getByText("Portal links OK")).toBeInTheDocument());
    expect(screen.queryByText("Portal link status unknown")).not.toBeInTheDocument();
    expect(calls).toContain("portal_token_expiry_report");
  });

  it("no hook detaches a client method again", () => {
    for (const f of ["src/hooks/useEmailHealth.ts", "src/hooks/usePortalTokenHealth.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/=\s*supabase\.rpc\b/);
    }
  });
});
