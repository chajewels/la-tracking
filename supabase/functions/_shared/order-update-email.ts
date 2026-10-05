// Generic UPDATE emails for WEBSITE orders and WEBSITE layaways (payment
// lifecycle H4, spec §5 B, C and D2):
//   needs_info        a reviewer marked a payment "needs clarification";
//   deadline_moved    staff moved the deadline (set-account-deadlines);
//   shipped           staff entered a tracking number (notify-shipped);
//   details_received  staff recorded a payment for a web ORDER (D2);
//   rejected          a reviewer rejected a payment on a web LAYAWAY (§5 C).
//
// ONLY for source_channel 'web'. A Hub order / plan returns without sending and
// the caller keeps its existing Hub email. A cash-order 'rejected' is NOT sent
// here: sendCashPaymentRejectedEmail (_shared/payment-rejected-email.ts) owns it.
// 'details_received' is an order email only — layaway receipts are uploaded by
// the customer herself.
//
// Order emails: the customer's language (emailLang). Layaway emails: English
// only, no language prop (owner rule). Every send goes through
// sendStorefrontEmail (test gate, Reply-To, one email_send_log row per attempt).
// NEVER throws: an email must not fail the review, deadline move or tracking
// save that triggered it.
import * as React from "npm:react@18.3.1";
import {
  emailLang, sendStorefrontEmail, snapshotCountry, storefrontLayawayUrl, storefrontOrderUrl,
} from "./storefront-email.ts";
import { regionForCurrency } from "./transfer-methods.ts";
import {
  OrderUpdateEmail, orderUpdateSubject, type OrderUpdateVariant,
} from "./email-templates/order-update.tsx";
import {
  LayawayUpdateEmail, layawayUpdateSubject, type LayawayUpdateVariant,
} from "./email-templates/layaway-update.tsx";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js client, typed by the caller
type Db = any;
type AnyRec = Record<string, unknown>;

export type { OrderUpdateVariant, LayawayUpdateVariant };

export interface SendOrderUpdateArgs {
  entity: "cash_order" | "layaway";
  id: string;
  variant: OrderUpdateVariant | "rejected";
  /** Staff message, shown to the customer as plain text. */
  message?: string | null;
  /** The payment the update is about, in the order's / plan's currency. */
  amount?: number | null;
  idempotencyKey: string;
}

/** True only for a website order / plan. */
export function isWebEntity(row: { source_channel?: unknown } | null | undefined): boolean {
  return row?.source_channel === "web";
}

export type SubmissionEmailRoute =
  | "cash_rejected" | "order_needs_info" | "layaway_update" | "hub_template" | "none";

/**
 * Which email review-payment-submission sends for a review (H5, spec §5 B/C):
 *   cash order rejected             → cash_rejected (sendCashPaymentRejectedEmail, web and Hub)
 *   web cash order needs clarif.    → order_needs_info (sendOrderUpdateEmail 'needs_info')
 *   Hub cash order needs clarif.    → none (unchanged)
 *   web layaway rejected / clarif.  → layaway_update (sendOrderUpdateEmail, INSTEAD of the Hub template)
 *   Hub layaway rejected / clarif.  → hub_template (unchanged)
 *   confirmed                       → none (confirm has its own existing path)
 */
export function routeSubmissionEmail(input: {
  action: "confirmed" | "rejected" | "needs_clarification";
  isCashOrder: boolean;
  isWeb: boolean;
}): SubmissionEmailRoute {
  if (input.action === "confirmed") return "none";
  if (input.isCashOrder) {
    if (input.action === "rejected") return "cash_rejected";
    return input.isWeb ? "order_needs_info" : "none";
  }
  return input.isWeb ? "layaway_update" : "hub_template";
}

/**
 * FNV-1a 32-bit of a string's UTF-8 bytes, as 8 lowercase hex chars.
 * Deterministic and dependency-free: used to make an email idempotency key
 * depend on the reviewer's message text.
 */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Idempotency key for a review email (needs_info / rejected) on one
 * submission: includes a hash of the reviewer's message, so a retry or a
 * double-click with the same text dedupes, while a FOLLOW-UP question on the
 * same submission (different text) is sent.
 */
export function reviewEmailKey(variant: string, submissionId: string, message: string | null | undefined): string {
  return `${variant}-${submissionId}-${shortHash(String(message ?? ""))}`;
}

/** The placeholder shipping_methods.tracking_url_template uses (src/lib/tracking-link.ts). */
const TRACKING_PLACEHOLDER = "{tracking_code}";

/**
 * The carrier link, built exactly as the Hub and portal build it
 * (src/lib/tracking-link.ts buildTrackingUrl; that file is browser code, so it
 * is mirrored here, not imported): no method, template or number → null; a
 * method without deeplink support, or a template without the placeholder, is a
 * landing page returned as is; otherwise the bare number (spaces and hyphens
 * stripped — Yamato refuses "4725-7551-6733") fills {tracking_code}.
 */
export function trackingUrlFor(
  method: { tracking_url_template?: unknown; supports_deeplink?: unknown } | null | undefined,
  trackingNumber: unknown,
): string | null {
  const t = typeof method?.tracking_url_template === "string" ? method.tracking_url_template : "";
  const n = typeof trackingNumber === "string" ? trackingNumber : "";
  if (!method || !t || !n) return null;
  if (method.supports_deeplink !== true || !t.includes(TRACKING_PLACEHOLDER)) return t;
  return t.replace(TRACKING_PLACEHOLDER, encodeURIComponent(n.replace(/[\s\u3000-]/g, "").trim()));
}

const ORDER_VARIANTS = new Set<string>(["needs_info", "deadline_moved", "shipped", "details_received"]);
const LAYAWAY_VARIANTS = new Set<string>(["rejected", "needs_info", "deadline_moved", "shipped"]);

const ORDER_COLUMNS =
  "id, web_reference, invoice_number, source_channel, customer_lang, ship_to_snapshot, currency, transfer_due_at, tracking_number, shipping_method_id, customers(email, is_test)";
// layaway_accounts has every column above too (web layaway schema 2026-09-14,
// shipment tracking 2026-08-30, ship_to_snapshot 2026-09-15). customer_lang is
// read but never used: layaway emails are English only.
const LAYAWAY_COLUMNS =
  "id, web_reference, invoice_number, source_channel, customer_lang, ship_to_snapshot, currency, transfer_due_at, tracking_number, shipping_method_id, customers(email, is_test)";

/**
 * The courier row, read by id. Not embedded: both order tables carry TWO
 * foreign keys to shipping_methods (shipping_method_id and
 * planned_shipping_method_id), so a bare `shipping_methods(...)` embed is
 * ambiguous to PostgREST.
 */
async function shippingMethod(db: Db, id: unknown): Promise<AnyRec | null> {
  if (!id) return null;
  const { data } = await db
    .from("shipping_methods")
    .select("provider_name, title, tracking_url_template, supports_deeplink")
    .eq("id", String(id))
    .maybeSingle();
  return (data ?? null) as AnyRec | null;
}

export async function sendOrderUpdateEmail(db: Db, args: SendOrderUpdateArgs): Promise<void> {
  const log = (outcome: string) =>
    console.log(JSON.stringify({ order_update_email: args.variant, entity: args.entity, id: args.id, outcome }));
  try {
    if (args.entity === "cash_order" && !ORDER_VARIANTS.has(args.variant)) {
      // 'rejected' on a cash order is sendCashPaymentRejectedEmail's job.
      log("skipped_variant_not_for_orders");
      return;
    }
    if (args.entity === "layaway" && !LAYAWAY_VARIANTS.has(args.variant)) {
      log("skipped_variant_not_for_layaway");
      return;
    }

    const table = args.entity === "cash_order" ? "cash_orders" : "layaway_accounts";
    const { data: row, error } = await db
      .from(table)
      .select(args.entity === "cash_order" ? ORDER_COLUMNS : LAYAWAY_COLUMNS)
      .eq("id", args.id)
      .maybeSingle();
    if (error || !row) {
      log("not_found");
      return;
    }
    if (!isWebEntity(row)) {
      log("skipped_not_web");
      return;
    }

    const r = row as AnyRec;
    const customer = (r.customers ?? {}) as AnyRec;
    const to = { email: (customer.email as string | null) ?? null, is_test: customer.is_test === true };
    const reference = String(r.web_reference ?? r.invoice_number ?? "");
    const currency = (String(r.currency ?? "JPY") === "PHP" ? "PHP" : "JPY") as "JPY" | "PHP";
    const region = regionForCurrency(currency);
    const message = String(args.message ?? "").trim() || null;
    const amount = typeof args.amount === "number" && Number.isFinite(args.amount) ? args.amount : null;

    let courier: string | null = null;
    let trackingNumber: string | null = null;
    let trackingUrl: string | null = null;
    if (args.variant === "shipped") {
      trackingNumber = String(r.tracking_number ?? "").trim() || null;
      const method = await shippingMethod(db, r.shipping_method_id);
      courier = method ? (String(method.provider_name ?? method.title ?? "").trim() || null) : null;
      trackingUrl = trackingUrlFor(method, trackingNumber);
    }

    if (args.entity === "cash_order") {
      const variant = args.variant as OrderUpdateVariant;
      const lang = emailLang(r.customer_lang, snapshotCountry(r));
      await sendStorefrontEmail({
        to,
        subject: orderUpdateSubject(variant, reference, lang),
        label: `order-update-${variant}`,
        reference,
        idempotencyKey: args.idempotencyKey,
        element: React.createElement(OrderUpdateEmail, {
          lang, variant, reference, currency, amount, message,
          deadline: (r.transfer_due_at as string | null) ?? null,
          region, courier, trackingNumber, trackingUrl,
          orderUrl: storefrontOrderUrl(String(r.id)),
        }),
      });
      return;
    }

    const variant = args.variant as LayawayUpdateVariant;
    await sendStorefrontEmail({
      to,
      subject: layawayUpdateSubject(variant, reference),
      label: `layaway-update-${variant}`,
      reference,
      idempotencyKey: args.idempotencyKey,
      element: React.createElement(LayawayUpdateEmail, {
        variant, reference, currency, amount, message,
        deadline: (r.transfer_due_at as string | null) ?? null,
        region, courier, trackingNumber, trackingUrl,
        planUrl: storefrontLayawayUrl(String(r.id)),
      }),
    });
  } catch (e) {
    console.warn("[order-update-email] send failed (non-blocking):", (e as Error)?.message ?? String(e));
  }
}
