import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Staff bell emails (V11b) + bounce bell (V13), owner decisions 2026-10-08.
 * The SQL is the authority (development/sql/staff-bell-emails-acceptance.sql);
 * this file pins the Hub card and the words.
 */

const rpc = vi.fn();
let roles: string[] = ["admin"];
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles }) }));
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: unknown[]) => toastSpy(...a) }));

import { StaffBellEmailsCard } from "@/components/settings/StaffBellEmailsCard";
import { invalidAddresses, parseAddresses, staffBellEmailsRefusal } from "@/components/settings/staff-bell-emails";

type State = Record<string, unknown>;
let state: State;
const base = (over: State = {}): State => ({
  found: true,
  types: ["card_refund_after_credit", "email_bounced"],
  addresses: ["bumagatbrenda@gmail.com"],
  roles: ["admin"],
  resolved_recipients: ["bumagatbrenda@gmail.com", "sales@chajewelsjp.com"],
  can_change: true, updated_at: "2026-10-08T09:00:00Z", updated_by_name: "Cynthia",
  sent_7d: 2, pending: 0, failed_7d: 0, ...over,
});
const mount = (ui: JSX.Element) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  roles = ["admin"];
  state = base();
  rpc.mockReset();
  toastSpy.mockReset();
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "get_staff_bell_emails") return { data: state, error: null };
    if (name === "set_staff_bell_emails") {
      state = { ...state, types: args.p_types, addresses: args.p_addresses, roles: args.p_roles };
      return { data: { ok: true, changed: true, resolved_recipients: ["bumagatbrenda@gmail.com"] }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
});

describe("words", () => {
  it("addresses: one per line or comma, lower-cased, de-duplicated; invalid ones named", () => {
    expect(parseAddresses("Brenda@Example.com\n a@b.co, brenda@example.com")).toEqual(["brenda@example.com", "a@b.co"]);
    expect(invalidAddresses(["a@b.co", "nope", "@domain.com"])).toEqual(["nope", "@domain.com"]);
    expect(staffBellEmailsRefusal("permission_denied")).toMatch(/admin/);
    expect(staffBellEmailsRefusal("invalid_address", "x")).toMatch(/x/);
  });
});

describe("Website → Settings → Staff bell emails card", () => {
  it("shows who is emailed, the counts, and the ticked types", async () => {
    mount(<StaffBellEmailsCard />);
    expect(await screen.findByTestId("staff-bell-emails-state")).toHaveTextContent("2 bell types emailed");
    expect(screen.getByTestId("staff-bell-emails-summary")).toHaveTextContent(/bumagatbrenda@gmail.com, sales@chajewelsjp.com/);
    expect(screen.getByTestId("staff-bell-emails-summary")).toHaveTextContent(/2 sent in the last 7 days/);
    expect(screen.getByLabelText(/card_refund_after_credit/)).toBeChecked();
    expect(screen.getByLabelText(/card_refund_pending/)).not.toBeChecked();
  });

  it("an admin ticks a type and saves: the RPC gets types, addresses and roles", async () => {
    mount(<StaffBellEmailsCard />);
    fireEvent.click(await screen.findByLabelText(/card_refund_pending/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_staff_bell_emails", {
      p_types: ["card_refund_after_credit", "email_bounced", "card_refund_pending"],
      p_addresses: ["bumagatbrenda@gmail.com"],
      p_roles: ["admin"],
    }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Staff bell emails saved" })));
  });

  it("a bad address blocks Save and is named", async () => {
    mount(<StaffBellEmailsCard />);
    const ta = await screen.findByLabelText(/Extra addresses/);
    fireEvent.change(ta, { target: { value: "bumagatbrenda@gmail.com\nnot-an-email" } });
    expect(screen.getByTestId("staff-bell-emails-address-error")).toHaveTextContent("not-an-email");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("a non-admin sees the state but cannot change it", async () => {
    roles = ["staff"];
    state = base({ can_change: false });
    mount(<StaffBellEmailsCard />);
    expect(await screen.findByTestId("staff-bell-emails-readonly")).toHaveTextContent(/Only an admin/);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByLabelText(/card_refund_after_credit/)).toBeDisabled();
  });

  it("a refusal from the server is shown in words, nothing saved", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_staff_bell_emails") return { data: state, error: null };
      return { data: { error: "permission_denied" }, error: null };
    });
    mount(<StaffBellEmailsCard />);
    fireEvent.click(await screen.findByLabelText(/card_refund_pending/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Not changed", description: expect.stringMatching(/admin/) })));
  });
});

describe("the card is mounted for admins only, on Website → Settings", () => {
  it("source", () => {
    const src = readFileSync("src/pages/Website.tsx", "utf8");
    expect(src).toMatch(/\{isAdmin && \([\s\S]{0,200}<StaffBellEmailsCard \/>/);
  });
});
