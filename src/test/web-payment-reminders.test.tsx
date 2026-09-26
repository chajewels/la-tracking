import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as rules from "../../supabase/functions/_shared/web-payment-reminder-rules.ts";

/**
 * Stage D payment reminders + the 48h reservation bell + the D17 fix
 * (docs/WEB-PAYMENT-REMINDERS.md). The SQL is the authority and is proven by
 * docs/sql/20261004_web_payment_reminders_local_tests.sql; this file pins the
 * TS mirror, the templates, the sender, the D17 regression and the Hub card.
 */

const code = (p: string) => readFileSync(p, "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const JAPANESE = /[぀-ヿ一-龯]/;
const MIGRATION = "supabase/migrations/20261004100000_web_payment_reminders.sql";
const ORDER_TPL = "supabase/functions/_shared/email-templates/order-payment-due.tsx";
const LAYAWAY_TPL = "supabase/functions/_shared/email-templates/layaway-deposit-due.tsx";
const SWEEP = "supabase/functions/web-payment-reminder-sweep/index.ts";
const SENDER = "supabase/functions/_shared/payment-reminder-emails.ts";

const H = 3_600_000;
const at = (base: Date, hours: number) => new Date(base.getTime() + hours * H);

describe("timing", () => {
  const confirmed = new Date("2026-10-04T00:00:00Z");

  it("24h deadline (first order): reminded when 6h or fewer remain, never inside the last hour", () => {
    const row = { readyConfirmedAt: confirmed, deadline: at(confirmed, 24) };
    expect(rules.reminderWindowHours(row.readyConfirmedAt, row.deadline)).toBe(6);
    expect(rules.isInReminderWindow(row, at(confirmed, 17))).toBe(false);      // 7h left
    expect(rules.isInReminderWindow(row, at(confirmed, 18))).toBe(true);       // 6h left
    expect(rules.isInReminderWindow(row, at(confirmed, 22.5))).toBe(true);     // 1.5h left
    expect(rules.isInReminderWindow(row, at(confirmed, 23.5))).toBe(false);    // 30 min left
    expect(rules.isInReminderWindow(row, at(confirmed, 25))).toBe(false);      // passed
  });

  it("72h deadline (returning customer): reminded when 24h or fewer remain", () => {
    const row = { readyConfirmedAt: confirmed, deadline: at(confirmed, 72) };
    expect(rules.reminderWindowHours(row.readyConfirmedAt, row.deadline)).toBe(24);
    expect(rules.isInReminderWindow(row, at(confirmed, 47))).toBe(false);      // 25h left
    expect(rules.isInReminderWindow(row, at(confirmed, 48))).toBe(true);       // 24h left
    expect(rules.isInReminderWindow(row, at(confirmed, 70))).toBe(true);
  });

  it("a moved (extended) deadline uses the long window; an unconfirmed order is never in a window", () => {
    expect(rules.reminderWindowHours(confirmed, at(confirmed, 96))).toBe(24);
    expect(rules.isInReminderWindow({ readyConfirmedAt: null, deadline: at(confirmed, 5) }, confirmed)).toBe(false);
    expect(rules.isInReminderWindow({ readyConfirmedAt: confirmed, deadline: null }, confirmed)).toBe(false);
  });

  it("the SQL encodes the same numbers", () => {
    const sql = code(MIGRATION);
    expect(sql).toMatch(/e\.deadline > now\(\) \+ interval '1 hour'/);
    expect(sql).toMatch(/e\.deadline - e\.ready_confirmed_at <= interval '30 hours'\s*THEN interval '6 hours' ELSE interval '24 hours'/);
    expect(rules.FIRST_ORDER_KIND_MAX_HOURS).toBe(30);
    expect(rules.MIN_HOURS_LEFT).toBe(1);
  });
});

describe("at most 2 per order, once per deadline", () => {
  it("cap", () => {
    expect(rules.MAX_PAYMENT_REMINDERS_PER_ORDER).toBe(2);
    expect(rules.underReminderCap(0)).toBe(true);
    expect(rules.underReminderCap(1)).toBe(true);
    expect(rules.underReminderCap(2)).toBe(false);
    expect(code(MIGRATION)).toMatch(/WHERE r\.entity_type = e\.entity_type AND r\.entity_id = e\.entity_id\) < 2/);
  });

  it("dedupe: UNIQUE per order + deadline, and the idempotency key carries the deadline", () => {
    expect(code(MIGRATION)).toMatch(/CONSTRAINT web_payment_reminders_once_per_deadline UNIQUE \(entity_type, entity_id, deadline\)/);
    const a = rules.paymentReminderIdempotencyKey("o1", "2026-10-04T10:00:00Z");
    expect(a).toBe(`payment-due-o1-${Date.parse("2026-10-04T10:00:00Z") / 1000}`);
    expect(rules.paymentReminderIdempotencyKey("o1", "2026-10-05T10:00:00Z")).not.toBe(a);
  });
});

describe("skipped after proof / paid / expired / unconfirmed / Hub-made (the SQL rule)", () => {
  const sql = code(MIGRATION);
  it("requires a live, confirmed, unpaid WEB order and no pending submission", () => {
    expect(sql).toMatch(/o\.source_channel = 'web'\s+AND o\.status::text = 'pending'\s+AND o\.payment_status = 'pending_transfer'/);
    expect(sql).toMatch(/AND o\.remaining_balance > 0/);
    expect(sql).toMatch(/a\.source_channel = 'web'\s+AND a\.status::text = 'active'/);
    expect(sql).toMatch(/AND coalesce\(a\.total_paid, 0\) = 0/);
    expect(sql).toMatch(/o\.ready_confirmed_at IS NOT NULL/);
    expect(sql).toMatch(/s\.cash_order_id = o\.id AND s\.status::text IN \('submitted','under_review'\)/);
    expect(sql).toMatch(/s\.account_id = a\.id AND s\.status::text IN \('submitted','under_review'\)/);
    expect(sql).toMatch(/payment_submission_allocations psa/);
  });

  it("the claim re-checks eligibility AND the switch under the order's row lock", () => {
    const claim = sql.slice(sql.indexOf("FUNCTION public.claim_web_payment_reminder"), sql.indexOf("FUNCTION public.finish_web_payment_reminder"));
    expect(claim).toMatch(/FOR UPDATE/);
    expect(claim).toMatch(/web_payment_reminder_eligible\(p_entity_type, p_entity_id\)/);
    expect(claim).toMatch(/web_payment_reminder_address_allowed\(r\.email\)/);
    expect(claim).toMatch(/r\.deadline IS DISTINCT FROM p_deadline/);
  });
});

describe("the switch: off → owner_only → on", () => {
  it("reads fail-closed", () => {
    expect(rules.readPaymentReminderMode("on")).toBe("on");
    expect(rules.readPaymentReminderMode("owner_only")).toBe("owner_only");
    for (const v of ["off", "ON", true, null, undefined, "yes", ""]) expect(rules.readPaymentReminderMode(v)).toBe("off");
  });

  it("off → nothing; owner_only → only owner addresses; on → everyone", () => {
    const owners = ["chajewelsjapan@gmail.com", "@chajewelsjp.com"];
    expect(rules.recipientAllowed("off", owners, "chajewelsjapan@gmail.com")).toBe(false);
    expect(rules.recipientAllowed("owner_only", owners, "ChaJewelsJapan@gmail.com ")).toBe(true);
    expect(rules.recipientAllowed("owner_only", owners, "en1@chajewelsjp.com")).toBe(true);
    expect(rules.recipientAllowed("owner_only", owners, "buyer@example.com")).toBe(false);
    expect(rules.recipientAllowed("owner_only", owners, "x@notchajewelsjp.com.evil")).toBe(false);
    expect(rules.recipientAllowed("on", owners, "buyer@example.com")).toBe(true);
  });

  it("the migration seeds OFF and the owner list, never overwrites, and the sweep stops when off", () => {
    const sql = code(MIGRATION);
    expect(sql).toMatch(/'web_payment_reminders_mode', '"off"'::jsonb/);
    expect(sql).toMatch(/'web_payment_reminders_owner_addresses', '\["chajewelsjapan@gmail\.com", "@chajewelsjp\.com"\]'::jsonb/);
    expect((sql.match(/ON CONFLICT \(key\) DO NOTHING/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/IF public\.web_payment_reminder_mode\(\) = 'off' THEN\s+RETURN;/);
    expect(stripComments(code(SWEEP))).toMatch(/if \(mode === "off"\) \{/);
  });

  it("owner entries are validated", () => {
    expect(rules.isValidOwnerEntry("owner@example.com")).toBe(true);
    expect(rules.isValidOwnerEntry("@chajewelsjp.com")).toBe(true);
    expect(rules.isValidOwnerEntry("not an address")).toBe(false);
    expect(rules.isValidOwnerEntry("@nodot")).toBe(false);
  });
});

describe("transactional: never blocked by a cart-reminder opt-out", () => {
  it("neither the SQL nor the sender reads consent, newsletter, cart-reminder or suppression data", () => {
    const sql = code(MIGRATION);
    // The three functions that decide who gets a reminder, comments stripped.
    const sqlCode = sql.slice(sql.indexOf("FUNCTION public.web_payment_reminder_mode()"), sql.indexOf("FUNCTION public.finish_web_payment_reminder"))
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      .replace(/COMMENT ON FUNCTION[\s\S]*?';\n/g, "");
    expect(sqlCode).toMatch(/web_payment_reminder_eligible/);
    for (const src of [sqlCode, stripComments(code(SWEEP)), stripComments(code(SENDER))]) {
      expect(src).not.toMatch(/consent|newsletter|cart_reminder|suppressed_emails|opt_out|unsubscrib/i);
    }
    expect(stripComments(code(SENDER))).toMatch(/sendStorefrontEmail\(/);
  });
});

describe("test customers", () => {
  it("excluded unless the address is one the owner reads (the storefront test gate)", () => {
    expect(rules.passesTestGate(true, "throwaway@example.com")).toBe(false);
    expect(rules.passesTestGate(true, "chajewelsjapan@gmail.com")).toBe(true);
    expect(rules.passesTestGate(true, "en1@chajewelsjp.com")).toBe(true);
    expect(rules.passesTestGate(false, "buyer@example.com")).toBe(true);
    expect(code(MIGRATION)).toMatch(/AND \(NOT e\.is_test OR lower\(e\.email\) = 'chajewelsjapan@gmail\.com' OR lower\(e\.email\) LIKE '%@chajewelsjp\.com'\)/);
  });
});

describe("content", () => {
  const PROMO = /you may also like|recommend|new arrival|discount|coupon|shop now|reserve with|0% interest|おすすめ|新作|クーポン|割引|セール/i;
  const LAYAWAY_JA = /分割|レイアウェイ|頭金|お申込金|お取り置き/;

  it("cash order: the amount owed in the ORDER's currency, JA first then EN, no promotion, no layaway", () => {
    const t = code(ORDER_TPL);
    expect(t).toMatch(/orderMoney\(p\.amount, p\.currency\)/);
    expect(t).toMatch(/<MethodCards methods=\{p\.methods\} lang=\{lang\} \/>/);
    expect(t).toMatch(/\{p\.lang === 'ja' && \(\s*<>\s*<Hr style=\{rule\} \/>\s*<Block lang="en"/);
    expect(stripComments(t)).not.toMatch(PROMO);
    expect(t).not.toMatch(LAYAWAY_JA);
    expect(stripComments(t)).not.toMatch(/layaway/i);
  });

  it("layaway: English only by construction — no lang prop, no Japanese, the deposit, no promotion", () => {
    const t = code(LAYAWAY_TPL);
    expect(t).not.toMatch(JAPANESE);
    expect(t).not.toMatch(/\blang: Lang\b|p\.lang/);
    expect(t).toMatch(/<Html lang="en"/);
    expect(t).toMatch(/formatMoney\(p\.deposit, p\.currency\)/);
    expect(t).toMatch(/<MethodCards methods=\{p\.methods\} lang="en" \/>/);
    expect(stripComments(t)).not.toMatch(PROMO);
  });

  it("language, currency and amount come from the claimed row; layaway is always English", () => {
    expect(rules.paymentReminderLang("layaway", "ja")).toBe("en");
    expect(rules.paymentReminderLang("layaway", null)).toBe("en");
    expect(rules.paymentReminderLang("cash_order", "en")).toBe("en");
    expect(rules.paymentReminderLang("cash_order", null)).toBe("ja");
    const sql = code(MIGRATION);
    expect(sql).toMatch(/'en'::text,\s+-- layaway emails are English only, always/);
    expect(sql).toMatch(/o\.currency::text AS currency, o\.remaining_balance AS amount/);
    expect(sql).toMatch(/a\.currency::text, a\.downpayment_amount/);
    const s = stripComments(code(SENDER));
    expect(s).toMatch(/select\("entity_type, entity_id, deadline, reference, email, lang, currency, amount"\)/);
    expect(s).toMatch(/transferMethods\(supabase, currency\)/);
    expect(s).toMatch(/region: regionForCurrency\(currency\)/);
    expect(s).toMatch(/deposit: Number\(r\.amount \?\? 0\)/);
  });

  it("labels, finish statuses and previews", () => {
    expect(rules.paymentReminderLabel("cash_order")).toBe("order-payment-due");
    expect(rules.paymentReminderLabel("layaway")).toBe("layaway-deposit-due");
    expect(rules.reminderFinishStatus({ sent: true })).toBe("sent");
    expect(rules.reminderFinishStatus({ sent: false, reason: "recipient_suppressed" })).toBe("suppressed");
    expect(rules.reminderFinishStatus({ sent: false, reason: "error" })).toBe("failed");
    expect(rules.reminderFinishStatus({ sent: false, reason: "test_customer" })).toBe("skipped");
    const reg = code("supabase/functions/_shared/email-templates/preview-registry.ts");
    for (const k of ["storefront-order-payment-due-php-ja", "storefront-order-payment-due-en", "storefront-layaway-deposit-due"]) {
      expect(reg).toContain(`'${k}'`);
    }
  });
});

describe("the sweep function", () => {
  const s = stripComments(code(SWEEP));
  it("service role or system_health; candidates → claim → send → finish", () => {
    expect(s).toMatch(/requireAuth\(req, \{ allowServiceRole: true \}\)/);
    expect(s).toMatch(/requirePermission\(ctx, "system_health"\)/);
    expect(s).toMatch(/rpc\("web_payment_reminder_candidates"/);
    expect(s).toMatch(/rpc\("claim_web_payment_reminder"/);
    expect(s).toMatch(/if \(!claimId\) \{/);
    expect(s).toMatch(/rpc\("finish_web_payment_reminder"/);
    expect(code("supabase/config.toml")).toMatch(/\[functions\.web-payment-reminder-sweep\]\s+verify_jwt = true/);
  });

  it("the cron job posts to it hourly at :13 with the Vault key", () => {
    const sql = code(MIGRATION);
    expect(sql).toMatch(/cron\.schedule\('web-payment-reminder-sweep', '13 \* \* \* \*'/);
    expect(sql).toMatch(/\/functions\/v1\/web-payment-reminder-sweep/);
    expect(sql).toMatch(/vault\.decrypted_secrets WHERE name = 'email_queue_service_role_key'/);
  });
});

describe("48h staff bell", () => {
  const sql = code(MIGRATION);
  const fn = sql.slice(sql.indexOf("FUNCTION public.web_reservation_expiring_bells"), sql.indexOf("COMMENT ON FUNCTION public.web_reservation_expiring_bells"));
  it("web reservations unconfirmed 48–72h, once per reservation, its own cron job (whatever the switch)", () => {
    expect(fn).toMatch(/created_at <= now\(\) - interval '48 hours' AND o\.created_at > now\(\) - interval '72 hours'/);
    expect(fn).toMatch(/source_channel = 'web' AND o\.ready_confirmed_at IS NULL AND o\.status::text = 'pending'/);
    expect(fn).toMatch(/n\.type = 'web_reservation_expiring'\s+AND n\.metadata ->> 'entity_id' = d\.id::text/);
    expect(fn).not.toMatch(/web_payment_reminder_mode/);
    expect(sql).toMatch(/cron\.schedule\('web-reservation-expiring-bell', '13 \* \* \* \*',\s+\$cron\$SELECT public\.web_reservation_expiring_bells\(\);\$cron\$\)/);
  });
  it("the bell has an icon and links to the order", () => {
    const bell = code("src/components/notifications/StaffNotificationBell.tsx");
    expect(bell).toMatch(/case 'web_reservation_expiring':/);
    expect(fn).toMatch(/'cash_order_id', d\.id/);
    expect(fn).toMatch(/CASE WHEN d\.entity_type = 'layaway' THEN d\.id END/);
  });
});

describe("D17 — layaway-expired is always English", () => {
  it("auto-expire-cash-orders sends it with lang \"en\", never pickLang(customer_lang)", () => {
    const src = stripComments(code("supabase/functions/auto-expire-cash-orders/index.ts"));
    const branch = src.slice(src.indexOf('label: "layaway-expired"'), src.indexOf("layawayResults.push"));
    expect(branch).toMatch(/React\.createElement\(LayawayExpiredEmail, \{\s+lang: "en",/);
    expect(src).not.toMatch(/pickLang\(\(plan as any\)\.customer_lang\)/);
    // The cash branch keeps the customer's language.
    expect(src).toMatch(/lang: pickLang\(\(order as any\)\.customer_lang\)/);
  });
  it("the template renders Japanese only when asked for 'ja'", () => {
    expect(code("supabase/functions/_shared/email-templates/layaway-expired.tsx")).toMatch(/\{p\.lang === 'ja' && \(/);
  });
});

// ------------------------------------------------------------------ Hub UI
const rpc = vi.fn();
let roles: string[] = ["admin"];
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles }) }));
const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: unknown[]) => toastSpy(...a) }));

import { PaymentRemindersCard } from "@/components/settings/PaymentRemindersCard";
import OrderEmailHistory from "@/components/orders/OrderEmailHistory";
import { paymentRemindersEffect } from "@/components/settings/payment-reminders";

type State = Record<string, unknown>;
let state: State;
const base = (over: State = {}): State => ({
  found: true, mode: "off", owner_addresses: ["chajewelsjapan@gmail.com", "@chajewelsjp.com"],
  updated_at: "2026-10-04T01:00:00Z", updated_by_user_id: "u-1", updated_by_name: "Cynthia",
  can_change: true, due_now: 3, sent_7d: 0, ...over,
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
    if (name === "get_web_payment_reminders") return { data: state, error: null };
    if (name === "set_web_payment_reminders") {
      state = { ...state, mode: args.p_mode, owner_addresses: args.p_owner_addresses ?? state.owner_addresses };
      return { data: { ok: true, changed: true, mode: args.p_mode }, error: null };
    }
    if (name === "get_order_email_history") {
      return { data: {
        references: ["CJ-W-000201"],
        emails: [{ created_at: "2026-10-04T05:13:00Z", template: "order-payment-due", status: "sent", recipient: "chajewelsjapan@gmail.com", error: null, skip_reason: null }],
        payment_reminders: [{ claimed_at: "2026-10-04T05:13:00Z", finished_at: null, deadline: "2026-10-04T10:00:00Z", status: "sent", detail: null, lang: "ja", currency: "PHP", amount: 27076, email: "chajewelsjapan@gmail.com" }],
      }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
});

describe("Settings → Payment reminders card", () => {
  it("shows the mode, who changed it, and what it does", async () => {
    mount(<PaymentRemindersCard />);
    expect(await screen.findByTestId("payment-reminders-state")).toHaveTextContent("Off");
    expect(screen.getByTestId("payment-reminders-changed")).toHaveTextContent(/by Cynthia/);
    expect(screen.getByTestId("payment-reminders-effect")).toHaveTextContent(paymentRemindersEffect("off"));
  });

  it("an admin moves Off → Owner addresses only through a confirm, sending the mode they saw", async () => {
    mount(<PaymentRemindersCard />);
    fireEvent.click(await screen.findByLabelText("Owner addresses only"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_web_payment_reminders",
      { p_mode: "owner_only", p_owner_addresses: null, p_expected_mode: "off" }));
    expect(await screen.findByTestId("payment-reminders-state")).toHaveTextContent("Owner addresses only");
  });

  it("turning ON says how many orders are due now", async () => {
    state = base({ mode: "owner_only" });
    mount(<PaymentRemindersCard />);
    fireEvent.click(await screen.findByLabelText("On for every customer"));
    expect(await screen.findByTestId("payment-reminders-due")).toHaveTextContent("3 orders are due a reminder now");
  });

  it("rejects an owner entry that is neither an address nor @domain before sending", async () => {
    mount(<PaymentRemindersCard />);
    const box = await screen.findByLabelText(/Owner addresses \(one per line/);
    fireEvent.change(box, { target: { value: "chajewelsjapan@gmail.com\nnot an address" } });
    expect(screen.getByTestId("payment-reminders-owner-error")).toHaveTextContent("not an address");
    expect(screen.getByRole("button", { name: "Save owner addresses" })).toBeDisabled();
  });

  it("a non-admin gets no control", async () => {
    roles = ["staff"];
    state = base({ can_change: false });
    mount(<PaymentRemindersCard />);
    expect(await screen.findByTestId("payment-reminders-readonly")).toHaveTextContent("Only an admin can change this.");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("Order page → Customer emails", () => {
  it("lists the payment reminder in the order's email history", async () => {
    mount(<OrderEmailHistory entityType="cash_order" entityId="a1" />);
    expect(await screen.findByText("Payment reminder")).toBeInTheDocument();
    expect(screen.getByTestId("order-email-history-reminders")).toHaveTextContent(/sent for the deadline .* ₱27,076 · Japanese \+ English/);
    expect(rpc).toHaveBeenCalledWith("get_order_email_history", { p_entity_type: "cash_order", p_entity_id: "a1" });
  });
});
