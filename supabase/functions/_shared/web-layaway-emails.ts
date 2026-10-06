// Website-style ENGLISH emails for every routine WEB layaway event (payment
// lifecycle, email addendum 2026-10-06, items 2, 3 and 4).
//
// A layaway with source_channel 'web' gets LayawayUpdateEmail (storefront
// sender, plan link /account/layaway/:id) INSTEAD of the Hub portal template;
// a Hub-created plan keeps its portal email, untouched. The caller decides
// with routeLayawayEmail() and sends exactly one of the two.
//
//   payment_received_details  submit-payment (portal), website POST /layaway/:id/pay
//   instalment_reminder       send-reminders (cron)
//   penalty_applied / _escalation  penalty-engine (cron)
//   penalty_waived            approve-waiver
//   payment_voided            void-payment
//   reactivated               reactivate-account (extension granted)
//
// IDEMPOTENCY: each caller passes the SAME key its Hub template send uses
// (payment-submitted-<submission>, reminder-<schedule>-<stage>-<day>, …), so
// one logical event is one email whichever path runs; approve-waiver's
// Date.now() key is replaced by one per waiver batch (see webWaiverKey).
//
// CRON CALLERS pass the plan row they already read (`row`), so a web plan
// costs no extra query. Every figure shown is the one the caller passes from
// the Hub's records — this file and the template only format. English only,
// no language prop (owner rule; development/layaway-english.test.ts).
// NEVER throws: an email must not change the behaviour or the response of the
// function that triggered it.
import * as React from "npm:react@18.3.1";
import {
  sendStorefrontEmail, storefrontLayawayUrl,
  type SendStorefrontEmailArgs, type SendStorefrontEmailResult,
} from "./storefront-email.ts";
import { regionForCurrency } from "./transfer-methods.ts";
import {
  LayawayUpdateEmail, layawayUpdateSubject, type LayawayReminderKind, type LayawayUpdateVariant,
} from "./email-templates/layaway-update.tsx";
import { shortHash } from "./order-update-email.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js client, typed by the caller
type Db = any;
type AnyRec = Record<string, unknown>;

export type Send = (args: SendStorefrontEmailArgs) => Promise<SendStorefrontEmailResult>;
export interface EmailDeps { send?: Send }

export type WebLayawayVariant =
  | "payment_received_details" | "instalment_reminder" | "penalty_applied" | "penalty_escalation"
  | "penalty_waived" | "payment_voided" | "reactivated";

const VARIANTS = new Set<string>([
  "payment_received_details", "instalment_reminder", "penalty_applied", "penalty_escalation",
  "penalty_waived", "payment_voided", "reactivated",
]);

/** The columns a caller's row needs (cron callers add these to their existing select). */
export const WEB_LAYAWAY_COLUMNS =
  "id, web_reference, invoice_number, source_channel, currency, remaining_balance, customers(email, is_test)";

/** Which email a layaway event gets: 'website' for a web plan, 'hub' (portal template) otherwise. */
export function routeLayawayEmail(row: { source_channel?: unknown } | null | undefined): "website" | "hub" {
  return row?.source_channel === "web" ? "website" : "hub";
}

/** Map send-reminders' choice of Hub template `type` to the reminder copy. */
export function reminderKindFor(stage: string, isGracePeriod: boolean): LayawayReminderKind {
  if (isGracePeriod) return "grace_period";
  if (stage === "overdue" || stage === "penalty") return "overdue";
  if (stage === "due_today") return "due_today";
  return "upcoming";
}

/**
 * approve-waiver's key for a web plan: one per waiver batch (the request ids,
 * sorted), so a retry or a double-click never sends twice. The Hub path's
 * `penalty-waived-<account>-<Date.now()>` deduped nothing.
 */
export function webWaiverKey(accountId: string, waiverIds: unknown[]): string {
  const ids = waiverIds.map((x) => String(x)).sort().join(",");
  return `penalty-waived-${accountId}-${shortHash(ids)}`;
}

export interface WebLayawayEmailArgs {
  accountId: string;
  variant: WebLayawayVariant;
  idempotencyKey: string;
  /** The plan row the caller already read (WEB_LAYAWAY_COLUMNS); read here when absent. */
  row?: AnyRec | null;
  amount?: number | null;
  message?: string | null;
  dueDate?: string | null;
  dateDeadline?: string | null;
  /** Overrides row.remaining_balance when the caller just computed the new figure. */
  remaining?: number | null;
  totalPenalty?: number | null;
  daysOverdue?: number | null;
  reminderKind?: LayawayReminderKind | null;
  paymentDate?: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Send one website-style email for a WEB layaway. Returns the send result
 * (send-reminders marks its reminder_logs row from it), or null when nothing
 * was attempted: not found, not a web plan, unknown variant, or an error.
 */
export async function sendWebLayawayEmail(
  db: Db, args: WebLayawayEmailArgs, deps: EmailDeps = {},
): Promise<SendStorefrontEmailResult | null> {
  const log = (outcome: string) =>
    console.log(JSON.stringify({ web_layaway_email: args.variant, id: args.accountId, outcome }));
  try {
    if (!VARIANTS.has(args.variant)) {
      log("skipped_unknown_variant");
      return null;
    }
    let row = args.row ?? null;
    if (!row) {
      const { data, error } = await db.from("layaway_accounts").select(WEB_LAYAWAY_COLUMNS)
        .eq("id", args.accountId).maybeSingle();
      if (error || !data) {
        log("not_found");
        return null;
      }
      row = data as AnyRec;
    }
    if (routeLayawayEmail(row) !== "website") {
      log("skipped_not_web");
      return null;
    }

    const customer = (row.customers ?? {}) as AnyRec;
    const to = { email: (customer.email as string | null) ?? null, is_test: customer.is_test === true };
    const reference = String(row.web_reference ?? row.invoice_number ?? "");
    const currency = (String(row.currency ?? "JPY") === "PHP" ? "PHP" : "JPY") as "JPY" | "PHP";
    const remaining = args.remaining !== undefined ? num(args.remaining) : num(row.remaining_balance);
    const variant = args.variant as LayawayUpdateVariant;
    const send = deps.send ?? sendStorefrontEmail;

    return await send({
      to,
      subject: layawayUpdateSubject(variant, reference, args.reminderKind ?? null),
      label: `layaway-${variant.replace(/_/g, "-")}`,
      reference,
      idempotencyKey: args.idempotencyKey,
      element: React.createElement(LayawayUpdateEmail, {
        variant, reference, currency,
        amount: num(args.amount),
        message: String(args.message ?? "").trim() || null,
        region: regionForCurrency(currency),
        planUrl: storefrontLayawayUrl(String(row.id ?? args.accountId)),
        dueDate: args.dueDate ?? null,
        dateDeadline: args.dateDeadline ?? null,
        remaining,
        totalPenalty: num(args.totalPenalty),
        daysOverdue: num(args.daysOverdue),
        reminderKind: args.reminderKind ?? null,
        paymentDate: args.paymentDate ?? null,
      }),
    });
  } catch (e) {
    console.warn("[web-layaway-emails] send failed (non-blocking):", (e as Error)?.message ?? String(e));
    return null;
  }
}
