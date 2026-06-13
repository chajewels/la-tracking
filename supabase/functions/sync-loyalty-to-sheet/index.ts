/**
 * sync-loyalty-to-sheet — live Google Sheets mirror.
 *
 * Writes one row per loyalty event to the Sheet configured in
 * system_settings.loyalty_sheet_id. Members-tab events and
 * Transactions-tab events use distinct, column-locked layouts.
 * Real-time only in v1 — loyalty_sheet_sync_frequency is informational
 * and ignored here; every event is appended immediately.
 *
 * Canonical taxonomy is enforced: any event_type outside the two
 * sets below is rejected with 400.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";
import { isServiceRole, parseJwtClaims } from "../_shared/jwt-claims.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// ── Canonical taxonomy ──────────────────────────────────────────────
const MEMBERS_TAB_EVENTS = new Set([
  "enrolled",
  "tier_changed",
  "status_changed",
  "admin_edited",
]);
const TRANSACTIONS_TAB_EVENTS = new Set([
  "earned",
  "bonus",
  "redeemed",
  "expired",
  "adjusted",
  "refunded",
  "revoked",
  "birthday_bonus",
]);

// ── Helpers ─────────────────────────────────────────────────────────

/** "2026-05-16 14:30 PHT" — Asia/Manila wall clock. */
function formatPHT(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} PHT`;
}

/** "YYYY-MM-DD" (Asia/Manila) or "" when no date. */
function formatDateOnly(v: unknown): string {
  if (v == null || v === "") return "";
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Members-tab Activity Status from last_purchase_at.
 *  - null/undefined  → "Active" (new member, no purchase yet)
 *  - < 90 days ago   → "Active"
 *  - >= 90 days ago  → "Inactive"
 */
function deriveActivityStatus(v: unknown): "Active" | "Inactive" {
  if (v == null || v === "") return "Active";
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return "Active";
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  return Date.now() - d.getTime() >= ninetyDaysMs ? "Inactive" : "Active";
}

/**
 * Signed plain number for Sheets numeric cells.
 *   500 → 500, -300 → -300, null/non-finite → ""
 * Returned as a raw JS number so the Sheets API serializes it as a
 * numeric cell value under valueInputOption=USER_ENTERED. NEVER
 * return a string like "+500" — Sheets parses the leading "+" as a
 * formula start, and any comma-formatted "+2,200" then fails
 * formula parse → #ERROR! in the cell. (Live bug, 2026-06-13.)
 */
function signedNumberOrBlank(v: unknown): number | "" {
  const n = Number(v);
  return Number.isFinite(n) ? n : "";
}

/** Raw plain number for Sheets numeric cells, or "" when missing. */
function plainNumberOrBlank(v: unknown): number | "" {
  const n = Number(v);
  return Number.isFinite(n) ? n : "";
}

type CustomerBlock = {
  customer_id?: string;
  full_name?: string | null;
  email?: string | null;
};

function buildMembersRow(
  eventType: string,
  customer: CustomerBlock,
  payload: Record<string, unknown>,
): (string | number)[] {
  const lastPurchase = payload.last_purchase_at ?? payload.last_purchase_date ?? null;
  return [
    formatPHT(new Date()), // A timestamp
    eventType, // B event_type
    (payload.member_id as string) ?? "", // C member_id
    customer.full_name ?? "", // D full_name
    customer.email ?? "", // E email
    (payload.current_tier as string) ?? "", // F current_tier
    payload.lifetime_spend_jpy != null ? plainNumberOrBlank(payload.lifetime_spend_jpy) : "", // G
    payload.available_points != null ? plainNumberOrBlank(payload.available_points) : "", // H
    deriveActivityStatus(lastPurchase), // I activity_status
    formatDateOnly(lastPurchase), // J last_purchase_date
    (payload.notes as string) ?? "", // K notes
  ];
}

function buildTransactionsRow(
  eventType: string,
  customer: CustomerBlock,
  payload: Record<string, unknown>,
): (string | number)[] {
  return [
    formatPHT(new Date()), // A timestamp
    (payload.transaction_id as string) ?? "", // B transaction_id
    eventType, // C event_type
    (payload.member_id as string) ?? "", // D member_id
    customer.full_name ?? "", // E full_name
    payload.points_amount != null ? signedNumberOrBlank(payload.points_amount) : "", // F
    payload.spend_amount_jpy != null ? plainNumberOrBlank(payload.spend_amount_jpy) : "", // G
    payload.multiplier != null ? `${Number(payload.multiplier).toFixed(1)}x` : "", // H
    (payload.tier_at_time as string) ?? "", // I tier_at_time
    (payload.invoice_number as string) ?? "", // J invoice_number
    (payload.account_id as string) ?? "", // K account_id
    (payload.notes as string) ?? "", // L notes
    (payload.created_by as string) ?? "", // M created_by
  ];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!isServiceRole(authToken)) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await req.json().catch(() => null) as
      | {
        event_type?: string;
        customer?: CustomerBlock;
        payload?: Record<string, unknown>;
      }
      | null;

    if (!body) {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const eventType = body.event_type;
    const customer: CustomerBlock = body.customer ?? {};
    const payload: Record<string, unknown> = body.payload ?? {};

    if (!eventType || !customer.customer_id) {
      return json(
        { error: "event_type and customer.customer_id are required" },
        400,
      );
    }

    let tab: "Members" | "Transactions";
    if (MEMBERS_TAB_EVENTS.has(eventType)) {
      tab = "Members";
    } else if (TRANSACTIONS_TAB_EVENTS.has(eventType)) {
      tab = "Transactions";
    } else {
      return json({ error: `Unknown event_type: ${eventType}` }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: settingRow, error: settingErr } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "loyalty_sheet_id")
      .maybeSingle();

    if (settingErr) {
      console.error("[sync-loyalty-to-sheet] settings read failed:", settingErr);
      return json({ error: "Failed to read loyalty_sheet_id" }, 500);
    }

    let sheetId = "";
    const rawId = settingRow?.value;
    if (rawId != null) {
      if (typeof rawId === "string") {
        try {
          const parsed = JSON.parse(rawId);
          sheetId = typeof parsed === "string" ? parsed : String(parsed ?? "");
        } catch {
          sheetId = rawId;
        }
      } else {
        sheetId = String(rawId);
      }
    }
    sheetId = sheetId.trim();

    if (!sheetId) {
      return json({
        success: true,
        disabled: true,
        reason: "loyalty_sheet_id not set",
      });
    }

    const row = tab === "Members"
      ? buildMembersRow(eventType, customer, payload)
      : buildTransactionsRow(eventType, customer, payload);

    const accessToken = await getServiceAccountAccessToken();

    const appendUrl =
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${
        encodeURIComponent(tab)
      }!A:A:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const res = await fetch(appendUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [row] }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(
        "[sync-loyalty-to-sheet] Sheets append failed:",
        res.status,
        errText,
      );
      return json(
        { error: `Sheets append failed (${res.status})`, detail: errText },
        500,
      );
    }

    const result = await res.json().catch(() => ({}));
    return json({
      success: true,
      tab,
      range: result?.updates?.updatedRange ?? "unknown",
      event_type: eventType,
    });
  } catch (err) {
    console.error("[sync-loyalty-to-sheet] unexpected error:", err);
    return json({ error: (err as Error).message || "internal_error" }, 500);
  }
});
