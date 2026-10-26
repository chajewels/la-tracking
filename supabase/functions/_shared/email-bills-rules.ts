/**
 * Emailed bills → draft expenses (Expenses Phase 4, owner decisions 2026-10-26 D1–D6; plan
 * claude/expenses-phase4-email-bills-plan-2026-10-26.md). Pure rules — no Deno, no network — so Vitest
 * pins them (src/test/email-bills.test.ts) and the edge function expenses-email-bills just wires them.
 *
 * Flow per Gmail message: parse headers/body/attachments → rule hints → one AI extraction (strict JSON)
 * → decision: drafted (confident bill with a JPY/PHP amount) | needs_review (looks like a bill, figure
 * missing / other currency / low confidence) | skipped (not a bill). Matching to an open recurring draft
 * happens in SQL (expenses_email_match_recurring) and turns a would-be draft into "matched".
 */

export const EMAIL_LOOKBACK_DAYS = 3;
export const EMAIL_MAX_PER_RUN = 25;
export const EMAIL_BODY_LIMIT = 20_000;
export const DRAFT_CONFIDENCE = 0.6;
export const ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MIMES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** Senders that almost always carry a business bill — a hint for the model, never a decision on its own. */
export const VENDOR_HINTS: { pattern: RegExp; vendor: string; category: string }[] = [
  { pattern: /lovable\.(dev|app)/i, vendor: "Lovable", category: "Lovable, Firebase, Vercel, Claude and other dev tools" },
  { pattern: /vercel\.com/i, vendor: "Vercel", category: "Lovable, Firebase, Vercel, Claude and other dev tools" },
  { pattern: /anthropic\.com|claude\.(ai|com)/i, vendor: "Anthropic", category: "Lovable, Firebase, Vercel, Claude and other dev tools" },
  { pattern: /firebase|cloud\.google\.com|payments-noreply@google\.com/i, vendor: "Google Cloud", category: "Lovable, Firebase, Vercel, Claude and other dev tools" },
  { pattern: /workspace.*google|google\.com.*workspace|googleworkspace/i, vendor: "Google Workspace", category: "Page365, Pancake, Metricool, Google Workspace" },
  { pattern: /page365/i, vendor: "Page365", category: "Page365, Pancake, Metricool, Google Workspace" },
  { pattern: /pancake/i, vendor: "Pancake", category: "Page365, Pancake, Metricool, Google Workspace" },
  { pattern: /metricool/i, vendor: "Metricool", category: "Page365, Pancake, Metricool, Google Workspace" },
  { pattern: /photoroom/i, vendor: "Photoroom", category: "Photoroom" },
  { pattern: /facebookmail\.com|meta\.com|facebook\.com/i, vendor: "Meta Ads", category: "Meta and Google ads" },
  { pattern: /ads-noreply@google\.com|google ads/i, vendor: "Google Ads", category: "Meta and Google ads" },
  { pattern: /resend\.com|sendgrid|postmark/i, vendor: "Email sending", category: "Email sending and domains" },
  { pattern: /namecheap|godaddy|cloudflare|onamae|お名前/i, vendor: "Domains", category: "Email sending and domains" },
  { pattern: /japanpost|日本郵便|yamato|ヤマト|sagawa|佐川|dhl\.com|lbcexpress/i, vendor: "Carrier", category: "Carrier cost (Japan Post, LBC, DHL)" },
  { pattern: /squareup\.com/i, vendor: "Square", category: "Square fees" },
  { pattern: /paidy\.com/i, vendor: "Paidy", category: "Paidy fees" },
  { pattern: /stripe\.com/i, vendor: "Stripe", category: "Stripe konbini fees" },
];

export const SUBJECT_HINT = /invoice|receipt|請求|領収|statement|payment (confirmation|received|successful)|your order|お支払い|ご請求|明細|renewal|subscription|billing/i;
export const NOT_BILL_HINT = /unsubscribe|newsletter|webinar|sale ends|% off|promo code|password reset|verify your|security alert|new sign-in|welcome to|your (layaway|order) (is|has)|payment plan|tracking number|layaway/i;

export type ParsedHeader = { fromName: string | null; fromEmail: string | null; subject: string; receivedAt: string | null };

export function parseFromHeader(raw: string | undefined | null): { name: string | null; email: string | null } {
  const s = (raw ?? "").trim();
  if (!s) return { name: null, email: null };
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() || null };
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: null, email: s.toLowerCase() };
  return { name: s, email: null };
}

export function headerValue(headers: { name?: string; value?: string }[] | undefined, name: string): string | undefined {
  return headers?.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value;
}

/** Gmail's base64url (with or without padding) → UTF-8 text. */
export function decodeBase64Url(data: string | undefined | null): string {
  if (!data) return "";
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (data.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export type GmailPart = {
  mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string; size?: number }; parts?: GmailPart[];
};
export type AttachmentRef = { name: string; mime: string; size: number; attachmentId: string };

/** Walks a Gmail payload: returns the text body (plain preferred, HTML stripped otherwise) and receipt-like attachments. */
export function walkParts(payload: GmailPart | undefined): { text: string; attachments: AttachmentRef[] } {
  let plain = "", html = "";
  const attachments: AttachmentRef[] = [];
  const visit = (p: GmailPart | undefined) => {
    if (!p) return;
    const mime = (p.mimeType ?? "").toLowerCase();
    if (p.filename && p.body?.attachmentId) {
      const size = p.body.size ?? 0;
      if (ATTACHMENT_MIMES.has(mime) && size > 0 && size <= ATTACHMENT_LIMIT_BYTES) {
        attachments.push({ name: safeFileName(p.filename), mime, size, attachmentId: p.body.attachmentId });
      }
    } else if (mime === "text/plain" && p.body?.data) {
      plain += decodeBase64Url(p.body.data) + "\n";
    } else if (mime === "text/html" && p.body?.data) {
      html += decodeBase64Url(p.body.data) + "\n";
    }
    for (const c of p.parts ?? []) visit(c);
  };
  visit(payload);
  const text = (plain.trim() ? plain.trim() : stripHtml(html)).slice(0, EMAIL_BODY_LIMIT);
  return { text, attachments: attachments.slice(0, 5) };
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "attachment";
  const cleaned = base.replace(/[^\w.\-()぀-ヿ一-龯]+/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "attachment";
}

export function vendorHint(fromEmail: string | null, subject: string, text: string): { vendor: string; category: string } | null {
  const hay = `${fromEmail ?? ""} ${subject} ${text.slice(0, 600)}`;
  return VENDOR_HINTS.find((h) => h.pattern.test(hay)) ?? null;
}

// ---------- AI extraction ----------

export type Extraction = {
  is_bill: boolean;
  vendor: string | null;
  amount: number | null;
  currency: "JPY" | "PHP" | "OTHER" | null;
  bill_date: string | null;
  description: string | null;
  category: string | null;
  confidence: number;
  reason: string;
};

export function buildPrompt(input: {
  fromName: string | null; fromEmail: string | null; subject: string; receivedAt: string | null; text: string;
  attachments: { name: string; mime: string }[]; categories: string[]; hint: { vendor: string; category: string } | null; today: string;
}): { system: string; user: string } {
  const system = `You read one email received by a small Japanese jewelry company (Cha Jewels Japan, Tokyo; also sells to the Philippines) and decide whether it is a BILL the company has to pay or has paid: a supplier invoice, a subscription receipt, a card/payment confirmation for a business service, a carrier or bank charge. Customer messages, the company's own order emails to customers, newsletters, promotions, security alerts and sign-in notices are NOT bills.
Return ONLY a JSON object with exactly these keys:
{"is_bill": boolean, "vendor": string|null, "amount": number|null, "currency": "JPY"|"PHP"|"OTHER"|null, "bill_date": "YYYY-MM-DD"|null, "description": string|null, "category": string|null, "confidence": number 0..1, "reason": string}
Rules: amount is the TOTAL charged (tax included) as a plain number; currency JPY for ¥/円/JPY, PHP for ₱/PHP/pesos, OTHER for USD/EUR/etc.; bill_date is the invoice/charge date (fall back to the email date); description is one short line "<vendor> <what> <period>" (≤ 80 chars); category must be one of the given category names or null; confidence reflects how sure you are about is_bill AND the figures together; reason is one short sentence. No prose outside the JSON.`;
  const user = `Today: ${input.today}
From: ${input.fromName ?? ""} <${input.fromEmail ?? ""}>
Subject: ${input.subject}
Received: ${input.receivedAt ?? ""}
Attachments: ${input.attachments.map((a) => `${a.name} (${a.mime})`).join(", ") || "none"}
${input.hint ? `Hint: sender looks like ${input.hint.vendor} → category "${input.hint.category}".\n` : ""}Allowed categories: ${input.categories.join(" | ")}

Email text:
${input.text || "(no text body)"}`;
  return { system, user };
}

/** Parses the model's reply defensively: fences stripped, keys validated, numbers coerced. */
export function parseExtraction(raw: string): Extraction | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") { const n = Number(v.replace(/[^\d.-]/g, "")); return Number.isFinite(n) && v.trim() !== "" ? n : null; }
    return null;
  };
  const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const cur = typeof o.currency === "string" ? o.currency.toUpperCase().trim() : null;
  const amount = num(o.amount);
  const date = str(o.bill_date, 10);
  const conf = num(o.confidence);
  return {
    is_bill: o.is_bill === true,
    vendor: str(o.vendor, 120),
    amount: amount != null && amount > 0 ? Math.round(amount * 100) / 100 : null,
    currency: cur === "JPY" || cur === "PHP" ? cur : cur ? "OTHER" : null,
    bill_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    description: str(o.description, 200),
    category: str(o.category, 120),
    confidence: conf == null ? 0 : Math.min(1, Math.max(0, conf)),
    reason: str(o.reason, 300) ?? "",
  };
}

export type Decision = { status: "drafted" | "needs_review" | "skipped"; why: string };

/** Owner D2: a draft only for a confident bill with a JPY/PHP amount; bill-ish but incomplete → review; else skipped. */
export function decide(x: Extraction | null, hint: { vendor: string } | null, subject: string): Decision {
  if (!x) return hint || SUBJECT_HINT.test(subject) ? { status: "needs_review", why: "The email could not be read automatically." } : { status: "skipped", why: "Could not be read and does not look like a bill." };
  if (!x.is_bill) {
    if (hint && !NOT_BILL_HINT.test(subject) && x.confidence < 0.8) return { status: "needs_review", why: `Looks like ${hint.vendor} but the reader was not sure it is a bill.` };
    return { status: "skipped", why: x.reason || "Not a bill." };
  }
  if (x.currency === "OTHER") return { status: "needs_review", why: "Billed in another currency — enter the yen or peso amount by hand." };
  if (x.amount == null || !x.currency) return { status: "needs_review", why: "The amount could not be read." };
  if (x.confidence < DRAFT_CONFIDENCE) return { status: "needs_review", why: `Low confidence (${Math.round(x.confidence * 100)}%).` };
  return { status: "drafted", why: x.reason || "Bill with a readable amount." };
}

/** Whole-yen amounts; pesos to 2 dp; as a string for the SQL side. */
export function amountForSql(amount: number, currency: "JPY" | "PHP"): string {
  return currency === "JPY" ? String(Math.round(amount)) : (Math.round(amount * 100) / 100).toFixed(2);
}

export function categoryIdFor(name: string | null, categories: { id: string; name: string }[]): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === n)?.id
    ?? categories.find((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()))?.id
    ?? null;
}

/** Bill date → expense date: never in the future beyond today, never before 2020; falls back to the email day. */
export function expenseDateFor(billDate: string | null, receivedAt: string | null, today: string): string {
  const fallback = receivedAt ? receivedAt.slice(0, 10) : today;
  const d = billDate && billDate >= "2020-01-01" && billDate <= today ? billDate : (fallback <= today ? fallback : today);
  return d;
}

export function gmailQuery(lookbackDays = EMAIL_LOOKBACK_DAYS): string {
  return `newer_than:${lookbackDays}d -in:spam -in:trash -in:chats`;
}
