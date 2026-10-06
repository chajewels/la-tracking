// confirm-web-draft — the review screen's server (website orders PR 4 of 10).
//
// A website checkout in 'draft' mode writes a DRAFT (web_order_drafts, PR 3):
// the piece is held, nothing is booked. Staff open it on the review screen
// (/orders/review/website/:id), add shipping, service lines and a discount,
// and Confirm. This function:
//
//   action 'preview' — computes the final figures from the draft and the
//     staff's inputs and writes NOTHING. The screen shows exactly these.
//   action 'confirm' — recomputes the same figures (the browser's numbers are
//     never trusted), applies the loyalty gate, and calls
//     materialize_web_draft_atomic, which does every write in ONE transaction
//     (order, schedule, lines, hold transferred — no second stock movement).
//     Then the existing "ready — pay now" email goes out.
//   action 'decline' — "Can't supply": decline_web_draft_atomic, reason
//     required, stock back on sale, then the customer is told why (PR 6:
//     order-cancelled in her language, or layaway-declined in English).
//
// MONEY. Every figure a person types is in the ORDER's currency (the currency
// the customer chose at checkout) and must be a whole number, like every
// order in the Hub. Products are the draft's own converted subtotal (converted
// ONCE at checkout, integer half-up — docs/CASH-ORDERS.md). A layaway's deposit
// and schedule come from layaway_quote, the same SQL the storefront quoted
// from, never a TypeScript copy: p_price = products − discount, plus shipping
// and services — deposit 30% of the TOTAL (WEB LAYAWAY rule). Lines are yen
// (order-extras): a peso service line is stored as round(₱ ÷ rate) yen
// (JPY = PHP ÷ rate), informational only.
//
// Permission: confirm_web_order_ready here, and inside the RPC together with
// create_cash_order / create_account for the draft's mode. No service-role
// path: a confirmation is always a person.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendDraftClosedEmail, sendLayawayReadyEmail, sendOrderPaidByPointsEmail, sendOrderReadyEmail } from "../_shared/reservation-emails.ts";
import { computeWebDraftFigures } from "../_shared/web-draft-figures.ts";

type AnyRec = Record<string, unknown>;

const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  not_open: 409,
  hold_lost: 409,
  permission_denied: 403,
  // Checkout points (2026-10-05).
  points_hold_lost: 409,
  points_exceed_deposit: 409,
  points_exceed_total: 409,
  points_insufficient: 409,
};

/**
 * approve_redemption_atomic RAISES (the Confirm rolls back whole). Its
 * messages, as the review screen should read them.
 */
function pointsRaise(message: string): string | null {
  if (/insufficient_points|insufficient_lots/i.test(message)) return "points_insufficient";
  if (/redemption_not_pending/i.test(message)) return "points_hold_lost";
  if (/web_draft_redemption/i.test(message)) return "points_hold_lost";
  return null;
}

// deno-lint-ignore no-explicit-any
async function awardIfPaidByPoints(supabase: any, result: AnyRec): Promise<AnyRec | null> {
  try {
    let body: AnyRec | null = null;
    if (result.entity_type === "layaway_account") {
      const { data: started } = await supabase.rpc("layaway_deposit_started", { p_account_id: result.entity_id });
      if (started === true) body = { account_id: result.entity_id };
    } else {
      const { data: order } = await supabase.from("cash_orders")
        .select("id, customer_id, status").eq("id", String(result.entity_id)).maybeSingle();
      if ((order as AnyRec | null)?.status === "completed") {
        body = { cash_order_id: (order as AnyRec).id, customer_id: (order as AnyRec).customer_id };
      }
    }
    if (!body) return null;
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    const out = { ...(json ?? {}), http_status: res.status, paid_by_points: true } as AnyRec;
    if (!res.ok || out.error) {
      // Visible to staff: an award owed and not made.
      await supabase.from("staff_notifications").insert({
        type: "loyalty_award_failed",
        title: "Loyalty award failed after website Confirm",
        body: `Points paid ${result.entity_type === "layaway_account" ? "the whole deposit" : "the whole order"} on ${String(result.web_reference ?? result.invoice_number ?? "")}; the award did not go through (${String(out.error ?? res.status)}). Check the order.`,
        invoice_number: result.invoice_number ?? null,
      });
    }
    return out;
  } catch (e) {
    console.warn("[confirm-web-draft] award after points-paid Confirm failed (non-blocking):", e);
    return { error: String(e), paid_by_points: true };
  }
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "confirm_web_order_ready");
  if (denied) return denied;
  const { supabase, user } = ctx;
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const body = (await req.json().catch(() => ({}))) as AnyRec;
    const action = String(body.action ?? "preview");
    const draftId = String(body.draft_id ?? "").trim();
    if (!draftId) return jsonResponse({ error: "draft_id_required" }, 400);

    if (action === "decline") {
      const reason = String(body.reason ?? "").trim();
      if (!reason) return jsonResponse({ error: "reason_required" }, 400);
      const { data, error } = await supabase.rpc("decline_web_draft_atomic", {
        p_draft_id: draftId, p_reason: reason, p_user_id: user.id, p_source: "staff",
      });
      if (error) throw error;
      const r = (data ?? {}) as AnyRec;
      if (r.error) return jsonResponse(r, ERROR_STATUS[String(r.error)] ?? 400);
      // Never throws: the decline stands whether or not the mail goes out.
      const email = await sendDraftClosedEmail(supabase, draftId, "declined", reason);
      return jsonResponse({ ...r, email });
    }

    if (action !== "preview" && action !== "confirm") {
      return jsonResponse({ error: "bad_action" }, 400);
    }

    const { data: draft, error: dErr } = await supabase
      .from("web_order_drafts").select("*").eq("id", draftId).maybeSingle();
    if (dErr) throw dErr;
    if (!draft) return jsonResponse({ error: "not_found" }, 404);

    const figures = await computeWebDraftFigures(supabase, draft as AnyRec, body);

    if (action === "preview") {
      return jsonResponse({ preview: true, status: (draft as AnyRec).status, ...figures });
    }

    if ((draft as AnyRec).status !== "to_confirm") {
      return jsonResponse({ error: "not_open", status: (draft as AnyRec).status }, 409);
    }
    if (figures.errors.length > 0) {
      return jsonResponse({ error: figures.errors[0], errors: figures.errors, figures }, 400);
    }

    const rate = figures.fx_rate;
    const toJpy = (amount: number) => (figures.currency === "PHP" && rate ? Math.round(amount / rate) : amount);
    const order: AnyRec = {
      total_amount: figures.total,
      shipping_fee: figures.shipping,
      discount_amount: figures.discount,
      discount_type: figures.discount > 0 ? "amount" : null,
      discount_value: figures.discount > 0 ? figures.discount : null,
      order_date: figures.order_date,
      transfer_due_at: figures.transfer_due_at,
      notes: String(body.notes ?? "").trim() || null,
      is_trade: body.is_trade === true,
      loyalty_jpy_amount: figures.loyalty_jpy_amount,
      planned_shipping_method_id: body.planned_shipping_method_id ? String(body.planned_shipping_method_id) : null,
    };
    let schedule: AnyRec[] | null = null;
    if ((draft as AnyRec).mode === "layaway" && figures.layaway) {
      order.downpayment_amount = figures.layaway.deposit;
      order.payment_plan_months = figures.layaway.term_months;
      schedule = figures.layaway.schedule as AnyRec[];
    }
    const serviceLines = figures.service_lines.map((l) => ({
      title: l.title, quantity: 1, unit_price_jpy: toJpy(l.amount), line_total_jpy: toJpy(l.amount),
    }));

    const { data, error } = await supabase.rpc("materialize_web_draft_atomic", {
      p_draft_id: draftId,
      p_user_id: user.id,
      p_order: order,
      p_schedule: schedule,
      p_service_lines: serviceLines,
    });
    if (error) {
      const mapped = pointsRaise(String(error.message ?? ""));
      if (mapped) return jsonResponse({ error: mapped, detail: error.message }, 409);
      throw error;
    }
    const result = (data ?? {}) as AnyRec;
    if (result.error) return jsonResponse(result, ERROR_STATUS[String(result.error)] ?? 400);

    // LOYALTY AWARD AT CONFIRM — the one exception to "review-payment-
    // submission is the sole award path" (CLAUDE.md LOYALTY rule 2, owner
    // 2026-10-05 "Whole deposit allowed"): when the checkout's points paid the
    // WHOLE deposit (layaway) or the whole order (cash), no payment will ever
    // be submitted, so the award the deposit / completion would trigger is
    // made here, through the same award-loyalty-points function (idempotent
    // via loyalty_award_claims). Never blocks the Confirm.
    let loyaltyAward: AnyRec | null = null;
    if (result.points_approval) {
      loyaltyAward = await awardIfPaidByPoints(supabase, result);
    }

    // The ready email reads the order back from the row just written.
    // H5 (spec §5 A): a cash order the checkout points paid in FULL is already
    // completed — re-read it, and send "payment received (fully paid by
    // points)" INSTEAD of the ready email ("pay ¥0 by transfer"). A layaway
    // whose deposit points covered keeps the layaway ready email (English
    // only, unchanged). A failed re-read falls back to the ready email.
    let paidByPoints = false;
    if (result.entity_type === "cash_order") {
      const { data: after } = await supabase
        .from("cash_orders").select("status").eq("id", String(result.entity_id)).maybeSingle();
      paidByPoints = (after as AnyRec | null)?.status === "completed";
    }
    const email = result.entity_type === "cash_order"
      ? (paidByPoints
        ? await sendOrderPaidByPointsEmail(supabase, String(result.entity_id))
        : await sendOrderReadyEmail(supabase, String(result.entity_id)))
      : await sendLayawayReadyEmail(supabase, String(result.entity_id), (schedule ?? null) as never);

    // W2-6: the service requests this draft carried (re-pointed to the new
    // order by the RPC). The review screen opens Services on the first one so
    // staff turn it into a job, with the service line's fee prefilled.
    const { data: reqs } = await supabase
      .from("service_requests")
      .select("id, kind")
      .eq("web_draft_id", draftId)
      .in("status", ["requested", "received", "in_progress"])
      .order("created_at");
    const serviceRequests = ((reqs ?? []) as AnyRec[]).map((r) => ({ id: r.id, kind: r.kind }));

    console.log(JSON.stringify({
      confirm_web_draft: result.entity_type,
      draft: draftId,
      id: result.entity_id,
      reference: result.web_reference ?? null,
      by: user.id,
      email: email.sent ? "sent" : (email as { reason?: string }).reason ?? "not_sent",
      paid_by_points: paidByPoints,
    }));

    return jsonResponse({ ...result, figures, email, service_requests: serviceRequests, loyalty_award: loyaltyAward });
  } catch (err) {
    console.error("[confirm-web-draft] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
