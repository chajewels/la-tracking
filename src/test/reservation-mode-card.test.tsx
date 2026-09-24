import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readReservationMode } from "../../supabase/functions/_shared/web-reservation-rules.ts";

/**
 * Website → Settings → "Reserve-first checkout" (owner request 2026-09-24).
 *
 * What must hold, and fails silently if not: a non-admin must never get a
 * control that looks like it works; the dialog must say what the change does
 * and, when turning off, how many reservations are still waiting; the write
 * must send the state the admin SAW (p_expected) so a second admin's stale
 * click is refused rather than re-applied.
 */

const rpc = vi.fn();
let roles: string[] = ["admin"];

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles }) }));
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: unknown[]) => toastSpy(...a) }));

import { ReservationModeCard } from "@/components/website/ReservationModeCard";
import { reservationModeEffect, reservationModeRefusal } from "@/components/website/reservation-mode";

type State = Record<string, unknown>;
let state: State;
const base = (over: State = {}): State => ({
  found: true, enabled: false, raw_value: false,
  updated_at: "2026-09-24T01:00:00Z", updated_by_user_id: "u-1", updated_by_name: "Cynthia",
  can_change: true, awaiting_total: 0, ...over,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ReservationModeCard /></QueryClientProvider>);
}

beforeEach(() => {
  roles = ["admin"];
  state = base();
  rpc.mockReset();
  toastSpy.mockReset();
  rpc.mockImplementation(async (name: string, args: { p_enabled: boolean }) => {
    if (name === "get_web_reservation_mode") return { data: state, error: null };
    if (name === "set_web_reservation_mode") {
      state = { ...state, enabled: args.p_enabled };
      return { data: { ok: true, changed: true, enabled: args.p_enabled }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
});

describe("state", () => {
  it("shows Off with who and when it last changed", async () => {
    mount();
    expect(await screen.findByTestId("reservation-mode-state")).toHaveTextContent("Off");
    expect(screen.getByTestId("reservation-mode-changed")).toHaveTextContent(/Last changed .* by Cynthia/);
    expect(screen.getByText(reservationModeEffect(false))).toBeInTheDocument();
  });

  it("shows On", async () => {
    state = base({ enabled: true });
    mount();
    expect(await screen.findByTestId("reservation-mode-state")).toHaveTextContent("On");
    expect(screen.getByText(reservationModeEffect(true))).toBeInTheDocument();
  });

  it("says when nobody has changed it from the Hub", async () => {
    state = base({ updated_by_user_id: null, updated_by_name: null });
    mount();
    expect(await screen.findByTestId("reservation-mode-changed")).toHaveTextContent("Not changed from the Hub yet");
  });

  it("shows a read error instead of a state", async () => {
    rpc.mockImplementation(async () => ({ data: { error: "permission_denied" }, error: null }));
    mount();
    expect(await screen.findByTestId("reservation-mode-read-error")).toHaveTextContent("Could not read the switch: you do not have access to this setting.");
    expect(screen.queryByTestId("reservation-mode-state")).toBeNull();
  });
});

describe("permission split", () => {
  it("an admin gets the switch", async () => {
    mount();
    expect(await screen.findByRole("switch", { name: "Reserve-first checkout" })).toBeInTheDocument();
    expect(screen.queryByTestId("reservation-mode-readonly")).toBeNull();
  });

  for (const r of [["staff"], ["csr"], ["finance"], []]) {
    it(`${r[0] ?? "no role"} sees the state read-only, with no switch`, async () => {
      roles = r;
      state = base({ can_change: false });
      mount();
      expect(await screen.findByTestId("reservation-mode-state")).toHaveTextContent("Off");
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.getByTestId("reservation-mode-readonly")).toHaveTextContent("Only an admin can change this.");
    });
  }

  it("an admin role the server does not honour gets no switch either", async () => {
    state = base({ can_change: false });
    mount();
    await screen.findByTestId("reservation-mode-state");
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("confirm dialog", () => {
  it("turning ON explains the effect and writes only after confirming", async () => {
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Turn reserve-first checkout ON/)).toBeInTheDocument();
    expect(within(dialog).getByText(reservationModeEffect(true))).toBeInTheDocument();
    expect(within(dialog).queryByTestId("reservation-mode-waiting")).toBeNull();
    expect(rpc).not.toHaveBeenCalledWith("set_web_reservation_mode", expect.anything());

    fireEvent.click(within(dialog).getByRole("button", { name: /Turn on/ }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_web_reservation_mode", { p_enabled: true, p_expected: false }));
    await waitFor(() => expect(screen.getByTestId("reservation-mode-state")).toHaveTextContent("On"));
  });

  it("turning OFF states how many reservations are still waiting", async () => {
    state = base({ enabled: true, awaiting_total: 3 });
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(reservationModeEffect(false))).toBeInTheDocument();
    expect(within(dialog).getByTestId("reservation-mode-waiting")).toHaveTextContent("3 reservations are still waiting for confirmation.");
  });

  it("turning OFF with none waiting says so", async () => {
    state = base({ enabled: true, awaiting_total: 0 });
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    expect(await screen.findByTestId("reservation-mode-waiting")).toHaveTextContent("No reservations are waiting.");
  });

  it("cancel writes nothing", async () => {
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(rpc).not.toHaveBeenCalledWith("set_web_reservation_mode", expect.anything());
  });

  it("a server refusal is shown and the state is re-read", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_web_reservation_mode") return { data: state, error: null };
      return { data: { error: "stale", enabled: true }, error: null };
    });
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: /Turn on/ }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: "Not changed", description: reservationModeRefusal("stale"), variant: "destructive",
    })));
    const reads = rpc.mock.calls.filter((c) => c[0] === "get_web_reservation_mode").length;
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});

describe("the card and the website agree on what On means", () => {
  it("the SQL read's rule is the website reader's rule", () => {
    // get_web_reservation_mode: enabled = value = true OR value = "true".
    const sqlRule = (v: unknown) => v === true || v === "true";
    for (const v of [true, "true", false, "false", "yes", 1, null, undefined, "TRUE"]) {
      expect(sqlRule(v)).toBe(readReservationMode(v));
    }
  });
});
