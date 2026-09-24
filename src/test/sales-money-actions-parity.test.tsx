import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

/**
 * Hub visual refresh, Phase 2B (Sales → Payments, Sales → Waivers).
 *
 * These screens create payments and change balances, and the refresh is
 * display-only. This file pins EXACTLY what each money action sends: which
 * edge function or table it calls and the payload. The expectations are
 * hard-coded, so the same file passing on develop (the old cards) and on the
 * refreshed branch (ledger table on desktop, cards on phones) is the proof
 * that the restyle changed no call and no payload.
 *
 * The supabase client is a recording fake — nothing leaves the process.
 * Accessible names ("Confirm", "Reject", "Confirm & Record Payment", …) are
 * part of the contract: staff and this test both find buttons by them.
 */

// ------------------------------------------------------------------ fake client
type Call = { kind: string; target: string; payload?: unknown; filters?: unknown[] };
const h = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; target: string; payload?: unknown; filters?: unknown[] }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  perms: new Set<string>(),
}));

vi.mock("@/integrations/supabase/client", () => {
  const matches = (row: Record<string, unknown>, ops: Array<[string, unknown[]]>) =>
    ops.every(([op, args]) => {
      if (op === "eq" && args[0] === "status") return row.status === args[1];
      if (op === "in" && args[0] === "status") return (args[1] as unknown[]).includes(row.status);
      if (op === "eq" && args[0] === "account_id") return row.account_id === args[1];
      return true;
    });
  const from = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    let write: { kind: string; payload: unknown } | null = null;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "in", "eq", "not", "limit", "single", "maybeSingle"]) {
      b[m] = (...args: unknown[]) => { ops.push([m, args]); return b; };
    }
    b.update = (payload: unknown) => { write = { kind: "update", payload }; return b; };
    b.insert = (payload: unknown) => { write = { kind: "insert", payload }; return b; };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      let out: unknown;
      if (write) {
        h.calls.push({ kind: `table.${write.kind}`, target: table, payload: write.payload, filters: ops.filter(([m]) => m === "eq").map(([, a]) => a) });
        out = { data: null, error: null };
      } else {
        out = { data: (h.tables[table] ?? []).filter((r) => matches(r, ops)), error: null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  };
  const supabase = {
    from,
    functions: {
      invoke: async (name: string, opts: { body?: unknown; headers?: unknown }) => {
        h.calls.push({ kind: "invoke", target: name, payload: { body: opts?.body, headers: opts?.headers } });
        return { data: { success: true }, error: null };
      },
    },
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number) => {
          h.calls.push({ kind: "storage.sign", target: bucket, payload: { path, ttl } });
          return { data: { signedUrl: `https://signed.test/${path}` }, error: null };
        },
        upload: async (path: string, _file: unknown, opts: unknown) => {
          h.calls.push({ kind: "storage.upload", target: bucket, payload: { path, opts } });
          return { data: { path }, error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://public.test/payment-proofs/${path}` } }),
      }),
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  };
  return { supabase };
});

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ session: { user: { id: "u-reviewer" } }, user: { id: "u-reviewer" }, roles: ["admin"] }),
}));
vi.mock("@/contexts/PermissionsContext", () => ({
  usePermissions: () => ({ can: (k: string) => h.perms.has(k) }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/use-auto-refresh", () => ({
  useAutoRefresh: () => ({ lastRefreshedAt: null, refreshing: false, refresh: () => {} }),
}));

import type { FC } from "react";
import PaymentSubmissionsImpl from "@/pages/PaymentSubmissions";
// memo() widens the inferred props to `object`; PaymentsHub re-points it the same way.
const PaymentSubmissions = PaymentSubmissionsImpl as FC<{ embedded?: boolean; searchValue?: string }>;
import Waivers from "@/pages/Waivers";

// ------------------------------------------------------------------ fixtures
const cust = (name: string) => ({ full_name: name, customer_code: "CJ-2026-00008" });
const sub = (over: Record<string, unknown>) => ({
  id: "s-1",
  customer_id: "c-1",
  account_id: "a-1",
  cash_order_id: null,
  submitted_amount: 5000,
  payment_date: "2026-09-20",
  payment_method: "bank_transfer",
  reference_number: "REF-001",
  sender_name: "BDO slip sender",
  notes: null,
  proof_url: "https://x.supabase.co/storage/v1/object/public/payment-proofs/a-1/maria.jpg",
  status: "submitted",
  reviewer_user_id: null,
  reviewer_notes: null,
  confirmed_payment_id: null,
  portal_token: null,
  submission_type: "single",
  created_at: "2026-09-20T02:00:00Z",
  updated_at: "2026-09-20T02:00:00Z",
  customer_edited_at: null,
  customers: cust("Maria Santos"),
  layaway_accounts: { invoice_number: "19001", currency: "PHP", remaining_balance: 20000, total_amount: 30000 },
  cash_orders: null,
  ...over,
});
const scheduleRow = {
  id: "sch-1", account_id: "a-1", installment_number: 1, due_date: "2026-10-01",
  base_installment_amount: 5000, penalty_amount: 0, carried_amount: 0, currency: "PHP",
  db_status: "pending", allocated: 0, actual_remaining: 5000, computed_status: "pending",
};
const waiver = (over: Record<string, unknown>) => ({
  id: "w-1", account_id: "a-9", schedule_id: "sch-9", penalty_fee_id: "p-1", penalty_amount: 500,
  reason: "Customer was hospitalised", status: "pending", created_at: "2026-09-18T01:00:00Z",
  requested_by_user_id: "u-csr", approved_by_user_id: null, approved_at: null, rejected_at: null,
  layaway_accounts: { id: "a-9", invoice_number: "18555", currency: "PHP", customer_id: "c-9", customers: { full_name: "Ana Reyes" } },
  penalty_fees: { id: "p-1", penalty_stage: "week1", penalty_cycle: 1, penalty_amount: 500, penalty_date: "2026-09-08", status: "unpaid" },
  ...over,
});

// ------------------------------------------------------------------ harness
function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
const writes = () => h.calls.filter((c) => c.kind !== "storage.sign");
const invokes = () => h.calls.filter((c) => c.kind === "invoke");
const button = (name: string | RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  h.calls.length = 0;
  h.tables = {
    payment_methods: [{ method_name: "bank_transfer" }, { method_name: "gcash" }],
    payment_submission_allocations: [],
    schedule_with_actuals: [scheduleRow],
    payment_submissions: [],
    penalty_waiver_requests: [],
  };
  h.perms = new Set(["confirm_payment", "review_submission", "reject_submission", "manage_waivers"]);
  // Radix Select / Dialog need these in jsdom.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { vi.useRealTimers(); });

// Every flow runs at desktop width (ledger table) and phone width (cards).
for (const width of [1280, 375]) {
describe(`at ${width}px`, () => {
  beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width }); });

  // ================================================================== payments
  describe("Payments — confirm a submission", () => {
    it("layaway: invokes review-payment-submission with the exact payload", async () => {
      h.tables.payment_submissions = [sub({})];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");

      fireEvent.click(button("Confirm"));
      // The allocation preview reads the canonical schedule view for this account.
      await screen.findByText(/Allocation breakdown/i);
      fireEvent.click(button(/Confirm & Record Payment/));

      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect(writes()).toEqual<Call[]>([
        {
          kind: "invoke",
          target: "review-payment-submission",
          payload: { body: { submission_id: "s-1", action: "confirmed", reviewer_notes: "", submission_type: "single" }, headers: undefined },
        },
      ]);
    });

    it("cash order: same function, no schedule preview", async () => {
      h.tables.payment_submissions = [sub({
        id: "s-cash", account_id: null, cash_order_id: "co-1", layaway_accounts: null,
        cash_orders: { invoice_number: "19500", currency: "JPY", customer_id: "c-2", customers: cust("Kenji Sato") },
        customers: cust("Kenji Sato"), submitted_amount: 120000,
      })];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Kenji Sato");
      fireEvent.click(button("Confirm"));
      fireEvent.click(button(/Confirm & Record Payment/));
      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect(writes()).toEqual([
        {
          kind: "invoke",
          target: "review-payment-submission",
          payload: { body: { submission_id: "s-cash", action: "confirmed", reviewer_notes: "", submission_type: "single" }, headers: undefined },
        },
      ]);
    });

    it("an optional note travels as reviewer_notes", async () => {
      h.tables.payment_submissions = [sub({})];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      fireEvent.click(button("Confirm"));
      fireEvent.change(screen.getByPlaceholderText("Optional note..."), { target: { value: "Matched BDO statement" } });
      fireEvent.click(button(/Confirm & Record Payment/));
      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect((invokes()[0].payload as { body: { reviewer_notes: string } }).body.reviewer_notes).toBe("Matched BDO statement");
    });

    it("Confirm is disabled without proof, and nothing is sent", async () => {
      h.tables.payment_submissions = [sub({ proof_url: null })];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      expect(button("Confirm")).toBeDisabled();
      expect(screen.getAllByText(/No proof/i).length).toBeGreaterThan(0);
      expect(writes()).toEqual([]);
    });
  });

  describe("Payments — reject, clarify, restore", () => {
    it("reject requires a reason and sends it", async () => {
      h.tables.payment_submissions = [sub({})];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      fireEvent.click(button("Reject"));
      const submit = button("Reject Submission");
      expect(submit).toBeDisabled();
      fireEvent.change(screen.getByPlaceholderText("Reason for rejection..."), { target: { value: "Amount does not match" } });
      fireEvent.click(button("Reject Submission"));
      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect(writes()).toEqual([
        {
          kind: "invoke",
          target: "review-payment-submission",
          payload: { body: { submission_id: "s-1", action: "rejected", reviewer_notes: "Amount does not match", submission_type: "single" }, headers: undefined },
        },
      ]);
    });

    it("clarify sends needs_clarification with the message", async () => {
      h.tables.payment_submissions = [sub({})];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      fireEvent.click(button("Clarify"));
      fireEvent.change(screen.getByPlaceholderText("What information do you need?"), { target: { value: "Please resend the slip" } });
      fireEvent.click(button("Send Clarification Request"));
      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect((invokes()[0].payload as { body: unknown }).body).toEqual({
        submission_id: "s-1", action: "needs_clarification", reviewer_notes: "Please resend the slip", submission_type: "single",
      });
    });

    it("restore (the undo for a rejection) sends action restore", async () => {
      h.tables.payment_submissions = [sub({ status: "rejected", reviewer_notes: "Wrong amount" })];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      // The default filter is Pending; switch to Rejected.
      const trigger = screen.getAllByRole("combobox")[0];
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.click(await screen.findByRole("option", { name: "Rejected" }));
      await screen.findAllByText("Maria Santos");
      fireEvent.click(button("Restore"));
      fireEvent.click(button("Restore Submission"));
      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect((invokes()[0].payload as { body: unknown }).body).toEqual({
        submission_id: "s-1", action: "restore", reviewer_notes: "", submission_type: "single",
      });
    });
  });

  describe("Payments — proof viewing", () => {
    it("image proof: opens the preview through a 1-hour signed URL and never writes", async () => {
      h.tables.payment_submissions = [sub({})];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      await waitFor(() => expect(h.calls.some((c) => c.kind === "storage.sign")).toBe(true));
      for (const c of h.calls.filter((x) => x.kind === "storage.sign")) {
        expect(c).toEqual({ kind: "storage.sign", target: "payment-proofs", payload: { path: "a-1/maria.jpg", ttl: 3600 } });
      }
      fireEvent.click(screen.getAllByRole("button", { name: /View full size|^Expand$|Proof of payment/i })[0]);
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Proof of Payment")).toBeInTheDocument();
      expect(within(dialog).getByRole("link", { name: /Open in new tab/ })).toHaveAttribute("href", sub({}).proof_url);
      expect(writes()).toEqual([]);
    });

    it("PDF proof: links straight to the stored URL", async () => {
      const pdf = "https://x.supabase.co/storage/v1/object/public/payment-proofs/a-1/slip.pdf";
      h.tables.payment_submissions = [sub({ proof_url: pdf })];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      const links = screen.getAllByRole("link", { name: /View Proof/ });
      expect(links.length).toBeGreaterThan(0);
      for (const l of links) expect(l).toHaveAttribute("href", pdf);
      expect(writes()).toEqual([]);
    });

    it("attach / replace proof uploads under the submission's folder, then updates proof_url", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1_758_000_000_000);
      h.tables.payment_submissions = [sub({})];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      fireEvent.click(button(/Attach \/ Replace proof/));
      const input = (await screen.findByRole("dialog")).querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(["x"], "slip.png", { type: "image/png" })] } });
      fireEvent.click(button("Save proof"));
      await waitFor(() => expect(writes()).toHaveLength(2));
      const path = `a-1/MariaSantos_19001_2026-09-20_${(1_758_000_000_000).toString(36)}.png`;
      expect(writes()).toEqual([
        { kind: "storage.upload", target: "payment-proofs", payload: { path, opts: { cacheControl: "3600", upsert: false } } },
        { kind: "table.update", target: "payment_submissions", payload: { proof_url: `https://public.test/payment-proofs/${path}` }, filters: [["id", "s-1"]] },
      ]);
      vi.restoreAllMocks();
    });
  });

  describe("Payments — permission gates", () => {
    it("a viewer with none of the three keys sees no Confirm / Reject / Clarify / Attach", async () => {
      h.perms = new Set();
      h.tables.payment_submissions = [sub({})];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      for (const name of ["Confirm", "Reject", "Clarify", /Attach \/ Replace proof/]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
      expect(screen.getByText(/Pending Confirmation/)).toBeInTheDocument();
    });

    it("confirm_payment alone: Confirm yes, Reject and Clarify no", async () => {
      h.perms = new Set(["confirm_payment"]);
      h.tables.payment_submissions = [sub({})];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Maria Santos");
      expect(button("Confirm")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Clarify" })).toBeNull();
    });

    it("Restore needs reject_submission", async () => {
      h.perms = new Set(["confirm_payment", "review_submission"]);
      h.tables.payment_submissions = [sub({ status: "rejected" })];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      const trigger = screen.getAllByRole("combobox")[0];
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.click(await screen.findByRole("option", { name: "Rejected" }));
      await screen.findAllByText("Maria Santos");
      expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    });
  });

  describe("Payments — search and filters", () => {
    it("parent search narrows the list by invoice", async () => {
      h.tables.payment_submissions = [sub({}), sub({ id: "s-2", customers: cust("Liza Cruz"), layaway_accounts: { invoice_number: "19002", currency: "PHP", remaining_balance: 1, total_amount: 1 } })];
      const { rerender } = renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Liza Cruz");
      rerender(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter><PaymentSubmissions embedded searchValue="19002" /></MemoryRouter>
        </QueryClientProvider>,
      );
      await screen.findAllByText("Liza Cruz");
      await waitFor(() => expect(screen.queryAllByText("Maria Santos")).toHaveLength(0));
    });

    it("type filter Cash Orders hides layaway submissions", async () => {
      h.tables.payment_submissions = [
        sub({}),
        sub({ id: "s-cash", account_id: null, cash_order_id: "co-1", layaway_accounts: null, customers: cust("Kenji Sato"),
          cash_orders: { invoice_number: "19500", currency: "JPY", customer_id: "c-2", customers: cust("Kenji Sato") } }),
      ];
      renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
      await screen.findAllByText("Kenji Sato");
      const trigger = screen.getAllByRole("combobox")[1];
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.click(await screen.findByRole("option", { name: "Cash Orders" }));
      await waitFor(() => expect(screen.queryAllByText("Maria Santos")).toHaveLength(0));
      expect(screen.getAllByText("Kenji Sato").length).toBeGreaterThan(0);
    });
  });

  // ================================================================== waivers
  describe("Waivers — approve and reject", () => {
    beforeEach(() => {
      h.tables.penalty_waiver_requests = [
        waiver({}),
        waiver({ id: "w-2", penalty_fee_id: "p-2", penalty_fees: { id: "p-2", penalty_stage: "week2", penalty_cycle: 1, penalty_amount: 500, penalty_date: "2026-09-15", status: "unpaid" } }),
      ];
    });

    it("approve: typed APPROVE gate, then approve-waiver with the selected ids", async () => {
      renderWithProviders(<Waivers embedded search="" />);
      await screen.findAllByText("Ana Reyes");
      fireEvent.click(button("Approve"));
      const confirmBtn = button(/Approve 2 Selected/);
      expect(confirmBtn).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Type APPROVE to confirm"), { target: { value: "APPROVE" } });
      fireEvent.click(button(/Approve 2 Selected/));
      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect(writes()).toEqual([
        {
          kind: "invoke",
          target: "approve-waiver",
          payload: { body: { waiver_request_ids: ["w-1", "w-2"], notes: undefined }, headers: { Authorization: "Bearer tok" } },
        },
      ]);
    });

    it("approve a subset with notes", async () => {
      renderWithProviders(<Waivers embedded search="" />);
      await screen.findAllByText("Ana Reyes");
      fireEvent.click(button("Approve"));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getAllByRole("checkbox")[1]);
      fireEvent.change(within(dialog).getByPlaceholderText("Approval notes..."), { target: { value: "  first offence  " } });
      fireEvent.change(within(dialog).getByLabelText("Type APPROVE to confirm"), { target: { value: "APPROVE" } });
      fireEvent.click(button(/Approve 1 Selected/));
      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect(invokes()[0].payload).toEqual({ body: { waiver_request_ids: ["w-1"], notes: "first offence" }, headers: { Authorization: "Bearer tok" } });
    });

    it("reject: one update per waiver, then one audit row — no edge function", async () => {
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      vi.setSystemTime(new Date("2026-09-24T05:00:00.000Z"));
      renderWithProviders(<Waivers embedded search="" />);
      await screen.findAllByText("Ana Reyes");
      fireEvent.click(button("Reject"));
      fireEvent.change(screen.getByPlaceholderText("Rejection reason..."), { target: { value: "Not eligible" } });
      fireEvent.click(button(/Reject 2 Selected/));
      await waitFor(() => expect(writes()).toHaveLength(3));
      const upd = (id: string) => ({
        kind: "table.update", target: "penalty_waiver_requests",
        payload: { status: "rejected", rejected_at: "2026-09-24T05:00:00.000Z", approved_by_user_id: "u-reviewer" },
        filters: [["id", id]],
      });
      expect(writes()).toEqual([
        upd("w-1"),
        upd("w-2"),
        {
          kind: "table.insert", target: "audit_logs", filters: [],
          payload: {
            entity_type: "penalty_waiver", entity_id: "a-9", action: "batch_waiver_rejected", performed_by_user_id: "u-reviewer",
            new_value_json: { waiver_ids: ["w-1", "w-2"], count: 2, notes: "Not eligible" },
          },
        },
      ]);
    });

    it("unwaive (the undo for an approval) invokes unwaive-waiver", async () => {
      h.tables.penalty_waiver_requests = [waiver({ status: "approved", penalty_fees: { id: "p-1", penalty_stage: "week1", penalty_cycle: 1, penalty_amount: 500, penalty_date: "2026-09-08", status: "waived" } })];
      renderWithProviders(<Waivers embedded search="" />);
      fireEvent.click(button("All Requests"));
      const name = await screen.findAllByText("Ana Reyes");
      fireEvent.click(name[0]);
      fireEvent.click(await screen.findByRole("button", { name: /Unwaive/ }));
      fireEvent.click(button("Confirm Unwaive"));
      await waitFor(() => expect(invokes()).toHaveLength(1));
      expect(writes()).toEqual([
        { kind: "invoke", target: "unwaive-waiver", payload: { body: { waiver_id: "w-1" }, headers: { Authorization: "Bearer tok" } } },
      ]);
    });

    it("without manage_waivers there is no Approve or Reject", async () => {
      h.perms = new Set();
      renderWithProviders(<Waivers embedded search="" />);
      await screen.findAllByText("Ana Reyes");
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
      // The account link stays for everyone while the group has pending waivers.
      expect(screen.getByTitle("View Account")).toBeInTheDocument();
    });

    it("search narrows groups by customer, invoice or reason", async () => {
      const { rerender } = renderWithProviders(<Waivers embedded search="" />);
      await screen.findAllByText("Ana Reyes");
      await act(async () => {
        rerender(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MemoryRouter><Waivers embedded search="nobody" /></MemoryRouter>
          </QueryClientProvider>,
        );
      });
      await screen.findByText("No pending waiver requests");
      expect(writes()).toEqual([]);
    });
  });
});
}

// ================================================================== review fixes
// PR #168 review (2026-09-24). NEW behaviour, so these are not part of the
// develop-parity claim above — they pin the two display fixes and assert the
// fixes themselves send nothing.
describe("PR #168 review fixes (new behaviour)", () => {
  beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 }); });

  it("an auto_unwaived waiver reads 'Auto-unwaived', never 'Pending'", async () => {
    h.tables.penalty_waiver_requests = [waiver({ status: "auto_unwaived" })];
    renderWithProviders(<Waivers embedded search="" />);
    fireEvent.click(button("All Requests"));
    fireEvent.click((await screen.findAllByText("Ana Reyes"))[0]);
    expect(await screen.findByText("Auto-unwaived")).toBeInTheDocument();
    expect(screen.queryByText("Pending", { selector: "span" })).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("the proof opened from inside Confirm takes focus and gives it back; Confirm stays open", async () => {
    h.tables.payment_submissions = [sub({})];
    renderWithProviders(<PaymentSubmissions embedded searchValue="" />);
    await screen.findAllByText("Maria Santos");
    fireEvent.click(button("Confirm"));
    const confirm = await screen.findByRole("dialog", { name: "Confirm Payment" });
    const trigger = within(confirm).getByRole("button", { name: /Proof of payment — view full size/ });
    fireEvent.click(trigger);
    const preview = await screen.findByRole("dialog", { name: "Proof of Payment" });
    await waitFor(() => expect(preview.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(preview, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Proof of Payment" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByRole("dialog", { name: "Confirm Payment" })).toBeInTheDocument();
    expect(writes()).toEqual([]);
  });
});
