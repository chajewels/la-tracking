/**
 * expenses-email-bills — Expenses Phase 4 (owner decisions 2026-10-26 D1–D6; plan
 * claude/expenses-phase4-email-bills-plan-2026-10-26.md; docs/EXPENSES.md "Phase 4").
 *
 * Reads the sales@ mailbox READ-ONLY through the Hub's Google service account (domain-wide delegation,
 * gmail.readonly — granted in Google Admin), classifies each new message with the Lovable AI gateway and
 * records the outcome in expense_email_messages:
 *   drafted      → one DRAFT expense (source email, source_ref = Gmail id) with the attachments as receipt
 *   matched      → the bill belongs to an open recurring draft (Phase 3): receipt + figures attached to it
 *   needs_review → looks like a bill but a figure is missing / other currency / low confidence
 *   skipped      → not a bill (kept 90 days)
 * Nothing is approved here. Never writes to Gmail. Gated by system_settings.expenses_email_enabled.
 *
 * Auth: service role only (pg_cron every 30 min with the Vault bearer; "Check mail now" goes through the
 * Hub's own RPC path — the client calls this function with the user's JWT and we re-check manage_expenses).
 * Body: { trigger?: "cron" | "manual", dry?: boolean, lookback_days?: number }.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { GMAIL_READONLY_SCOPE, getServiceAccountAccessToken } from "../_shared/google-auth.ts";
import { maskEmail } from "../_shared/redact.ts";
import {
  EMAIL_LOOKBACK_DAYS, EMAIL_MAX_PER_RUN, type AttachmentRef, type Extraction, type GmailPart,
  amountForSql, buildPrompt, categoryIdFor, decide, expenseDateFor, gmailQuery, headerValue, parseExtraction, parseFromHeader,
  vendorHint, walkParts,
} from "../_shared/email-bills-rules.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const RECEIPT_BUCKET = "expense-receipts";

type Ctx = {
  enabled: boolean; mailbox: string; rate_set: boolean; known_ids: string[];
  categories: { id: string; name: string; group_key: string }[]; vendors: string[];
};

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "manage_expenses");
  if (denied) return denied;
  // The recording RPCs and the receipt uploads are service-role only (they refuse a signed-in uid), so the
  // work runs on a service client whoever pressed the button; the caller's identity is kept for run_by.
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: { trigger?: string; dry?: boolean; lookback_days?: number } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const trigger = ctx.isService && body.trigger !== "manual" ? "cron" : "manual";
  const dry = body.dry === true;
  const lookback = Math.min(Math.max(Number(body.lookback_days) || EMAIL_LOOKBACK_DAYS, 1), 14);
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  // 1. Context from the database (settings, known ids, categories, vendors).
  const { data: ctxData, error: ctxErr } = await supabase.rpc("expenses_email_context");
  if (ctxErr) return jsonResponse({ error: "context_failed", detail: ctxErr.message }, 500);
  const c = ctxData as Ctx & { error?: string };
  if (c?.error) return jsonResponse({ error: c.error }, 403);
  if (!c.enabled && !dry) return jsonResponse({ ok: true, skipped: "disabled", message: "Email bills are turned off (expenses_email_enabled)." });
  if (!c.rate_set) return jsonResponse({ ok: false, error: "rate_not_set" }, 409);
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return jsonResponse({ error: "LOVABLE_API_KEY is not configured" }, 500);

  // 2. Gmail token for the mailbox.
  let token: string;
  try {
    token = await getServiceAccountAccessToken({ scopes: [GMAIL_READONLY_SCOPE], subject: c.mailbox });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("expenses-email-bills: token failed", msg);
    return jsonResponse({ ok: false, error: "gmail_auth_failed", detail: msg.includes("unauthorized_client") ? "Google Admin has not granted gmail.readonly to the Hub's service account yet." : msg }, 502);
  }
  const g = (path: string) => fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  // 3. New messages.
  const listRes = await g(`/messages?q=${encodeURIComponent(gmailQuery(lookback))}&maxResults=100`);
  if (!listRes.ok) {
    const detail = await listRes.text();
    console.error("expenses-email-bills: list failed", listRes.status, detail.slice(0, 300));
    return jsonResponse({ ok: false, error: "gmail_list_failed", status: listRes.status }, 502);
  }
  const listed = ((await listRes.json()).messages ?? []) as { id: string; threadId: string }[];
  const known = new Set(c.known_ids ?? []);
  const fresh = listed.filter((m) => !known.has(m.id)).slice(0, EMAIL_MAX_PER_RUN);

  let runId: string | null = null;
  if (!dry) {
    const { data: run } = await supabase.rpc("expenses_email_run", { p: { phase: "start", trigger, run_by: ctx.user?.id ?? null } });
    runId = (run as { run_id?: string })?.run_id ?? null;
  }
  const counts: Record<"looked_at" | "drafted" | "matched" | "needs_review" | "skipped" | "errors", number> =
    { looked_at: 0, drafted: 0, matched: 0, needs_review: 0, skipped: 0, errors: 0 };
  const notes: string[] = [];
  const results: Record<string, unknown>[] = [];

  for (const m of fresh) {
    counts.looked_at += 1;
    try {
      const r = await processMessage(m.id, m.threadId, { supabase, g, token, apiKey, ctx: c, today, dry });
      const key = (["drafted", "matched", "needs_review", "skipped"] as const).find((k) => k === r.status) ?? "errors";
      counts[key] += 1;
      results.push(r);
    } catch (e) {
      counts.errors += 1;
      const msg = (e as Error).message ?? String(e);
      notes.push(`${m.id}: ${msg}`);
      console.error("expenses-email-bills: message failed", m.id, msg);
      if (!dry) {
        await supabase.rpc("expenses_email_record", { p: { gmail_message_id: m.id, thread_id: m.threadId, mailbox: c.mailbox, status: "error", error: msg.slice(0, 1000) } });
      }
    }
  }

  if (!dry && runId) {
    await supabase.rpc("expenses_email_run", { p: { phase: "finish", run_id: runId, ...counts, note: notes.join("\n").slice(0, 2000) || null } });
  }
  return jsonResponse({ ok: true, dry, mailbox: maskEmail(c.mailbox), ...counts, results: dry ? results : results.map((r) => ({ id: r.id, status: r.status, why: r.why })) });
});

type Deps = {
  supabase: SupabaseClient; g: (path: string) => Promise<Response>; token: string; apiKey: string; ctx: Ctx; today: string; dry: boolean;
};

async function processMessage(id: string, threadId: string, d: Deps): Promise<Record<string, unknown> & { status: string }> {
  const res = await d.g(`/messages/${id}?format=full`);
  if (!res.ok) throw new Error(`gmail get ${res.status}`);
  const msg = await res.json() as { payload?: GmailPart & { headers?: { name: string; value: string }[] }; internalDate?: string };
  const headers = msg.payload?.headers ?? [];
  const from = parseFromHeader(headerValue(headers, "From"));
  const subject = (headerValue(headers, "Subject") ?? "").slice(0, 500);
  const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
  const { text, attachments } = walkParts(msg.payload);
  const hint = vendorHint(from.email, subject, text);

  // AI extraction (one call).
  const prompt = buildPrompt({
    fromName: from.name, fromEmail: from.email, subject, receivedAt, text,
    attachments: attachments.map((a) => ({ name: a.name, mime: a.mime })),
    categories: d.ctx.categories.map((x) => x.name), hint, today: d.today,
  });
  let extraction: Extraction | null = null;
  const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${d.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3.8-flash",
      messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
      temperature: 0.1,
      reasoning_effort: "none",
    }),
  });
  if (aiRes.ok) {
    const j = await aiRes.json();
    extraction = parseExtraction(String(j?.choices?.[0]?.message?.content ?? ""));
  } else {
    const detail = await aiRes.text();
    console.error("expenses-email-bills: gateway", aiRes.status, detail.slice(0, 200));
    if (aiRes.status === 429 || aiRes.status === 402) throw new Error(`ai_gateway_${aiRes.status}`);
  }
  const decision = decide(extraction, hint, subject);
  const base = {
    gmail_message_id: id, thread_id: threadId, mailbox: d.ctx.mailbox, from_email: from.email, from_name: from.name, subject, received_at: receivedAt,
    confidence: extraction?.confidence ?? null,
    extracted: { ...(extraction ?? {}), why: decision.why, hint: hint?.vendor ?? null },
  };
  const summary = { id, subject, from: maskEmail(from.email ?? ""), status: decision.status, why: decision.why, extraction };
  if (d.dry) return summary;

  if (decision.status !== "drafted" || !extraction || extraction.amount == null || !extraction.currency || extraction.currency === "OTHER") {
    // needs_review / skipped: keep the attachments so "Make expense" can reuse them.
    const stored = decision.status === "needs_review" ? await storeAttachments(d, id, `email/${id}`, attachments) : [];
    await d.supabase.rpc("expenses_email_record", { p: { ...base, status: decision.status, attachments: stored } });
    return summary;
  }

  const currency = extraction.currency as "JPY" | "PHP";
  const amount = Number(amountForSql(extraction.amount, currency));
  const categoryId = categoryIdFor(extraction.category, d.ctx.categories) ?? (hint ? categoryIdFor(hint.category, d.ctx.categories) : null);
  const vendorName = extraction.vendor ?? hint?.vendor ?? from.name ?? null;
  const expenseDate = expenseDateFor(extraction.bill_date, receivedAt, d.today);

  // Matched to an open recurring draft? (owner D3)
  const { data: matchData } = await d.supabase.rpc("expenses_email_match_recurring", {
    p_vendor: vendorName, p_category_id: categoryId, p_amount: amount, p_currency: currency, p_date: expenseDate,
  });
  const match = (matchData as { match?: { id: string; has_receipt: boolean } | null })?.match ?? null;
  if (match) {
    const stored = match.has_receipt ? [] : await storeAttachments(d, id, match.id, attachments);
    await d.supabase.rpc("expenses_email_attach_to_draft", {
      p_expense_id: match.id, p_receipt_path: stored[0]?.path ?? null, p_amount: amount,
      p_email: { gmail_message_id: id, from: from.email, subject, received_at: receivedAt },
    });
    await d.supabase.rpc("expenses_email_record", { p: { ...base, status: "matched", matched_expense_id: match.id, attachments: stored } });
    return { ...summary, status: "matched", matched_expense_id: match.id };
  }

  // A fresh draft: receipts first (path must start with the draft's id), then the row.
  const newId = crypto.randomUUID();
  const stored = await storeAttachments(d, id, newId, attachments);
  const { data: created } = await d.supabase.rpc("expenses_create_email_draft", {
    p: {
      gmail_message_id: id, id: newId, expense_date: expenseDate, category_id: categoryId, vendor_name: vendorName,
      description: (extraction.description ?? `${vendorName ?? "Bill"} — ${subject}`).slice(0, 500),
      currency, amount: amountForSql(extraction.amount, currency), payment_method: "other",
      receipt_path: stored[0]?.path ?? null,
      details: { from: from.email, subject, received_at: receivedAt, confidence: extraction.confidence, reason: extraction.reason, vendor: vendorName, needs_category: categoryId == null },
    },
  });
  const out = created as { ok?: boolean; error?: string; expense?: { id: string } };
  if (!out?.ok) {
    if (out?.error === "already_generated") {
      await d.supabase.rpc("expenses_email_record", { p: { ...base, status: "skipped", extracted: { ...base.extracted, why: "An expense already exists for this email." } } });
      return { ...summary, status: "skipped" };
    }
    throw new Error(`draft_failed:${out?.error ?? "unknown"}`);
  }
  await d.supabase.rpc("expenses_email_record", { p: { ...base, status: "drafted", expense_id: out.expense?.id, attachments: stored } });
  return { ...summary, status: "drafted", expense_id: out.expense?.id };
}

async function storeAttachments(d: Deps, messageId: string, folder: string, attachments: AttachmentRef[]) {
  const stored: { name: string; mime: string; size: number; path: string }[] = [];
  for (const a of attachments) {
    const res = await d.g(`/messages/${messageId}/attachments/${a.attachmentId}`);
    if (!res.ok) continue;
    const j = await res.json() as { data?: string; size?: number };
    if (!j.data) continue;
    const b64 = j.data.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const path = `${folder}/${Date.now()}-${a.name}`;
    const { error } = await d.supabase.storage.from(RECEIPT_BUCKET).upload(path, bytes, { contentType: a.mime, upsert: false });
    if (error) { console.error("expenses-email-bills: upload failed", error.message); continue; }
    stored.push({ name: a.name, mime: a.mime, size: bytes.length, path });
  }
  return stored;
}
