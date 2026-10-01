// web-reservation-sweep — the hourly job for unconfirmed website orders.
//
// WEBSITE ORDERS PR 10 (2026-10-01): every website checkout is a DRAFT
// (web_order_drafts, docs/WEB-ORDER-DRAFTS.md). The reserve-first path this
// job was written for (A2, 2026-09-24: web cash orders / plans with
// ready_confirmed_at NULL, expire_unconfirmed_web_reservations_atomic) is
// retired; the job now sweeps drafts only. pg_cron 'web-reservation-sweep' at
// :23 every hour (Vault service key). Two halves, in this order:
//
//   1. 72 HOURS UNCONFIRMED → CLOSED. expire_web_drafts_atomic closes a draft
//      nobody confirmed (stock back on sale); the customer gets the lapsed email
//      built from the draft and staff get one bell row per draft. Run FIRST so
//      the reminder below never chases a draft this run is about to close.
//   2. 24 HOURS UNCONFIRMED → ONE EMAIL TO sales@chajewelsjp.com listing every
//      draft not chased before, with Hub review links. The dedupe is
//      web_order_drafts.reservation_reminded_at, stamped only after the email
//      is accepted — a refused send is retried next hour, and no draft is ever
//      listed twice.
//
// Callers: the cron (service role) and staff with system_health (manual run).
// INVARIANT 12 is the RPC's: a draft with a submission awaiting review is
// skipped and reported, never closed.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendDraftClosedEmail } from "../_shared/reservation-emails.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import {
  RESERVATION_AUTO_CANCEL_HOURS, RESERVATION_REMIND_HOURS, reservationAgeHours, reservationAutoCancelAt,
} from "../_shared/web-reservation-rules.ts";
import type { AwaitingReservation } from "../_shared/transactional-email-templates/web-reservations-awaiting.tsx";

type AnyRec = Record<string, unknown>;

const HUB_BASE = "https://app.chajewelsjp.com"; // internal links only — never a customer
const SALES_INBOX = "sales@chajewelsjp.com";
const REMIND_LIMIT = 200;

function money(amount: unknown, currency: unknown): string {
  const v = Math.round(Number(amount ?? 0));
  return `${String(currency ?? "JPY") === "PHP" ? "₱" : "¥"}${v.toLocaleString("en-US")}`;
}

function pht(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso)) + " PHT";
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "system_health");
  if (denied) return denied;
  const { supabase } = ctx;
  const now = new Date();

  try {
    const lapsedEmails: Record<string, unknown>[] = [];

    // ------------------------------------------------ 1. the 72-hour sweep (drafts)
    const { data: draftSwept, error: draftSweepErr } = await supabase.rpc("expire_web_drafts_atomic", {
      p_hours: RESERVATION_AUTO_CANCEL_HOURS,
      p_limit: 100,
    });
    if (draftSweepErr) throw draftSweepErr;
    const expiredDrafts = (((draftSwept ?? {}) as AnyRec).expired_drafts ?? []) as AnyRec[];
    const skippedDrafts = (((draftSwept ?? {}) as AnyRec).skipped ?? []) as AnyRec[];
    for (const d of expiredDrafts) {
      const e = await sendDraftClosedEmail(supabase, String(d.id), "lapsed");
      lapsedEmails.push({ entity_type: "web_draft", id: d.id, sent: e.sent });
      try {
        const ref = String(d.web_reference ?? d.invoice_number ?? "?");
        await supabase.from("staff_notifications").insert({
          type: "web_draft_auto_cancelled",
          title: "Website order auto-cancelled — never confirmed",
          body: `${ref} was not confirmed within ${RESERVATION_AUTO_CANCEL_HOURS} hours. It is cancelled, the piece is back on sale and the customer has been told.`,
          customer_id: d.customer_id ?? null,
          invoice_number: d.invoice_number ?? null,
          metadata: { web_draft_id: d.id, web_reference: d.web_reference, mode: d.mode, source_channel: "web" },
        });
      } catch (notifyErr) {
        console.warn("[web-reservation-sweep] draft bell insert failed (non-blocking):", notifyErr);
      }
    }

    // ------------------------------------------------ 2. the 24-hour reminder
    const cutoff = new Date(now.getTime() - RESERVATION_REMIND_HOURS * 3_600_000).toISOString();
    // Drafts still to confirm after 24 hours.
    const { data: draftDue, error: dErr } = await supabase.from("web_order_drafts")
      .select("id, web_reference, mode, term_months, total, settlement_currency, created_at, customers(full_name, is_test)")
      .eq("status", "to_confirm").is("reservation_reminded_at", null)
      .lt("created_at", cutoff)
      .order("created_at").limit(REMIND_LIMIT);
    if (dErr) throw dErr;

    const draftRows = (draftDue ?? []) as AnyRec[];
    const draftList: AwaitingReservation[] = draftRows.map((r) => {
      const c = (r.customers ?? {}) as AnyRec;
      const name = String(c.full_name ?? "").trim() || "A website customer";
      const kind = r.mode === "layaway" ? "layaway" : "cash_order";
      return {
        kind,
        reference: String(r.web_reference ?? "?"),
        customerName: c.is_test === true ? `${name} (TEST)` : name,
        amount: kind === "layaway"
          ? `${money(r.total, r.settlement_currency)} over ${r.term_months ?? "?"} months`
          : money(r.total, r.settlement_currency),
        ageHours: reservationAgeHours(String(r.created_at), now),
        autoCancelAt: pht(reservationAutoCancelAt(String(r.created_at))),
        hubUrl: `${HUB_BASE}/orders/review/website/${r.id}`,
      };
    });
    const reservations = [...draftList].sort((a, b) => b.ageHours - a.ageHours);

    let reminder: Record<string, unknown> = { listed: 0 };
    if (reservations.length > 0) {
      const ids = draftRows.map((r) => String(r.id)).sort();
      let stamp = false;
      try {
        const res = await sendTemplateEmail("web-reservations-awaiting", SALES_INBOX, {
          templateData: { reservations },
          // The same set of reservations is one logical send: a retry of this
          // exact list dedupes at the provider.
          idempotencyKey: `web-reservations-awaiting-${(await sha256Hex(ids.join(","))).slice(0, 32)}`,
        });
        // Suppressed means sales@ is on the suppression list: retrying every
        // hour would change nothing, so the reservations are marked chased and
        // the bell (below) carries the reminder instead.
        stamp = true;
        reminder = { listed: reservations.length, sent: res.sent };
        if (!res.sent) {
          await supabase.from("staff_notifications").insert({
            type: "email_send_refused",
            title: "Reservation reminder not delivered — sales@ is suppressed",
            body: `${reservations.length} web reservation(s) are still unconfirmed after ${RESERVATION_REMIND_HOURS} hours. Open the Dashboard to confirm or decline them.`,
            metadata: { references: reservations.map((r) => r.reference) },
          });
        }
      } catch (mailErr) {
        // Refused or failed: logged by sendTemplateEmail; not stamped, so the
        // next run lists them again.
        console.error("[web-reservation-sweep] reminder email failed — will retry next run:", (mailErr as Error)?.message ?? mailErr);
        reminder = { listed: reservations.length, sent: false, retry: true };
      }
      if (stamp) {
        const stampedAt = new Date().toISOString();
        if (draftRows.length) {
          const { error } = await supabase.from("web_order_drafts")
            .update({ reservation_reminded_at: stampedAt })
            .in("id", draftRows.map((r) => r.id)).is("reservation_reminded_at", null);
          if (error) console.error("[web-reservation-sweep] stamping draft reminders failed:", error.message ?? error);
        }
      }
    }

    const summary = {
      ok: true,
      ran_at: now.toISOString(),
      auto_cancelled: { drafts: expiredDrafts.length },
      skipped_drafts: skippedDrafts,
      lapsed_emails: lapsedEmails,
      reminder,
    };
    console.log(JSON.stringify({ web_reservation_sweep: summary }));
    return jsonResponse(summary);
  } catch (err) {
    console.error("[web-reservation-sweep] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
