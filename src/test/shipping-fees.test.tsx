import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type ShippingRate, deactivateEffect, feeFor, groupByCountry, isMissingFunction, rateLabel, validateRateInput,
} from "@/components/website/shipping-fees";

const r = (id: string, country: string, min: number, fee: number, is_active = true): ShippingRate =>
  ({ id, country, min_subtotal_jpy: min, fee_jpy: fee, is_active, updated_at: null });

// The live card as confirmed by the owner on 2026-09-27.
const LIVE = [r("jp0", "JP", 0, 800), r("jp8k", "JP", 8000, 0), r("ph0", "PH", 0, 3500), r("ph100k", "PH", 100000, 0)];

describe("shipping fee rules (mirror of website/index.ts shippingFor)", () => {
  it("charges the highest threshold the pieces subtotal reaches", () => {
    expect(feeFor(LIVE, "JP", 0)).toBe(800);
    expect(feeFor(LIVE, "JP", 7999)).toBe(800);
    expect(feeFor(LIVE, "jp", 8000)).toBe(0);
    expect(feeFor(LIVE, "PH", 99999)).toBe(3500);
    expect(feeFor(LIVE, "PH", 100000)).toBe(0);
  });
  it("returns null (manual quote) for a country with no active rate", () => {
    expect(feeFor(LIVE, "US", 50000)).toBeNull();
    expect(feeFor([r("us", "US", 0, 5000, false)], "US", 50000)).toBeNull();
  });
  it("skips inactive thresholds", () => {
    expect(feeFor([...LIVE.slice(0, 1), r("jp8k", "JP", 8000, 0, false)], "JP", 9000)).toBe(800);
  });
  it("labels a rate as From ¥X → fee ¥Y", () => {
    expect(rateLabel(LIVE[1])).toBe("From ¥8,000 → fee ¥0");
    expect(rateLabel(LIVE[2])).toBe("From ¥0 → fee ¥3,500");
  });
  it("groups by country, thresholds ascending", () => {
    const g = groupByCountry([LIVE[3], LIVE[1], LIVE[2], LIVE[0]]);
    expect(g.map((x) => x.country)).toEqual(["JP", "PH"]);
    expect(g[0].rates.map((x) => x.min_subtotal_jpy)).toEqual([0, 8000]);
  });
  it("says what deactivating a threshold does", () => {
    expect(deactivateEffect(LIVE, LIVE[1])).toBe("JP subtotals from ¥8,000 up will be charged ¥800 (the next lower active threshold).");
    expect(deactivateEffect(LIVE, LIVE[0])).toBe(
      "JP subtotals from ¥0 to ¥7,999 will have no shipping fee on the card: the checkout asks for a manual quote.");
  });
  it("validates the form", () => {
    expect(validateRateInput("JP", "8000", "0")).toBeNull();
    expect(validateRateInput("JPN", "0", "1")).toMatch(/two-letter/);
    expect(validateRateInput("JP", "", "1")).toMatch(/threshold/);
    expect(validateRateInput("JP", "0", "-1")).toMatch(/fee/);
  });
  it("recognises a missing RPC (migration not applied yet)", () => {
    expect(isMissingFunction({ code: "PGRST202", message: "Could not find the function public.get_shipping_rates" })).toBe(true);
    expect(isMissingFunction({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });
});

describe("docs no longer state the old JP threshold", () => {
  it("WEBSITE-VERCEL.md says ¥8,000, not ¥50,000", () => {
    const doc = readFileSync("docs/WEBSITE-VERCEL.md", "utf8");
    expect(doc).not.toMatch(/free ≥¥50,000/);
  });
});

// ------------------------------------------------------------------ the card
const rpc = vi.fn();
const toastSpy = vi.fn();
let roles: string[] = ["admin"];
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles }) }));
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: unknown[]) => toastSpy(...a) }));

const { ShippingFeesCard } = await import("@/components/website/ShippingFeesCard");

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ShippingFeesCard /></QueryClientProvider>);
}

describe("ShippingFeesCard", () => {
  beforeEach(() => {
    rpc.mockReset(); toastSpy.mockReset(); roles = ["admin"];
  });

  it("shows 'Waiting for the database update' when the RPC does not exist yet", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    renderCard();
    expect(await screen.findByTestId("shipping-fees-waiting")).toHaveTextContent("Waiting for the database update");
    expect(screen.queryByTestId("shipping-fees-read-error")).toBeNull();
  });

  it("lists the rates by country with the note, and changes a fee through the RPC after a confirm", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_shipping_rates") return { data: { can_change: true, rates: LIVE }, error: null };
      return { data: { ok: true, changed: true, action: "fee_changed", rate: { ...LIVE[0], fee_jpy: 900 } }, error: null };
    });
    renderCard();
    expect(await screen.findByText("From ¥8,000 → fee ¥0")).toBeInTheDocument();
    expect(screen.getByTestId("shipping-fees-note")).toHaveTextContent(
      "Shipping is charged on the pieces subtotal. The highest threshold the subtotal reaches applies.");

    fireEvent.click(screen.getAllByRole("button", { name: "Change fee" })[0]);
    fireEvent.change(screen.getByLabelText("Fee (¥)"), { target: { value: "900" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByTestId("shipping-rate-confirm")).toHaveTextContent("¥800 → ¥900 for JP subtotals from ¥0.");
    expect(rpc).not.toHaveBeenCalledWith("set_shipping_rate", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_shipping_rate", { p_country: "JP", p_min_subtotal_jpy: 0, p_fee_jpy: 900 }));
  });

  it("deactivates through deactivate_shipping_rate after a confirm — never a delete", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_shipping_rates") return { data: { can_change: true, rates: LIVE }, error: null };
      return { data: { ok: true, changed: true, action: "deactivated", rate: { ...LIVE[1], is_active: false } }, error: null };
    });
    renderCard();
    await screen.findByText("From ¥8,000 → fee ¥0");
    fireEvent.click(screen.getAllByRole("button", { name: "Deactivate" })[1]);
    expect(await screen.findByTestId("shipping-rate-confirm")).toHaveTextContent("will be charged ¥800");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("deactivate_shipping_rate", { p_id: "jp8k" }));
  });

  it("is read-only when the server says the user cannot change it", async () => {
    roles = ["staff"];
    rpc.mockResolvedValue({ data: { can_change: false, rates: LIVE }, error: null });
    renderCard();
    await screen.findByText("From ¥8,000 → fee ¥0");
    expect(screen.queryByRole("button", { name: "Change fee" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add a rate/ })).toBeNull();
    expect(screen.getByText("Only an admin can change shipping fees.")).toBeInTheDocument();
  });

  it("is rendered only for admins on Website → Settings", () => {
    const src = readFileSync("src/pages/Website.tsx", "utf8");
    expect(src).toMatch(/\{isAdmin && \(\s*<section id=\{WEBSITE_SETTINGS_SECTIONS\.shippingFees\}/);
  });
});
