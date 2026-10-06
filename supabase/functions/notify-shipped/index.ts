// notify-shipped — email a WEBSITE customer when staff mark her order shipped
// (payment lifecycle H7, spec §5 B).
//
// The Hub UI calls this fire-and-forget AFTER a successful "Mark as shipped"
// save. The row is re-read here and must carry shipped_at AND tracking_number
// (409 not_shipped otherwise), so the function never trusts the caller about
// state. The email itself (web-only, courier and tracking URL read from
// shipping_method_id) is sendOrderUpdateEmail's job and never throws.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendOrderUpdateEmail } from "../_shared/order-update-email.ts";
import { shippedKey } from "../_shared/shipped-key.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "edit_account");
  if (denied) return denied;
  const { supabase } = ctx;

  try {
    const body = await req.json().catch(() => ({}));
    const kind = String(body?.kind ?? "");
    const recordId = String(body?.record_id ?? "");
    if (kind !== "layaway" && kind !== "cash_order") {
      return jsonResponse({ error: "kind must be 'layaway' or 'cash_order'" }, 400);
    }
    if (!UUID_RE.test(recordId)) {
      return jsonResponse({ error: "record_id must be a uuid" }, 400);
    }

    const table = kind === "layaway" ? "layaway_accounts" : "cash_orders";
    const { data: row, error } = await supabase
      .from(table)
      .select("id, shipped_at, tracking_number")
      .eq("id", recordId)
      .maybeSingle();
    if (error) throw error;
    if (!row) return jsonResponse({ error: "not_found" }, 404);

    const shippedAt = (row as { shipped_at: string | null }).shipped_at;
    const tracking = (row as { tracking_number: string | null }).tracking_number;
    if (!shippedAt || !tracking) {
      return jsonResponse({ error: "not_shipped" }, 409);
    }

    await sendOrderUpdateEmail(supabase, {
      entity: kind,
      id: recordId,
      variant: "shipped",
      idempotencyKey: shippedKey(kind, recordId, String(shippedAt)),
    });
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("[notify-shipped] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
