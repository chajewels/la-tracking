// "Store credit has been added to your account" (payment lifecycle addendum
// §9 #13, owner directive 2026-10-06). Sent by issue-store-credit after an
// admin issues credit by hand — every customer, Hub and website.
//
// Language: the language of her most recent WEBSITE order (customer_lang), else
// her country (Japan → Japanese first, anything else English) — the same rule
// as every order email (emailLang). One send per lot. NEVER throws: the credit
// is already issued; an email must not fail it.
import * as React from "npm:react@18.3.1";
import { emailLang, sendStorefrontEmail } from "./storefront-email.ts";
import { StoreCreditIssuedEmail, storeCreditIssuedSubject } from "./email-templates/store-credit-issued.tsx";

// deno-lint-ignore no-explicit-any
type Db = any;

export async function sendStoreCreditIssuedEmail(
  db: Db,
  args: { customerId: string; lotId: string; amount: number; currency: "JPY" | "PHP"; expiresAt: string | null },
): Promise<void> {
  try {
    const [{ data: customer }, { data: lastWeb }] = await Promise.all([
      db.from("customers").select("id, email, is_test, country, customer_code").eq("id", args.customerId).maybeSingle(),
      db.from("cash_orders").select("customer_lang").eq("customer_id", args.customerId).eq("source_channel", "web")
        .not("customer_lang", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (!customer) return;
    const country = String(customer.country ?? "").trim().toUpperCase();
    const lang = emailLang(lastWeb?.customer_lang ?? null, country === "JAPAN" || country === "JP" ? "JP" : country || null);
    await sendStorefrontEmail({
      to: { email: customer.email ?? null, is_test: customer.is_test === true },
      subject: storeCreditIssuedSubject(lang),
      label: "store-credit-issued",
      reference: String(customer.customer_code ?? args.customerId),
      idempotencyKey: `store-credit-issued-${args.lotId}`,
      element: React.createElement(StoreCreditIssuedEmail, {
        lang, amount: args.amount, currency: args.currency, expiresAt: args.expiresAt,
      }),
    });
  } catch (e) {
    console.warn("[store-credit-email] send failed (non-blocking):", (e as Error)?.message ?? String(e));
  }
}
