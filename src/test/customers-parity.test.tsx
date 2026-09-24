import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/**
 * Hub visual refresh, Phase 3 (Customers).
 *
 * The directory, the customer page, Edit Customer and the duplicate-customer
 * block write customer records, and the refresh is display-only. This file
 * pins EXACTLY what each action sends — the table or RPC or edge function it
 * calls and the payload — and what the directory reads for search, the A–Z
 * filter, grouping, sort order and pagination. The expectations are
 * hard-coded, so the same file passing on develop (the old cards) and on the
 * refreshed branch (ledger table on desktop, cards on phones) is the proof
 * that the restyle changed no call, no payload and no list behaviour.
 *
 * The supabase client is a recording fake — nothing leaves the process.
 * Accessible names ("Save Changes", "Set Portal PIN", "Forfeit", …) and link
 * targets are part of the contract: staff and this test both rely on them.
 */

// ------------------------------------------------------------------ fake client
type Call = { kind: string; target: string; payload?: unknown; filters?: unknown[] };
const h = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; target: string; payload?: unknown; filters?: unknown[] }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  rpc: {} as Record<string, unknown[]>,
  perms: new Set<string>(),
  roles: ["admin"] as string[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    const ops: Array<[string, unknown[]]> = [];
    let write: { kind: string; payload: unknown } | null = null;
    let mode: "many" | "single" | "maybe" = "many";
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "in", "eq", "neq", "not", "is", "gte", "lte", "limit", "range"]) {
      b[m] = (...args: unknown[]) => { ops.push([m, args]); return b; };
    }
    b.single = () => { mode = "single"; return b; };
    b.maybeSingle = () => { mode = "maybe"; return b; };
    b.update = (payload: unknown) => { write = { kind: "update", payload }; return b; };
    b.insert = (payload: unknown) => { write = { kind: "insert", payload }; return b; };
    b.delete = () => { write = { kind: "delete", payload: undefined }; return b; };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const filters = ops.filter(([m]) => m === "eq" || m === "in").map(([m, a]) => [m, ...a]);
      let out: unknown;
      if (write) {
        h.calls.push({ kind: `table.${write.kind}`, target: table, payload: write.payload, filters });
        const inserted = write.kind === "insert" ? { id: "c-new", customer_code: "CJ-2026-00999", ...(write.payload as object) } : null;
        out = { data: mode === "many" ? [] : inserted, error: null };
      } else {
        const sel = ops.find(([m]) => m === "select")?.[1][0];
        h.calls.push({ kind: "read", target: table, payload: sel, filters });
        let rows = (h.tables[table] ?? []).filter((r) =>
          ops.every(([m, a]) => {
            if (m === "eq") return r[a[0] as string] === a[1];
            if (m === "in") return (a[1] as unknown[]).includes(r[a[0] as string]);
            return true;
          }),
        );
        const range = ops.find(([m]) => m === "range")?.[1] as [number, number] | undefined;
        if (range) rows = rows.slice(range[0], range[1] + 1);
        out = { data: mode === "many" ? rows : (rows[0] ?? null), error: null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    return b;
  };
  const supabase = {
    from,
    rpc: async (name: string, args: unknown) => {
      h.calls.push({ kind: "rpc", target: name, payload: args });
      return { data: h.rpc[name] ?? [], error: null };
    },
    functions: {
      invoke: async (name: string, opts: { body?: unknown; headers?: unknown }) => {
        h.calls.push({ kind: "invoke", target: name, payload: { body: opts?.body, headers: opts?.headers } });
        return { data: { success: true }, error: null };
      },
    },
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: null }),
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://public.test/${p}` } }),
        createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.test/${p}` }, error: null }),
      }),
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  };
  return { supabase };
});

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ session: { user: { id: "u-staff" } }, user: { id: "u-staff" }, roles: h.roles }),
}));
vi.mock("@/contexts/PermissionsContext", () => ({
  usePermissions: () => ({ can: (k: string) => h.perms.has(k), canAccessPage: () => true, canSeeNav: () => true }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
// The shell (sidebar, realtime, notifications) is not under test.
vi.mock("@/components/layout/AppLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

import { toast } from "sonner";
import Customers from "@/pages/Customers";
import CustomerDetail from "@/pages/CustomerDetail";
import EditCustomerDialog from "@/components/customers/EditCustomerDialog";
import NewCustomerDialog from "@/components/customers/NewCustomerDialog";

// ------------------------------------------------------------------ fixtures
// 60 customers → the directory's 50-per-page pagination has two pages.
const FIRST = ["Ana", "Bea", "Carla", "Dina", "Ella", "Faye", "Gina", "Hana", "Ivy", "Joy", "Kaye", "Lia"];
const LAST = ["Santos", "Reyes", "Cruz", "Bautista", "Garcia"];
const directory = Array.from({ length: 60 }, (_, i) => ({
  id: `c-${String(i).padStart(2, "0")}`,
  full_name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length)]}`,
  customer_code: `CJ-2026-${String((i + 1) * 8).padStart(5, "0")}`,
  facebook_name: i === 7 ? "anna.fb" : null,
  messenger_link: i % 3 === 0 ? `https://m.me/c${i}` : null,
  mobile_number: null,
  email: null,
  notes: null,
  location: i % 2 === 0 ? "Japan" : "Philippines",
  created_at: `2026-0${(i % 6) + 3}-10T03:00:00Z`,
}));
// One name outside A–Z lands in the "#" group.
directory.push({ ...directory[0], id: "c-99", full_name: "Ñora Villa", customer_code: "CJ-2026-00999", location: "Japan" });

const maria = {
  id: "c-1",
  full_name: "Maria Santos",
  customer_code: "CJ-2026-00008",
  facebook_name: "maria.s",
  messenger_link: "https://m.me/maria",
  mobile_number: "+63 917 000 1234",
  email: "maria@example.com",
  notes: "Prefers GCash",
  location: "Philippines",
  auth_user_id: null,
  setup_link_sent_at: null,
  created_at: "2026-03-20T03:00:00Z",
};
const acct = {
  id: "a-1", customer_id: "c-1", invoice_number: "19001", currency: "PHP", status: "active",
  total_amount: 30000, total_paid: 12000, remaining_balance: 18000, downpayment_amount: 9000,
  payment_plan_months: 3, order_date: "2026-08-01", created_at: "2026-08-01T03:00:00Z", notes: null,
};
const sched = (n: number, status: string, paid: number) => ({
  id: `sch-${n}`, account_id: "a-1", installment_number: n, due_date: `2026-${String(8 + n).padStart(2, "0")}-01`,
  base_installment_amount: 7000, penalty_amount: 0, carried_amount: 0, total_due_amount: 7000, paid_amount: paid, status,
});
const detailTables = () => ({
  customers: [maria],
  layaway_accounts: [acct],
  layaway_schedule: [sched(1, "paid", 7000), sched(2, "pending", 0), sched(3, "pending", 0)],
  penalty_fees: [],
  payments: [
    { id: "p-1", account_id: "a-1", amount_paid: 9000, date_paid: "2026-08-01", created_at: "2026-08-01T04:00:00Z", reference_number: "DP-1", remarks: "downpayment", voided_at: null, submission_type: "downpayment" },
    { id: "p-2", account_id: "a-1", amount_paid: 3000, date_paid: "2026-09-01", created_at: "2026-09-01T04:00:00Z", reference_number: "R-2", remarks: null, voided_at: null, submission_type: "single" },
  ],
  account_services: [],
  payment_allocations: [{ id: "al-1", payment_id: "p-2", schedule_id: "sch-1", allocated_amount: 3000 }],
  customer_portal_tokens: [],
  cash_orders: [
    { id: "co-1", customer_id: "c-1", invoice_number: "19200", currency: "JPY", total_amount: 68000, total_paid: 20000, remaining_balance: 48000, status: "pending", order_date: "2026-09-02", item_description: "Diamond studs", created_at: "2026-09-02T03:00:00Z", source_channel: "hub", web_reference: null },
  ],
});

// ------------------------------------------------------------------ harness
function renderAt(path: string, ui: React.ReactElement, pattern = "*") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path={pattern} element={ui} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
// check_customer_email_conflict is a read-only RPC CustomerPortalShareMenu
// (unchanged) runs on mount; it is pinned separately in "reads … on open".
const writes = () => h.calls.filter((c) => c.kind !== "read" && c.target !== "check_customer_email_conflict");
const reads = () => h.calls.filter((c) => c.kind === "read").map((c) => ({ target: c.target, payload: c.payload, filters: c.filters }));
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const pencilButtons = () =>
  Array.from(document.querySelectorAll("svg.lucide-pencil")).map((s) => s.closest("button")).filter(Boolean) as HTMLButtonElement[];
/** Customer ids in the order the directory shows them (each row/card links to /customers/:id). */
const shownIds = () => {
  const ids = Array.from(document.querySelectorAll('a[href^="/customers/"]')).map((a) => a.getAttribute("href")!.slice("/customers/".length));
  return ids.filter((id, i) => ids.indexOf(id) === i);
};
const byName = [...directory].sort((a, b) => a.full_name.localeCompare(b.full_name));

beforeEach(() => {
  h.calls.length = 0;
  h.tables = {};
  h.rpc = {};
  h.perms = new Set(["create_account", "create_cash_order", "delete_customer"]);
  h.roles = ["admin"];
  vi.mocked(toast.error).mockClear();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  // Radix Checkbox measures itself.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

// Every flow runs at desktop width (ledger table) and phone width (cards).
for (const width of [1280, 375]) {
describe(`at ${width}px`, () => {
  beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width }); });

  // ================================================================ directory
  describe("Customer directory", () => {
    beforeEach(() => {
      h.tables = {
        customers: directory,
        layaway_accounts: [{ id: "a-1", customer_id: "c-00", status: "active", remaining_balance: 5000 }],
        cash_orders: [{ id: "co-1", customer_id: "c-00", status: "completed" }],
        loyalty_members: [{ customer_id: "c-00", current_tier: { name: "Radiant" } }],
      };
    });

    it("reads exactly the same four queries, and search / filter / group / page read nothing more", async () => {
      renderAt("/customers", <Customers />);
      await waitFor(() => expect(shownIds()).toHaveLength(50));
      const initial = reads();
      const key = (r: { target: string; payload: unknown }) => `${r.target} ${r.payload}`;
      expect([...initial].sort((a, b) => key(a).localeCompare(key(b)))).toEqual([
        { target: "cash_orders", payload: "id, customer_id, status", filters: [] },
        { target: "customers", payload: "*", filters: [] },
        // The toolbar's split button (unchanged) mounts RecordPaymentModal, which reads accounts.
        { target: "layaway_accounts", payload: "*, customers(full_name, messenger_link)", filters: [] },
        { target: "layaway_accounts", payload: "id, customer_id, status, currency, invoice_number, total_amount, total_paid, remaining_balance, payment_plan_months, order_date, created_at, updated_at, created_by_user_id, is_test", filters: [] },
        { target: "loyalty_members", payload: "customer_id, current_tier:current_tier_id(name)", filters: [] },
      ]);

      fireEvent.change(screen.getByPlaceholderText("Search customers..."), { target: { value: "reyes" } });
      fireEvent.change(screen.getByPlaceholderText("Search customers..."), { target: { value: "" } });
      fireEvent.click(button(/A–Z Filter/));
      fireEvent.click(button(/Grouped/));
      fireEvent.click(button(/^All$/));
      fireEvent.click(button("Next"));
      expect(reads()).toEqual(initial);
      expect(writes()).toEqual([]);
    });

    it("sorts by name and paginates 50 per page", async () => {
      renderAt("/customers", <Customers />);
      await waitFor(() => expect(shownIds()).toEqual(byName.slice(0, 50).map((c) => c.id)));
      expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
      // The label sits on the pager's own opaque card surface, never on the
      // bare background photo (owner visual check, PR #175).
      expect(screen.getByText(/Page 1 of 2/).parentElement).toHaveClass("bg-card", "rounded-full");
      expect(button("Previous")).toBeDisabled();
      fireEvent.click(button("Next"));
      await waitFor(() => expect(shownIds()).toEqual(byName.slice(50).map((c) => c.id)));
      expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
      expect(button("Next")).toBeDisabled();
    });

    it("searches name, Facebook name and customer code, and resets to page 1", async () => {
      renderAt("/customers", <Customers />);
      await waitFor(() => expect(shownIds()).toHaveLength(50));
      fireEvent.click(button("Next"));
      const search = screen.getByPlaceholderText("Search customers...");
      fireEvent.change(search, { target: { value: "reyes" } });
      await waitFor(() => expect(shownIds()).toEqual(byName.filter((c) => c.full_name.includes("Reyes")).map((c) => c.id)));
      fireEvent.change(search, { target: { value: "anna.fb" } });
      await waitFor(() => expect(shownIds()).toEqual(["c-07"]));
      fireEvent.change(search, { target: { value: "cj-2026-00016" } });
      await waitFor(() => expect(shownIds()).toEqual(["c-01"]));
      expect(screen.queryByText(/Page \d of/)).not.toBeInTheDocument();
      fireEvent.change(search, { target: { value: "zzz" } });
      await waitFor(() => expect(screen.getByText("No customers found")).toBeInTheDocument());
    });

    it("A–Z filter narrows to one letter; Grouped shows one letter group", async () => {
      renderAt("/customers", <Customers />);
      await waitFor(() => expect(shownIds()).toHaveLength(50));
      fireEvent.click(button(/A–Z Filter/));
      fireEvent.click(screen.getByRole("button", { name: /^B\s*\d+$/ }));
      await waitFor(() => expect(shownIds()).toEqual(byName.filter((c) => c.full_name.startsWith("B")).map((c) => c.id)));
      fireEvent.click(screen.getByRole("button", { name: /^#\s*\d+$/ }));
      await waitFor(() => expect(shownIds()).toEqual(["c-99"]));

      fireEvent.click(button(/Grouped/));
      await waitFor(() => expect(shownIds()).toEqual(byName.filter((c) => c.full_name.startsWith("A")).map((c) => c.id)));
      expect(screen.getByText("5 customers")).toBeInTheDocument();
    });

    it("pencil on a row opens Edit Customer pre-filled; Save sends the match check then the update", async () => {
      renderAt("/customers", <Customers />);
      await waitFor(() => expect(shownIds()).toHaveLength(50));
      // byName[0] is the first row / card.
      const first = byName[0];
      fireEvent.click(pencilButtons()[0]);
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByDisplayValue(first.full_name)).toBeInTheDocument();
      expect(within(dialog).getByDisplayValue(first.customer_code)).toBeDisabled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save Changes" }));
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(writes()).toEqual<Call[]>([
        { kind: "rpc", target: "find_customer_matches", payload: { p_full_name: first.full_name, p_facebook_name: null, p_mobile: null, p_email: null, p_exclude_customer_id: first.id } },
        {
          kind: "table.update", target: "customers", filters: [["eq", "id", first.id]],
          payload: { full_name: first.full_name, facebook_name: null, messenger_link: first.messenger_link, mobile_number: null, email: null, notes: null, location: first.location },
        },
      ]);
    });
  });

  // ============================================================ edit customer
  describe("Edit Customer dialog", () => {
    const form = {
      full_name: "Maria Santos", customer_code: "CJ-2026-00008", facebook_name: "", messenger_link: "",
      mobile_number: "", email: "", notes: "", locationType: "japan" as const, country: "",
    };
    function Harness({ initial = form }: { initial?: typeof form }) {
      const [f, setF] = React.useState(initial);
      return <EditCustomerDialog open onOpenChange={() => {}} editId="c-1" editForm={f} setEditForm={setF as never} />;
    }
    const field = (label: string) => {
      const l = screen.getByText(label, { selector: "label" });
      return l.parentElement!.querySelector("input, textarea") as HTMLInputElement;
    };

    it("saves every field exactly as typed (trimmed, blanks → null)", async () => {
      renderAt("/", <Harness />);
      fireEvent.change(field("Full Name *"), { target: { value: "  Maria S. Santos " } });
      fireEvent.change(field("Facebook Name"), { target: { value: " maria.fb " } });
      fireEvent.change(field("Messenger Link"), { target: { value: "https://m.me/maria" } });
      fireEvent.change(field("Mobile Number"), { target: { value: "+63 917 000 1234" } });
      fireEvent.change(field("Email"), { target: { value: "maria@example.com " } });
      fireEvent.change(field("Notes"), { target: { value: "Prefers GCash" } });
      fireEvent.click(button("Save Changes"));
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(writes()).toEqual<Call[]>([
        { kind: "rpc", target: "find_customer_matches", payload: { p_full_name: "Maria S. Santos", p_facebook_name: "maria.fb", p_mobile: "+63 917 000 1234", p_email: "maria@example.com", p_exclude_customer_id: "c-1" } },
        {
          kind: "table.update", target: "customers", filters: [["eq", "id", "c-1"]],
          payload: { full_name: "Maria S. Santos", facebook_name: "maria.fb", messenger_link: "https://m.me/maria", mobile_number: "+63 917 000 1234", email: "maria@example.com", notes: "Prefers GCash", location: "Japan" },
        },
      ]);
      expect(toast.success).toHaveBeenCalledWith("Customer updated");
    });

    it("a duplicate is blocked with the same message and nothing is saved", async () => {
      h.rpc.find_customer_matches = [{
        customer_id: "c-7", customer_code: "CJ-2026-00056", full_name: "Maria Santos", facebook_name: null,
        mobile_number: "+63 917 000 1234", email: null, location: "Philippines", has_login: true, matched_on: ["full_name", "mobile"],
      }];
      renderAt("/", <Harness />);
      fireEvent.click(button("Save Changes"));
      await screen.findByText("Existing customer found");
      expect(screen.getByText("Not saved. These changes would make this customer match another existing customer. Confirm the details with the customer and correct the fields; the same person must not have two accounts.")).toBeInTheDocument();
      expect(screen.getByText("CJ-2026-00056")).toBeInTheDocument();
      expect(screen.getByText(/Matched on: Full name, Mobile/)).toBeInTheDocument();
      expect(screen.getByText("Has portal login")).toBeInTheDocument();
      // Read-only on edit: no "Use this customer".
      expect(screen.queryByRole("button", { name: "Use this customer" })).not.toBeInTheDocument();
      expect(writes().map((c) => c.kind)).toEqual(["rpc"]);
    });

    it("International with no country is refused before any call", async () => {
      renderAt("/", <Harness initial={{ ...form, locationType: "international" as never }} />);
      fireEvent.click(button("Save Changes"));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Please select a country"));
      expect(writes()).toEqual([]);
    });

    it("Delete (delete_customer) invokes delete-customer with the bearer token", async () => {
      renderAt("/", <Harness />);
      fireEvent.click(button("Delete"));
      const alert = await screen.findByRole("alertdialog");
      expect(within(alert).getByText(/Customers with linked accounts cannot be deleted/)).toBeInTheDocument();
      fireEvent.click(within(alert).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()).toEqual<Call[]>([
        { kind: "invoke", target: "delete-customer", payload: { body: { customer_id: "c-1" }, headers: { Authorization: "Bearer tok" } } },
      ]);
    });

    it("role without delete_customer never sees Delete", () => {
      h.perms.delete("delete_customer");
      renderAt("/", <Harness />);
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
      expect(button("Save Changes")).toBeInTheDocument();
    });
  });

  // =================================================== duplicate block on create
  describe("New Customer — duplicate-customer block", () => {
    const match = {
      customer_id: "c-7", customer_code: "CJ-2026-00056", full_name: "Maria Santos", facebook_name: "maria.s",
      mobile_number: null, email: null, location: "Philippines", has_login: false, matched_on: ["full_name", "facebook_name"],
    };
    const typeName = () => {
      const l = screen.getByText("Full Name *", { selector: "label" });
      fireEvent.change(l.parentElement!.querySelector("input")!, { target: { value: "Maria Santos" } });
    };

    it("a duplicate is blocked with the same message; nothing is created", async () => {
      h.rpc.find_customer_matches = [match];
      renderAt("/", <NewCustomerDialog open onOpenChange={() => {}} />);
      typeName();
      fireEvent.click(button("Create Customer"));
      await screen.findByText("Existing customer found");
      expect(screen.getByText("This customer was NOT created. Confirm the details with the customer and use the existing account. If the form is wrong, correct it and submit again to re-check.")).toBeInTheDocument();
      expect(screen.getByText("No login")).toBeInTheDocument();
      expect(button("Re-check & Create")).toBeInTheDocument();
      expect(button("Use this customer")).toBeDisabled();
      expect(writes()).toEqual<Call[]>([
        { kind: "rpc", target: "find_customer_matches", payload: { p_full_name: "Maria Santos", p_facebook_name: null, p_mobile: null, p_email: null } },
      ]);
    });

    it("Use this customer (after confirming) loads it and writes the audit row", async () => {
      h.rpc.find_customer_matches = [match];
      h.tables = { customers: [{ ...maria, id: "c-7", customer_code: "CJ-2026-00056" }] };
      renderAt("/", <NewCustomerDialog open onOpenChange={() => {}} />);
      typeName();
      fireEvent.click(button("Create Customer"));
      await screen.findByText("Existing customer found");
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(button("Use this customer"));
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(writes()[1]).toEqual<Call>({
        kind: "table.insert", target: "audit_logs", filters: [],
        payload: {
          entity_type: "customer", entity_id: "c-7", action: "duplicate_prevented", performed_by_user_id: "u-staff",
          new_value_json: {
            source: "new_customer_dialog",
            typed: { full_name: "Maria Santos", facebook_name: null, messenger_link: null, mobile_number: null, email: null, location: "Japan" },
            matched_on: ["full_name", "facebook_name"],
            customer_code: "CJ-2026-00056",
          },
        },
      });
    });

    it("a non-duplicate proceeds to the insert", async () => {
      renderAt("/", <NewCustomerDialog open onOpenChange={() => {}} />);
      typeName();
      fireEvent.click(button("Create Customer"));
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(writes()[1]).toEqual<Call>({
        kind: "table.insert", target: "customers", filters: [],
        payload: { full_name: "Maria Santos", facebook_name: undefined, messenger_link: undefined, mobile_number: undefined, email: undefined, notes: undefined, location: "Japan" },
      });
    });
  });

  // ============================================================ customer page
  describe("Customer page", () => {
    beforeEach(() => { h.tables = detailTables(); });
    const open = async (path = "/customers/c-1") => {
      renderAt(path, <CustomerDetail />, "/customers/:customerId");
      await screen.findAllByText("Maria Santos");
      await screen.findAllByText(/19001/);
    };

    it("reads the same queries on open", async () => {
      await open();
      await waitFor(() => expect(reads().some((r) => r.target === "customer_portal_tokens")).toBe(true));
      const seen = reads().map((r) => `${r.target} ${r.payload} ${JSON.stringify(r.filters)}`);
      expect([...new Set(seen)].sort()).toEqual([
        'account_services * [["in","account_id",["a-1"]]]',
        'customer_portal_tokens token, expires_at [["eq","customer_id","c-1"],["eq","is_active",true]]',
        'customers * [["eq","id","c-1"]]',
        'layaway_accounts * [["eq","customer_id","c-1"]]',
        'layaway_schedule * [["in","account_id",["a-1"]]]',
        'payment_allocations * [["in","schedule_id",["sch-1","sch-2","sch-3"]]]',
        'payments * [["in","account_id",["a-1"]]]',
        'penalty_fees * [["in","account_id",["a-1"]]]',
      ].concat(PORTAL_MENU_READS).sort());
      expect(h.calls.filter((c) => c.kind === "rpc")).toEqual([
        { kind: "rpc", target: "check_customer_email_conflict", payload: { p_customer_id: "c-1" } },
      ]);
      expect(writes()).toEqual([]);
    });

    it("every action is there, each link goes where it did", async () => {
      await open();
      for (const name of ["Edit Details", "AI Insights", "Split Payment", "Messenger", "Set Portal PIN", "Submit Payment", "Pay in Full", "Forfeit", "Copy Message"]) {
        expect(screen.getAllByRole("button", { name: new RegExp(name) }).length).toBeGreaterThan(0);
      }
      const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
      expect(hrefs).toContain("/accounts/a-1");
      expect(hrefs).toContain("/accounts/new?customer_id=c-1");
      expect(hrefs).toContain("/customers");
      expect(hrefs).toContain("https://m.me/maria");
    });

    it("Edit Details saves the five fields", async () => {
      await open();
      fireEvent.click(button(/Edit Details/));
      const nameInput = screen.getByDisplayValue("Maria Santos");
      fireEvent.change(nameInput, { target: { value: " Maria L. Santos " } });
      fireEvent.change(screen.getByDisplayValue("maria@example.com"), { target: { value: "" } });
      fireEvent.click(button(/Save Changes/));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()).toEqual<Call[]>([
        {
          kind: "table.update", target: "customers", filters: [["eq", "id", "c-1"]],
          payload: { full_name: "Maria L. Santos", facebook_name: "maria.s", messenger_link: "https://m.me/maria", mobile_number: "+63 917 000 1234", email: null },
        },
      ]);
    });

    it("the location pencil saves the location only", async () => {
      await open();
      const locationPencil = pencilButtons().find((b) => !b.textContent?.trim())!;
      fireEvent.click(locationPencil);
      const confirm = document.querySelector("svg.lucide-check")!.closest("button")!;
      fireEvent.click(confirm);
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()).toEqual<Call[]>([
        { kind: "table.update", target: "customers", filters: [["eq", "id", "c-1"]], payload: { location: "Philippines" } },
      ]);
    });

    it("Set Portal PIN invokes set-portal-pin (admin / staff)", async () => {
      await open();
      fireEvent.click(button(/Set Portal PIN/));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByPlaceholderText("••••"), { target: { value: "12a34" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Set PIN" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()).toEqual<Call[]>([
        { kind: "invoke", target: "set-portal-pin", payload: { body: { customer_id: "c-1", pin: "1234" }, headers: undefined } },
      ]);
    });

    it("a CSR (no admin/staff role) never sees Set Portal PIN; no create perms → no New Layaway Order", async () => {
      h.roles = ["csr"];
      h.perms = new Set();
      await open();
      expect(screen.queryByRole("button", { name: /Set Portal PIN/ })).not.toBeInTheDocument();
      const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
      expect(hrefs).not.toContain("/accounts/new?customer_id=c-1");
    });

    it("Contact & notes card shows only with edit_customer (owner decision, PR #175)", async () => {
      h.perms = new Set([...h.perms, "edit_customer"]);
      await open();
      expect(screen.getByRole("region", { name: "Contact details" })).toBeInTheDocument();
    });

    it("no edit_customer (e.g. finance) → no Contact & notes card; Edit Details itself is unchanged", async () => {
      h.roles = ["finance"];
      h.perms = new Set(["create_account", "create_cash_order"]);
      await open();
      expect(screen.queryByRole("region", { name: "Contact details" })).not.toBeInTheDocument();
      expect(screen.queryByText("Contact & notes")).not.toBeInTheDocument();
      expect(button(/Edit Details/)).toBeInTheDocument();
      expect(writes()).toEqual([]);
    });

    it("Forfeit confirms, then invokes manual-forfeit for that account", async () => {
      await open();
      fireEvent.click(button(/Forfeit/));
      const alert = await screen.findByRole("alertdialog");
      expect(within(alert).getByText("Forfeit INV #19001?")).toBeInTheDocument();
      fireEvent.click(within(alert).getByRole("button", { name: "Forfeit" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()).toEqual<Call[]>([
        { kind: "invoke", target: "manual-forfeit", payload: { body: { account_id: "a-1" }, headers: undefined } },
      ]);
    });

    it("Copy Message copies the same consolidated message", async () => {
      const writeText = vi.fn();
      Object.assign(navigator, { clipboard: { writeText } });
      await open();
      fireEvent.click(button(/Copy Message/));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0]).toMatchSnapshot();
    });

    it("Cash Orders tab reads the same query and links each order and New Cash Order", async () => {
      renderAt("/customers/c-1?tab=cash", <CustomerDetail />, "/customers/:customerId");
      await screen.findAllByText(/19200/);
      expect(reads()).toContainEqual({
        target: "cash_orders",
        payload: "id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date, item_description, created_at, source_channel, web_reference",
        filters: [["eq", "customer_id", "c-1"]],
      });
      const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
      expect(hrefs).toContain("/cash-orders/co-1");
      expect(hrefs).toContain("/cash-orders/new?customer_id=c-1");
    });

    it("no create_cash_order → no New Cash Order", async () => {
      h.perms.delete("create_cash_order");
      renderAt("/customers/c-1?tab=cash", <CustomerDetail />, "/customers/:customerId");
      await screen.findAllByText(/19200/);
      const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
      expect(hrefs).not.toContain("/cash-orders/new?customer_id=c-1");
    });
  });
});
}

// Reads CustomerPortalShareMenu (unchanged, not restyled) makes on mount.
const PORTAL_MENU_READS: string[] = [
  'customer_portal_tokens * [["eq","customer_id","c-1"],["eq","is_active",true]]',
  'customers mobile_number [["eq","id","c-1"]]',
];

