/**
 * PA14 (owner go 2026-10-08 23:16 JST): a staff cancellation of a web order
 * has stages — Paidy release → terminate → bells/portal → email. The INTENT is
 * recorded before the first stage and advanced after each, so an interrupted
 * cancel is visible (cash_order_cancel_intents) and the sweep can FINISH the
 * stages whose money side is already done (owner decision: from
 * paidy_released onward; an intent stuck at `started` only rings a bell).
 *
 * Everything that runs after the terminate RPC lives here, shared by
 * cancel-cash-order (the normal path) and paidy-reconcile (finishing an
 * interrupted one). Every emission is idempotent: bells are keyed on
 * (type, metadata.cash_order_id), the email on `order-cancelled-<id>`.
 */
import { emitNotification } from "./emit-notification.ts";
import { sendWebCancellationEmail } from "./web-cancellation-email.ts";
import type { RefundStatus } from "./email-templates/order-cancelled.tsx";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;

export type CancelIntentStage = "started" | "paidy_released" | "terminated" | "notified" | "done" | "abandoned";

export async function openCancelIntent(supabase: Db, a: {
  cash_order_id: string; user_id: string; user_email?: string | null; reason: string;
  refund_status?: string | null; refund_note?: string | null;
}): Promise<string | null> {
  const { data, error } = await supabase.from("cash_order_cancel_intents").insert({
    cash_order_id: a.cash_order_id, user_id: a.user_id, user_email: a.user_email ?? null, reason: a.reason,
    refund_status: a.refund_status ?? null, refund_note: a.refund_note ?? null, stage: "started",
  }).select("id").single();
  if (error) { console.error("[cancel-intent] open failed:", error); return null; }
  return String((data as AnyRec).id);
}

export async function advanceCancelIntent(supabase: Db, id: string | null, stage: CancelIntentStage, lastError?: string | null): Promise<void> {
  if (!id) return;
  const { error } = await supabase.from("cash_order_cancel_intents")
    .update({ stage, last_error: lastError ?? null, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) console.error(`[cancel-intent] advance to ${stage} failed:`, error);
}

export async function resolveCustomerName(supabase: Db, customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  try {
    const { data } = await supabase.from("customers").select("full_name").eq("id", customerId).maybeSingle();
    return (data?.full_name as string) ?? null;
  } catch { return null; }
}

/** A staff bell, once per (type, order): the sweep may run this again. */
async function bellOnce(supabase: Db, type: string, cashOrderId: string, row: AnyRec): Promise<void> {
  try {
    const { data } = await supabase.from("staff_notifications").select("id").eq("type", type)
      .contains("metadata", { cash_order_id: cashOrderId }).limit(1);
    if ((data ?? []).length > 0) return;
    await supabase.from("staff_notifications").insert({ ...row, type, metadata: { ...(row.metadata ?? {}), cash_order_id: cashOrderId } });
  } catch (e) {
    console.warn(`[cancel-followups] ${type} bell failed (non-blocking):`, e);
  }
}

export interface CancellationResult extends AnyRec {
  success?: boolean; invoice_number?: string | null; web_reference?: string | null; currency?: string | null;
  money_received?: number | null; refund_status?: string | null; store_credit?: AnyRec | null;
  cancellation_split?: AnyRec | null; earned_points_revoked_tx?: string | null;
}

/**
 * Bells, portal notifications and (web) the cancellation email — after the
 * terminate RPC committed. Never throws. `c` is the RPC's result, or the
 * snapshot `cancellationSnapshot()` rebuilds when the sweep finishes an
 * interrupted cancel.
 */
export async function emitCancellationFollowups(supabase: Db, a: {
  cash_order_id: string; isWeb: boolean; c: CancellationResult; orderRow: AnyRec;
  reason: string; refundStatus: RefundStatus | null; refundNote: string | null;
}): Promise<void> {
  const { c, isWeb, orderRow } = a;
  const curr = c.currency ?? c.store_credit?.currency;
  const symbol = curr === "PHP" ? "₱" : "¥";
  const ref = isWeb ? `Order ${c.web_reference ?? orderRow.web_reference ?? c.invoice_number}` : `Cash Order #${c.invoice_number}`;
  const custId = c.store_credit?.customer_id ?? orderRow.customer_id ?? null;
  const name = await resolveCustomerName(supabase, custId);

  // (a) Store credit minted from money actually received (web: only when
  //     staff chose "store credit issued"; Hub cash orders: always).
  if (c.store_credit) {
    const money = Number(c.store_credit.amount ?? c.money_received ?? 0).toLocaleString("en-US");
    const kept = Number(c.cancellation_split?.kept ?? 0);
    const charge = kept > 0 ? ` — 30% cancellation charge ${symbol}${kept.toLocaleString("en-US")} kept` : "";
    await bellOnce(supabase, "store_credit_issued", a.cash_order_id, {
      title: "Store credit issued on cancellation",
      body: `${name ? name + " — " : ""}${ref} cancelled, ${symbol}${money} store credit issued (valid 1 year)${charge}`,
      customer_id: custId, invoice_number: c.invoice_number, metadata: c,
    });
  } else if (isWeb && Number(c.money_received ?? 0) > 0) {
    await bellOnce(supabase, "web_order_refund", a.cash_order_id, {
      title: c.refund_status === "refund_pending" ? "Refund pending on cancelled web order"
        : c.refund_status === "no_refund" ? "Web order cancelled, no refund (forfeited)" : "Web order cancelled with refund",
      body: `${name ? name + " — " : ""}${ref} cancelled, ${symbol}${Number(c.money_received ?? 0).toLocaleString("en-US")} received, decision: ${String(c.refund_status ?? "").replace("_", " ")}`,
      customer_id: custId, invoice_number: c.invoice_number, metadata: c,
    });
  }

  // (b) Loyalty points earned on the order were revoked.
  if (c.earned_points_revoked_tx != null) {
    await bellOnce(supabase, "loyalty_revoked", a.cash_order_id, {
      title: "Loyalty points revoked",
      body: `${name ? name + " — " : ""}Loyalty points earned on ${ref} were revoked (order cancelled)`,
      customer_id: custId, invoice_number: c.invoice_number,
      metadata: { earned_points_revoked_tx: c.earned_points_revoked_tx, invoice_number: c.invoice_number },
    });
  }

  // Customer-facing PORTAL notifications (loyalty_notifications channel,
  // member-scoped) — distinct from the staff bell above. Once per order.
  try {
    let memberId: string | null = null;
    if (custId) {
      const { data: m } = await supabase.from("loyalty_members").select("id").eq("customer_id", custId).maybeSingle();
      memberId = (m?.id as string) ?? null;
    }
    if (memberId) {
      // The master row carries no member; the body names the order, which is enough.
      const { data: prior } = await supabase.from("loyalty_notifications").select("id")
        .eq("category", "order").ilike("body", `${ref} was cancelled.%`).limit(1);
      const already = (prior ?? []).length > 0;
      if (c.earned_points_revoked_tx != null && !already) {
        await emitNotification(supabase, memberId, {
          category: "points", title: "Points revoked",
          body: `The loyalty points earned on ${ref} have been revoked because the order was cancelled.`,
          link_target: "tab:points",
        });
      }
      if (c.store_credit && !already) {
        const amt = Number(c.store_credit.amount ?? c.money_received ?? 0).toLocaleString("en-US");
        const expiry = c.store_credit?.expires_at
          ? new Date(c.store_credit.expires_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
          : null;
        await emitNotification(supabase, memberId, {
          category: "order", title: "Store credit issued",
          body: `${ref} was cancelled. ${symbol}${amt} store credit has been added to your account${Number(c.cancellation_split?.kept ?? 0) > 0 ? ` (the amount paid, less the 30% cancellation charge of ${symbol}${Number(c.cancellation_split?.kept ?? 0).toLocaleString("en-US")})` : ""}${expiry ? ` and is valid until ${expiry}` : ""}. Our staff will apply it to your next order.`,
          link_target: "tab:home",
        });
      }
    }
  } catch (portalErr) {
    console.warn("[cancel-followups] customer portal notification failed (non-blocking):", portalErr);
  }

  // (c) Web order: the cancellation email (reason + refund decision). The
  //     sender keys it `order-cancelled-<id>` and logs its own outcome.
  if (isWeb) {
    const storeCredit = c.store_credit
      ? { amount: Number(c.store_credit.amount ?? 0), charge: Number(c.cancellation_split?.kept ?? 0) }
      : null;
    await sendWebCancellationEmail(supabase, a.cash_order_id, {
      reason: a.reason, refundStatus: (c.refund_status ?? a.refundStatus) as RefundStatus, refundNote: a.refundNote, storeCredit,
    });
  }
}

/** Mirror a Hub store-credit movement into Shopify (single source of truth = Hub). Never throws. */
export async function syncStoreCreditToShopify(body: Record<string, unknown>): Promise<unknown> {
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-store-credit-to-shopify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => null);
    console.log("[sync-to-shopify]", JSON.stringify(out));
    return out;
  } catch (e) {
    console.warn("[sync-to-shopify] failed (non-blocking):", e);
    return { success: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * What the terminate RPC would have answered, rebuilt from the database when
 * the sweep finishes a cancel whose terminate already committed (the first
 * attempt crashed after it). Read-only.
 */
export async function cancellationSnapshot(supabase: Db, cashOrderId: string): Promise<CancellationResult | null> {
  const { data: o, error } = await supabase.from("cash_orders")
    .select("id, invoice_number, web_reference, currency, status, refund_status, customer_id, total_paid")
    .eq("id", cashOrderId).maybeSingle();
  if (error || !o || String(o.status) !== "cancelled") return null;
  const { data: lot } = await supabase.from("store_credit_lots")
    .select("id, customer_id, original_amount, currency, expires_at")
    .eq("source_cash_order_id", cashOrderId).eq("source_type", "cancelled_cash").neq("status", "voided")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: money } = await supabase.from("cash_payments").select("amount_paid, reference_number")
    .eq("cash_order_id", cashOrderId).is("voided_at", null);
  const received = ((money ?? []) as AnyRec[])
    .filter((p) => !String(p.reference_number ?? "").startsWith("LOYALTY-"))
    .reduce((s, p) => s + Number(p.amount_paid ?? 0), 0);
  return {
    success: true, invoice_number: o.invoice_number, web_reference: o.web_reference, currency: o.currency,
    money_received: received, refund_status: o.refund_status,
    store_credit: lot ? { lot_id: lot.id, customer_id: lot.customer_id, amount: lot.original_amount, currency: lot.currency, expires_at: lot.expires_at } : null,
    cancellation_split: lot ? { kept: Math.max(0, received - Number(lot.original_amount ?? 0)) } : null,
    earned_points_revoked_tx: null,
    snapshot: true,
  };
}
