// supabase/functions/rebuild-cash-receipts/index.ts
// One-off, resumable repair sweep (Bug #251 follow-up). The confirmed-payment
// self-heal only fires on NEW confirmations; sheets damaged by the retired
// reposition-cash-receipts had their payments confirmed in the past and will
// never self-heal. This rewrites every invoice sheet's Cash Receipt tab from DB
// truth. Idempotent — re-running is harmless.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  appendManyReceipts,
  deriveSlotMap,
  type CashReceiptSlot,
} from "../_shared/cash-receipt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hasPermission(supabase: any, userId: string, permissionKey: string) {
  const { data: roles, error: roleError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleError) throw roleError;

  const roleNames = (roles ?? []).map((row: any) => row.role);
  if (roleNames.length === 0) return false;

  const { data: permissions, error: permissionError } = await supabase
    .from("role_permissions")
    .select("role, is_allowed")
    .eq("permission_key", permissionKey)
    .in("role", roleNames);
  if (permissionError) throw permissionError;

  return (permissions ?? []).some((row: any) => row.is_allowed);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Auth: require a valid user JWT + system_health permission. No service-role
    // or anon-key bypass (CLAUDE.md Bug #170).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }
    const allowed = await hasPermission(supabase, user.id, "system_health");
    if (!allowed) {
      return json({ error: "Permission denied" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const dry_run = body.dry_run !== false; // defaults to TRUE
    let batchSize = Number.isInteger(body.batch_size) ? body.batch_size : 20;
    if (batchSize < 1) batchSize = 1;
    if (batchSize > 25) batchSize = 25;
    const cursor: string | null = typeof body.cursor === "string" ? body.cursor : null;

    // Build the deterministic work set: ALL layaway rows first, then ALL cash
    // orders (cash orders are first-class — never skipped), each ordered by
    // invoice_number so the cursor is stable across calls.
    const { data: layawayRows, error: layErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, currency, cash_receipt_sheet_id")
      .not("cash_receipt_sheet_id", "is", null)
      .order("invoice_number", { ascending: true });
    if (layErr) throw layErr;

    const { data: cashRows, error: cashErr } = await supabase
      .from("cash_orders")
      .select("id, invoice_number, currency, cash_receipt_sheet_id")
      .not("cash_receipt_sheet_id", "is", null)
      .order("invoice_number", { ascending: true });
    if (cashErr) throw cashErr;

    interface WorkItem {
      kind: "layaway" | "cash_order";
      id: string;
      invoice_number: string;
      currency: string;
      cash_receipt_sheet_id: string;
    }
    const workSet: WorkItem[] = [
      ...(layawayRows ?? []).map((r: any) => ({ kind: "layaway" as const, ...r })),
      ...(cashRows ?? []).map((r: any) => ({ kind: "cash_order" as const, ...r })),
    ];
    const total = workSet.length;

    // Resume from the record immediately AFTER the cursor.
    let startIndex = 0;
    if (cursor) {
      const idx = workSet.findIndex((w) => `${w.kind}:${w.id}` === cursor);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }

    // php_jpy_rate once per call (CLAUDE.md currency standard).
    let phpJpyRate = 1.0;
    const { data: rateRow } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "php_jpy_rate")
      .single();
    if (rateRow?.value) {
      const parsed = parseFloat(String(rateRow.value));
      if (!isNaN(parsed) && parsed > 0) phpJpyRate = parsed;
    }

    const batch = workSet.slice(startIndex, startIndex + batchSize);
    const results: any[] = [];
    let ok = 0;
    let skipped = 0;
    let errors = 0;
    let totalOverflow = 0;
    let lastCursor: string | null = cursor;

    for (const item of batch) {
      lastCursor = `${item.kind}:${item.id}`;
      try {
        const { data: receipts, error: receiptsErr } = await supabase
          .from("payment_submissions")
          .select("proof_url, payment_date, submitted_amount")
          .eq(item.kind === "layaway" ? "account_id" : "cash_order_id", item.id)
          .eq("status", "confirmed")
          .not("proof_url", "is", null)
          .order("payment_date", { ascending: true })
          .order("created_at", { ascending: true });
        if (receiptsErr) throw receiptsErr;

        if (!receipts || receipts.length === 0) {
          results.push({ invoice_number: item.invoice_number, kind: item.kind, skipped: "no confirmed receipts" });
          skipped++;
          continue;
        }

        const slots: CashReceiptSlot[] = receipts.map((r: any, idx: number) => ({
          slot_index: idx + 1,
          proof_url: r.proof_url as string,
          invoice_number: item.invoice_number,
          payment_date: r.payment_date,
          amount: item.currency === "JPY"
            ? r.submitted_amount
            : Math.round(r.submitted_amount / phpJpyRate),
        }));

        if (dry_run) {
          const map = await deriveSlotMap(item.cash_receipt_sheet_id);
          const capacity = Object.keys(map).length;
          const overflow = Math.max(0, slots.length - capacity);
          totalOverflow += overflow;
          results.push({
            invoice_number: item.invoice_number,
            kind: item.kind,
            capacity,
            would_write: slots.length,
            overflow,
          });
          ok++;
        } else {
          const rr = await appendManyReceipts(item.cash_receipt_sheet_id, slots);
          totalOverflow += rr.overflow;
          results.push({
            invoice_number: item.invoice_number,
            kind: item.kind,
            capacity: rr.capacity,
            written: rr.written,
            overflow: rr.overflow,
            cells_updated: rr.cells_updated,
          });
          ok++;
        }
      } catch (e) {
        results.push({ invoice_number: item.invoice_number, kind: item.kind, error: String((e as any)?.message ?? e) });
        errors++;
      }

      // Stay inside Google's Sheets quota.
      await sleep(1000);
    }

    const processed = batch.length;
    const nextIndex = startIndex + processed;
    const exhausted = nextIndex >= total;
    const next_cursor = exhausted ? null : lastCursor;
    const remaining = Math.max(0, total - nextIndex);

    return json({
      dry_run,
      processed,
      next_cursor,
      total,
      remaining,
      results,
      summary: { ok, skipped, errors, total_overflow: totalOverflow },
    });
  } catch (error) {
    return json({ error: (error as Error).message }, 500);
  }
});
