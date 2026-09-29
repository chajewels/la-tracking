import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";

/**
 * Website → Settings → "Website orders (staff confirm first)" — website-orders
 * PR 8, the web_checkout_mode switch. What must hold: a non-admin gets no
 * control; the dialog says what the change does and how many drafts wait;
 * the write carries the state the admin SAW (p_expected) so a stale click is
 * refused; nothing but set_web_checkout_mode writes the key.
 */

const rpc = vi.fn();
let roles: string[] = ["admin"];

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles }) }));
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: unknown[]) => toastSpy(...a) }));

import { CheckoutModeCard } from "@/components/website/CheckoutModeCard";
import { checkoutModeEffect, checkoutModeRefusal, draftsWaitingLine } from "@/components/website/checkout-mode";

type State = Record<string, unknown>;
let state: State;
const base = (over: State = {}): State => ({
  found: true, mode: "order", raw_value: "order",
  updated_at: "2026-09-29T08:43:20Z", updated_by_user_id: null, updated_by_name: null,
  can_change: true, drafts_to_confirm: 0, ...over,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter><QueryClientProvider client={qc}><CheckoutModeCard /></QueryClientProvider></MemoryRouter>,
  );
}

beforeEach(() => {
  roles = ["admin"];
  state = base();
  rpc.mockReset();
  toastSpy.mockReset();
  rpc.mockImplementation(async (name: string, args: { p_mode: string; p_expected: string | null }) => {
    if (name === "get_web_checkout_mode") return { data: state, error: null };
    if (name === "set_web_checkout_mode") {
      if (args.p_expected !== state.mode) return { data: { error: "stale", mode: state.mode }, error: null };
      state = { ...state, mode: args.p_mode };
      return { data: { ok: true, changed: true, mode: args.p_mode }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
});

describe("state", () => {
  it("shows Off and what Off does, today's live state", async () => {
    mount();
    expect(await screen.findByTestId("checkout-mode-state")).toHaveTextContent("Off");
    expect(screen.getByTestId("checkout-mode-effect")).toHaveTextContent(checkoutModeEffect("order"));
    expect(screen.getByTestId("checkout-mode-changed")).toHaveTextContent("Not changed from the Hub yet");
  });

  it("shows On, who changed it, and links the waiting drafts", async () => {
    state = base({ mode: "draft", updated_by_user_id: "u-1", updated_by_name: "Cynthia", drafts_to_confirm: 2 });
    mount();
    expect(await screen.findByTestId("checkout-mode-state")).toHaveTextContent("On");
    const changed = screen.getByTestId("checkout-mode-changed");
    expect(changed).toHaveTextContent(/Last changed .* by Cynthia/);
    expect(within(changed).getByRole("link", { name: "To confirm" })).toHaveAttribute("href", "/sales?tab=web");
  });

  it("shows a read error instead of a state", async () => {
    rpc.mockImplementation(async () => ({ data: { error: "permission_denied" }, error: null }));
    mount();
    expect(await screen.findByTestId("checkout-mode-read-error"))
      .toHaveTextContent("Could not read the setting: you do not have access to this setting.");
  });
});

describe("who can change it", () => {
  it("a non-admin sees it read-only, with no switch", async () => {
    roles = ["staff"];
    mount();
    expect(await screen.findByTestId("checkout-mode-readonly")).toHaveTextContent("Only an admin can change this.");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("an admin the server says cannot change it gets no switch either", async () => {
    state = base({ can_change: false });
    mount();
    expect(await screen.findByTestId("checkout-mode-readonly")).toBeInTheDocument();
  });
});

describe("turning it on", () => {
  it("asks first, says what happens, then sends the mode the admin saw", async () => {
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    expect(await screen.findByText("Staff confirm every website order first?")).toBeInTheDocument();
    expect(screen.getByTestId("checkout-mode-waiting")).toHaveTextContent("No website orders are waiting in To confirm.");
    expect(rpc).not.toHaveBeenCalledWith("set_web_checkout_mode", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_web_checkout_mode", { p_mode: "draft", p_expected: "order" }));
    await waitFor(() => expect(screen.getByTestId("checkout-mode-state")).toHaveTextContent("On"));
  });

  it("cancel writes nothing", async () => {
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(rpc).not.toHaveBeenCalledWith("set_web_checkout_mode", expect.anything());
  });
});

describe("turning it off", () => {
  it("says waiting drafts stay and can still be confirmed", async () => {
    state = base({ mode: "draft", drafts_to_confirm: 3 });
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    expect(await screen.findByTestId("checkout-mode-waiting"))
      .toHaveTextContent("3 website orders are waiting in To confirm. They stay there");
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_web_checkout_mode", { p_mode: "order", p_expected: "draft" }));
  });

  it("a refusal from the server is shown in plain words", async () => {
    state = base({ mode: "draft" });
    rpc.mockImplementation(async (name: string) =>
      name === "get_web_checkout_mode"
        ? { data: state, error: null }
        : { data: { error: "stale", mode: "order" }, error: null });
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: "Not changed", description: checkoutModeRefusal("stale"), variant: "destructive",
    })));
  });
});

describe("words", () => {
  it("every refusal has plain words", () => {
    expect(checkoutModeRefusal("permission_denied")).toBe("Only an admin can change this.");
    expect(checkoutModeRefusal("stale")).toMatch(/Someone else changed this/);
    expect(draftsWaitingLine(1, "draft")).toBe("1 website order is waiting in To confirm.");
  });
});

describe("placement and single writer", () => {
  const website = readFileSync("src/pages/Website.tsx", "utf8");
  it("sits on Website → Settings", () => {
    expect(website).toMatch(/<CheckoutModeCard \/>/);
    expect(website).toMatch(/websiteOrders: "website-orders"/);
  });
  it("no frontend code writes the key directly", () => {
    const card = readFileSync("src/components/website/CheckoutModeCard.tsx", "utf8");
    expect(card).not.toMatch(/from\(["']system_settings["']\)/);
    expect(card).toMatch(/callRpc\("set_web_checkout_mode"/);
  });
});
