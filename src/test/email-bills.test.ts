import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DRAFT_CONFIDENCE, amountForSql, buildPrompt, categoryIdFor, decide, decodeBase64Url, expenseDateFor, gmailQuery, headerValue,
  parseExtraction, parseFromHeader, safeFileName, stripHtml, vendorHint, walkParts,
} from "../../supabase/functions/_shared/email-bills-rules.ts";
import { canEnterManually, refusalCode } from "@/components/finance/expenses";
import {
  type EmailBill, emailBillRefusal, emailDraftsToConfirm, groupByStatus, lastRunLabel, needsCategory, normaliseEmailBills, prefillFromEmail, whyLabel,
} from "@/components/finance/email-bills";

/**
 * Emailed bills (Expenses Phase 4, owner 2026-10-26 D1–D6): the pure rules the edge function
 * expenses-email-bills wires (Gmail decoding, hints, prompt, response parsing, the draft / review / skip
 * decision) and what the Expenses tab shows.
 */

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("email bills — Gmail decoding", () => {
  it("parses From headers and base64url bodies", () => {
    expect(parseFromHeader('"Photoroom Billing" <billing@photoroom.com>')).toEqual({ name: "Photoroom Billing", email: "billing@photoroom.com" });
    expect(parseFromHeader("billing@Vercel.com")).toEqual({ name: null, email: "billing@vercel.com" });
    expect(parseFromHeader("")).toEqual({ name: null, email: null });
    expect(headerValue([{ name: "subject", value: "Hi" }], "Subject")).toBe("Hi");
    expect(decodeBase64Url(b64url("合計 ¥1,800 税込"))).toBe("合計 ¥1,800 税込");
    expect(decodeBase64Url("")).toBe("");
  });
  it("walks nested parts: plain text preferred, HTML stripped otherwise, receipt-like attachments only", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", body: { data: b64url("Thanks for your payment of ¥1,800.") } },
          { mimeType: "text/html", body: { data: b64url("<p>Thanks for your <b>payment</b></p>") } },
        ] },
        { mimeType: "application/pdf", filename: "Receipt #123.pdf", body: { attachmentId: "att1", size: 5000 } },
        { mimeType: "image/gif", filename: "logo.gif", body: { attachmentId: "att2", size: 400 } },
        { mimeType: "application/pdf", filename: "huge.pdf", body: { attachmentId: "att3", size: 50_000_000 } },
      ],
    };
    const out = walkParts(payload);
    expect(out.text).toBe("Thanks for your payment of ¥1,800.");
    expect(out.attachments).toEqual([{ name: "Receipt_123.pdf", mime: "application/pdf", size: 5000, attachmentId: "att1" }]);
    const htmlOnly = walkParts({ mimeType: "text/html", body: { data: b64url("<div>Total<br>¥2,000</div><style>x{}</style>") } });
    expect(htmlOnly.text).toBe("Total\n¥2,000");
    expect(stripHtml("a &amp; b&nbsp;c")).toBe("a & b c");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("領収書.pdf")).toBe("領収書.pdf");
    expect(safeFileName("invoice..pdf")).toBe("invoice.pdf");
  });
  it("builds the Gmail query for the lookback window", () => {
    expect(gmailQuery(3)).toBe("newer_than:3d -in:spam -in:trash -in:chats");
  });
});

describe("email bills — hints, prompt, parsing, decision", () => {
  it("recognises known vendors from the sender", () => {
    expect(vendorHint("billing@photoroom.com", "Your receipt", "")?.vendor).toBe("Photoroom");
    expect(vendorHint("no-reply@lovable.dev", "Invoice", "")?.category).toContain("Lovable");
    expect(vendorHint("customer@gmail.com", "Hello", "")).toBeNull();
  });
  it("prompts with the allowed categories and the hint", () => {
    const p = buildPrompt({ fromName: "Lovable", fromEmail: "billing@lovable.dev", subject: "Invoice", receivedAt: "2026-10-25T01:00:00Z", text: "Total $25",
      attachments: [{ name: "inv.pdf", mime: "application/pdf" }], categories: ["Photoroom", "Meta and Google ads"], hint: { vendor: "Lovable", category: "Dev tools" }, today: "2026-10-26" });
    expect(p.system).toContain('"is_bill": boolean');
    expect(p.user).toContain("Allowed categories: Photoroom | Meta and Google ads");
    expect(p.user).toContain("Hint: sender looks like Lovable");
    expect(p.user).toContain("inv.pdf (application/pdf)");
  });
  it("parses the model's JSON defensively", () => {
    const x = parseExtraction('```json\n{"is_bill": true, "vendor": "Photoroom", "amount": "1,800", "currency": "jpy", "bill_date": "2026-10-24", "description": "Photoroom Pro Oct", "category": "Photoroom", "confidence": 0.92, "reason": "Receipt"}\n```');
    expect(x).toMatchObject({ is_bill: true, vendor: "Photoroom", amount: 1800, currency: "JPY", bill_date: "2026-10-24", confidence: 0.92 });
    expect(parseExtraction("not json")).toBeNull();
    expect(parseExtraction('{"is_bill": false, "currency": "USD", "amount": 20, "confidence": 1.4}')).toMatchObject({ is_bill: false, currency: "OTHER", amount: 20, confidence: 1 });
    expect(parseExtraction('{"is_bill": true, "bill_date": "24 Oct"}')?.bill_date).toBeNull();
  });
  it("decides draft / review / skip the way the owner chose (D2, D4)", () => {
    const bill = { is_bill: true, vendor: "Photoroom", amount: 1800, currency: "JPY" as const, bill_date: "2026-10-24", description: "x", category: "Photoroom", confidence: 0.9, reason: "Receipt" };
    expect(decide(bill, null, "Receipt").status).toBe("drafted");
    expect(decide({ ...bill, confidence: DRAFT_CONFIDENCE - 0.1 }, null, "Receipt")).toMatchObject({ status: "needs_review" });
    expect(decide({ ...bill, currency: "OTHER" }, null, "Receipt").why).toContain("another currency");
    expect(decide({ ...bill, amount: null }, null, "Receipt").why).toContain("amount could not be read");
    expect(decide({ ...bill, is_bill: false, confidence: 0.95 }, null, "Weekly newsletter").status).toBe("skipped");
    expect(decide({ ...bill, is_bill: false, confidence: 0.5 }, { vendor: "Lovable" }, "Your Lovable usage").status).toBe("needs_review");
    expect(decide(null, null, "Hello").status).toBe("skipped");
    expect(decide(null, null, "Invoice 2026-10").status).toBe("needs_review");
  });
  it("shapes figures for SQL", () => {
    expect(amountForSql(1800.4, "JPY")).toBe("1800");
    expect(amountForSql(1500.505, "PHP")).toBe("1500.51");
    const cats = [{ id: "a", name: "Photoroom" }, { id: "b", name: "Meta and Google ads" }];
    expect(categoryIdFor("photoroom", cats)).toBe("a");
    expect(categoryIdFor("Google ads", cats)).toBe("b");
    expect(categoryIdFor("Rent", cats)).toBeNull();
    expect(expenseDateFor("2026-10-24", "2026-10-25T00:00:00Z", "2026-10-26")).toBe("2026-10-24");
    expect(expenseDateFor("2027-01-01", "2026-10-25T00:00:00Z", "2026-10-26")).toBe("2026-10-25");
    expect(expenseDateFor(null, null, "2026-10-26")).toBe("2026-10-26");
  });
});

describe("email bills — Expenses tab", () => {
  const msg = (over: Partial<EmailBill>): EmailBill => ({
    gmail_message_id: "m1", thread_id: null, mailbox: "sales@chajewelsjp.com", from_email: "billing@vercel.com", from_name: "Vercel", subject: "Your receipt",
    received_at: "2026-10-25T02:00:00Z", status: "needs_review", confidence: 0.7, extracted: { is_bill: true, currency: "OTHER", amount: 20, why: "Billed in another currency" },
    attachments: [], expense_id: null, matched_expense_id: null, error: null, ...over,
  });
  it("normalises, groups and explains", () => {
    const s = normaliseEmailBills({ enabled: true, mailbox: "sales@chajewelsjp.com", can_manage: true, last_run: null, messages: [{ ...msg({}), confidence: "0.7" }] });
    expect(s.messages[0].confidence).toBe(0.7);
    expect(groupByStatus([msg({}), msg({ gmail_message_id: "m2", status: "skipped" }), msg({ gmail_message_id: "m3", status: "needs_review" })]).map((g) => `${g.status}:${g.items.length}`)).toEqual(["needs_review:2", "skipped:1"]);
    expect(whyLabel(msg({}))).toBe("Billed in another currency");
    expect(whyLabel(msg({ status: "error", extracted: {}, error: "gmail get 500" }))).toBe("gmail get 500");
    expect(lastRunLabel(null)).toBe("No mail check yet");
    expect(lastRunLabel({ id: "r", started_at: "2026-10-25T15:07:00Z", finished_at: null, trigger: "cron", looked_at: 4, drafted: 1, matched: 1, needs_review: 1, skipped: 1, errors: 0, note: null })).toContain("4 new emails · 1 draft, 1 matched, 1 to review, 1 skipped");
    expect(emailBillRefusal("gmail_auth_failed")).toContain("Google Admin");
  });
  it("prefills Make expense and flags uncategorised drafts", () => {
    const pre = prefillFromEmail(msg({ extracted: { vendor: "Vercel", amount: 3100, currency: "JPY", bill_date: "2026-10-25", description: "Vercel Pro", category: "photoroom" } }), "2026-10-26", [{ id: "c1", name: "Photoroom" }]);
    expect(pre).toMatchObject({ expense_date: "2026-10-25", category_id: "c1", new_vendor_name: "Vercel", description: "Vercel Pro", currency: "JPY", amount: "3100", payment_method: "other" });
    expect(prefillFromEmail(msg({}), "2026-10-26", []).amount).toBe("");
    expect(needsCategory({ category_id: "u" }, [{ id: "u", system_key: "uncategorised" }])).toBe(true);
    expect(needsCategory({ category_id: "c" }, [{ id: "u", system_key: "uncategorised" }])).toBe(false);
    expect(emailDraftsToConfirm([
      { source: "email", status: "draft", expense_date: "2026-10-25" }, { source: "email", status: "approved", expense_date: "2026-10-01" }, { source: "manual", status: "draft", expense_date: "2026-10-02" },
    ])).toHaveLength(1);
  });
  it("wiring: tab, dialog, function, migration", () => {
    const read = (p: string) => readFileSync(p, "utf8");
    const tab = read("src/components/finance/ExpensesTab.tsx");
    expect(tab).toContain("<EmailBillsDialog");
    expect(tab).toContain('callRpc("email_bill_make_expense"');
    expect(tab).toContain('data-testid="from-email"');
    expect(tab).toContain("disabled={noCat}");
    expect(tab).toContain("disabled={approve.isPending || needsCategory(e, book.categories)}");
    expect(tab).toContain("expenseRefusal(refusalCode(e))");
    expect(refusalCode({ code: "23514", message: 'category_required' })).toBe("category_required");
    expect(refusalCode({ code: "P0001", message: "x" })).toBe("P0001");
    expect(canEnterManually({ active: true, system_key: "uncategorised" })).toBe(false);
    const fn = read("supabase/functions/expenses-email-bills/index.ts");
    expect(fn).toContain("GMAIL_READONLY_SCOPE");
    expect(fn).toContain("subject: c.mailbox");
    expect(fn).toContain('requirePermission(ctx, "manage_expenses")');
    expect(fn).toContain("pageToken");
    expect(fn).toContain('error === "run_active"');
    expect(fn).not.toMatch(/gmail[^\n]*(modify|send|trash)/i);
    expect(read("supabase/config.toml")).toContain("[functions.expenses-email-bills]");
    const sql = read("supabase/migrations/20270103100000_expenses_email_bills.sql");
    expect(sql).toContain("('expenses_email_enabled', '\"false\"'::jsonb)");
    expect(sql).toContain("'uncategorised'");
    expect(sql).toContain("cron.schedule('expenses-email-bills', '7,37 * * * *'");
    for (const b of (sql.match(/\$fn\$[\s\S]*?\$fn\$/g) ?? [])) expect(b).not.toMatch(/^\s*--/m);
    const ga = read("supabase/functions/_shared/google-auth.ts");
    expect(ga).toContain("scope: scopes.join(\" \")");
    expect(ga).toContain("export const GMAIL_READONLY_SCOPE");
  });
});
