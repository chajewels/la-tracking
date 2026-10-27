/**
 * page365-invoice-check — Page365 void sync (owner decisions 2026-10-21;
 * docs/PAGE365-IMPORT.md "Void sync"; migration 20261228100000).
 *
 * Re-reads a Page365 invoice link and hands its `stage` to the ONE writer,
 * page365_apply_invoice_stage:
 *   stage 'voided' on a LIVE order  → cancel (existing cancel writers)
 *   stage leaves 'voided'           → restore an order THIS sync cancelled
 *
 * ACTIONS (POST body.action):
 *   "sweep"    — service role only (pg_cron page365-invoice-check, :17/:47).
 *                Reads every link page365_invoice_due_links returns.
 *   "check"    — staff "Re-read Page365" button: { kind, order_id }.
 *   "add_link" — staff "Add Page365 link" for an order imported before the
 *                link was kept: { kind, order_id, url }. Saves the link and
 *                reports the stage; it does not cancel or restore by itself.
 *
 * PERMISSION: "check" (Re-read) and "add_link" (Add / Replace Page365 link) →
 * ANY staff user, is_staff (admin / staff / finance / csr; owner 2026-10-27:
 * "all staff should be able to use, they are exactly the user"). A portal
 * customer is also an authenticated user and gets 403.
 *
 * THE SIG IS A CAPABILITY: read from page365_invoice_links (server-only) and
 * used for the outbound GET only. It is never logged and never returned.
 *
 * A cash order with money received is never cancelled here (button or
 * sweep): page365_apply_invoice_stage answers needs_staff and rings the bell,
 * and staff use Cancel Order, which owns the Paidy / card / store-credit steps.
 *
 * AFTER a cancel commits (non-blocking, as cancel-layaway / cancel-cash-order
 * do): layaway → portal "Points revoked" notice + the layaway-cancelled email;
 * cash → emitCancellationFollowups. The writer itself rings the staff bell.
 */
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, type AuthContext } from "../_shared/handler.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";
import { emitNotification } from "../_shared/emit-notification.ts";
import { sendLayawayCancelledEmail } from "../_shared/layaway-cancel-email.ts";
import { emitCancellationFollowups } from "../_shared/cancel-followups.ts";

const PAGE365_ORIGIN = "https://chajewelsjapan.com";
const ALLOWED_HOSTS = ["chajewelsjapan.com", "www.chajewelsjapan.com"];
const SLUG_RE = /^[A-Za-z0-9._~-]+$/;
const SIG_RE = /^[A-Za-z0-9]+$/;
const READ_TIMEOUT_MS = 8000;
const SWEEP_SPACING_MS = 250;
const SWEEP_BUDGET_MS = 120_000;

type Kind = "layaway" | "cash";
// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;

type StageRead = { ok: true; stage: string; no: number | null } | { ok: false; error: string };

async function readStage(slug: string, sig: string): Promise<StageRead> {
  const url = `${PAGE365_ORIGIN}/invoices/${encodeURIComponent(slug)}?sig=${encodeURIComponent(sig)}`;
  let res: Response;
  try {
    res = await fetchWithRetryOnRateLimit(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `unreachable: ${(e as Error)?.name ?? "error"}` };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: `http_${res.status}` };
  }
  let raw: AnyRec;
  try {
    raw = await res.json();
  } catch {
    return { ok: false, error: "not_json" };
  }
  const stage = typeof raw?.stage === "string" ? raw.stage.trim() : "";
  if (!stage) return { ok: false, error: "no_stage" };
  const no = Number.isFinite(Number(raw?.no)) ? Number(raw.no) : null;
  return { ok: true, stage, no };
}

async function recordError(supabase: Db, page365No: number, error: string): Promise<void> {
  const { error: e } = await supabase.rpc("page365_record_check_error", { p_page365_no: page365No, p_error: error });
  if (e) console.warn(`[page365-invoice-check] record_check_error failed for ${page365No}:`, e.message);
}

async function applyStage(supabase: Db, page365No: number, stage: string, user: { id: string; email?: string } | null): Promise<AnyRec> {
  const { data, error } = await supabase.rpc("page365_apply_invoice_stage", {
    p_page365_no: page365No,
    p_stage: stage,
    p_user_id: user?.id ?? null,
    p_user_email: user?.email ?? null,
  });
  if (error) {
    const msg = String(error.message ?? "apply failed");
    await recordError(supabase, page365No, `apply: ${msg.slice(0, 200)}`);
    return { action: "error", error: msg };
  }
  return (data ?? {}) as AnyRec;
}

async function afterCancel(supabase: Db, page365No: number, result: AnyRec): Promise<void> {
  if (result?.action !== "cancelled") return;
  const orderId = String(result.order_id ?? "");
  const c = (result.cancel_result ?? {}) as AnyRec;
  if (!orderId) return;
  try {
    if (result.kind === "layaway") {
      const pointsReversed = c.earned_points_revoked_tx != null;
      if (pointsReversed) {
        const { data: acct } = await supabase.from("layaway_accounts").select("customer_id, web_reference, invoice_number").eq("id", orderId).single();
        const { data: m } = acct?.customer_id
          ? await supabase.from("loyalty_members").select("id").eq("customer_id", acct.customer_id).maybeSingle()
          : { data: null };
        if (m?.id) {
          await emitNotification(supabase, m.id as string, {
            category: "points",
            title: "Points revoked",
            body: `The loyalty points earned on ${acct?.web_reference ?? acct?.invoice_number} have been revoked because the plan was cancelled.`,
            link_target: "tab:points",
          });
        }
      }
      await sendLayawayCancelledEmail(supabase, orderId, {
        pointsReversed,
        idempotencyKey: `page365-void-${page365No}-${c.cancelled_at ?? orderId}`,
      });
    } else {
      const { data: orderRow } = await supabase.from("cash_orders").select("*").eq("id", orderId).single();
      if (orderRow) {
        await emitCancellationFollowups(supabase, {
          cash_order_id: orderId, isWeb: false, c, orderRow,
          reason: "Voided in Page365", refundStatus: null, refundNote: null,
        });
      }
    }
  } catch (e) {
    console.warn(`[page365-invoice-check] follow-ups after cancel of ${page365No} failed (non-blocking):`, e);
  }
}

async function checkOne(supabase: Db, page365No: number, slug: string, sig: string, user: { id: string; email?: string } | null): Promise<AnyRec> {
  const read = await readStage(slug, sig);
  if (!read.ok) {
    await recordError(supabase, page365No, read.error);
    return { action: "read_failed", error: read.error, page365_no: page365No };
  }
  if (read.no != null && read.no !== page365No) {
    await recordError(supabase, page365No, `invoice_mismatch: link opened invoice ${read.no}`);
    return { action: "read_failed", error: "invoice_mismatch", page365_no: page365No };
  }
  const result = await applyStage(supabase, page365No, read.stage, user);
  await afterCancel(supabase, page365No, result);
  return { ...result, page365_no: page365No, stage: read.stage };
}

async function loadOrder(supabase: Db, kind: Kind, orderId: string): Promise<AnyRec | null> {
  const table = kind === "layaway" ? "layaway_accounts" : "cash_orders";
  const { data } = await supabase.from(table).select("id, page365_no, page365_slug, source_channel").eq("id", orderId).maybeSingle();
  return data ?? null;
}

async function staffGate(ctx: AuthContext): Promise<Response | null> {
  if (ctx.isService || !ctx.user) return jsonResponse({ error: "Unauthorized" }, 401);
  // Re-read and Add link are open to every internal user — never a portal
  // customer, who is also an authenticated user. is_staff = a user_roles row
  // (admin/staff/finance/csr).
  const { data: isStaff, error } = await ctx.supabase.rpc("is_staff", { _user_id: ctx.user.id });
  if (error) return jsonResponse({ error: "Could not check your access." }, 500);
  return isStaff === true ? null : jsonResponse({ error: "Access denied" }, 403);
}

function parseLink(raw: string): { slug: string; sig: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return { error: "That is not a URL. Paste the full Page365 invoice link." };
  }
  if (u.protocol !== "https:") return { error: "The Page365 link must be https." };
  if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) {
    return { error: `Unexpected host "${u.hostname}". A Page365 invoice link points at chajewelsjapan.com.` };
  }
  const m = u.pathname.match(/^\/invoices\/([A-Za-z0-9._~-]+)\/?$/);
  if (!m) return { error: "That link is not a Page365 invoice link (expected /invoices/<slug>)." };
  const sig = u.searchParams.get("sig") ?? "";
  if (!sig) return { error: "The link is missing its ?sig= token — copy the full invoice link." };
  if (!SLUG_RE.test(m[1]) || !SIG_RE.test(sig)) return { error: "That Page365 link has an unexpected format." };
  return { slug: m[1], sig };
}

async function sweep(supabase: Db): Promise<AnyRec> {
  const started = Date.now();
  const { data: links, error } = await supabase.rpc("page365_invoice_due_links");
  if (error) return { ok: false, error: error.message };
  const counts: Record<string, number> = {};
  let read = 0;
  let stoppedEarly = false;
  for (const l of (links ?? []) as AnyRec[]) {
    if (Date.now() - started > SWEEP_BUDGET_MS) { stoppedEarly = true; break; }
    const r = await checkOne(supabase, Number(l.page365_no), String(l.page365_slug), String(l.page365_sig), null);
    read++;
    const key = String(r.action ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
    await new Promise((res) => setTimeout(res, SWEEP_SPACING_MS));
  }
  console.log(`[page365-invoice-check] sweep read ${read}/${(links ?? []).length}`, JSON.stringify(counts));
  return { ok: true, due: (links ?? []).length, read, stopped_early: stoppedEarly, counts };
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const { supabase } = ctx;

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    if (action === "sweep") {
      if (!ctx.isService) return jsonResponse({ error: "sweep is for the scheduler only" }, 403);
      return jsonResponse(await sweep(supabase));
    }

    const kind = body?.kind === "cash" ? "cash" : body?.kind === "layaway" ? "layaway" : null;
    const orderId = typeof body?.order_id === "string" ? body.order_id : "";
    if (!kind || !orderId) return jsonResponse({ error: "kind ('layaway' | 'cash') and order_id are required" }, 400);
    const denied = await staffGate(ctx);
    if (denied) return denied;

    const order = await loadOrder(supabase, kind, orderId);
    if (!order) return jsonResponse({ error: "Order not found." }, 404);
    if (order.page365_no == null) return jsonResponse({ error: "This order was not imported from Page365." }, 409);
    if (order.source_channel === "web") return jsonResponse({ error: "Website orders are not synced with Page365." }, 409);
    const page365No = Number(order.page365_no);

    if (action === "check") {
      const { data: link } = await supabase
        .from("page365_invoice_links").select("page365_slug, page365_sig").eq("page365_no", page365No).maybeSingle();
      if (!link) {
        return jsonResponse({ ok: false, code: "no_link", error: "No Page365 link is saved for this order. Use Add Page365 link first." }, 409);
      }
      const r = await checkOne(supabase, page365No, String(link.page365_slug), String(link.page365_sig), ctx.user);
      return jsonResponse({ ok: r.action !== "read_failed" && r.action !== "error", ...r });
    }

    if (action === "add_link") {
      const parsed = parseLink(body?.url);
      if ("error" in parsed) return jsonResponse({ ok: false, error: parsed.error }, 400);
      if (order.page365_slug && order.page365_slug !== parsed.slug) {
        return jsonResponse({ ok: false, error: "That link is for a different Page365 invoice than this order." }, 409);
      }
      const read = await readStage(parsed.slug, parsed.sig);
      if (!read.ok) {
        return jsonResponse({ ok: false, error: `Page365 did not open that link (${read.error}). Re-copy the full invoice link.` }, 502);
      }
      if (read.no == null || read.no !== page365No) {
        return jsonResponse({ ok: false, error: `That link opens invoice ${read.no ?? "?"}, not ${page365No}.` }, 409);
      }
      const { error: upErr } = await supabase.rpc("page365_invoice_link_upsert", {
        p_page365_no: page365No, p_slug: parsed.slug, p_sig: parsed.sig,
      });
      if (upErr) return jsonResponse({ ok: false, error: "Could not save the link: " + upErr.message }, 500);
      await supabase.from("audit_logs").insert({
        entity_type: kind === "layaway" ? "layaway_account" : "cash_order",
        entity_id: orderId,
        action: "page365_link_added",
        performed_by_user_id: ctx.user!.id,
        new_value_json: { page365_no: page365No, page365_slug: parsed.slug, stage_seen: read.stage },
      });
      return jsonResponse({ ok: true, page365_no: page365No, stage: read.stage });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("[page365-invoice-check] error:", (err as Error)?.message ?? err);
    return jsonResponse({ ok: false, error: (err as Error)?.message ?? "error" }, 500);
  }
});
