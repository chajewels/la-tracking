import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as rules from "../../supabase/functions/_shared/cart-reminder-rules.ts";

/**
 * Cart reminders, stages A/B (docs/CART-REMINDERS.md). The SQL is the
 * authority and is proven by docs/sql/20261021_cart_reminders_local_tests.sql;
 * the rendered emails are proven by development/cart-reminder-ja.test.ts
 * (deno). This file pins the pure rules, the plumbing names, and the source
 * of every file in the chain — so a later edit cannot quietly drop the kill
 * switch, the consent check, the test gate, the opt-out link or the rule
 * that the Japanese email never mentions layaway.
 */

const code = (p: string) => readFileSync(p, "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const MIGRATION = "supabase/migrations/20261021100000_cart_reminders.sql";
const TEMPLATE = "supabase/functions/_shared/email-templates/cart-reminder.tsx";
const SENDER = "supabase/functions/_shared/cart-reminder-emails.ts";
const SWEEP = "supabase/functions/cart-reminder-sweep/index.ts";
const WEBSITE = "supabase/functions/website/index.ts";

describe("the switch and the plumbing names", () => {
  it("reads fail-closed", () => {
    expect(rules.readCartReminderMode("on")).toBe("on");
    expect(rules.readCartReminderMode("owner_only")).toBe("owner_only");
    for (const v of ["off", "ON", true, null, undefined, "yes", "", 1]) expect(rules.readCartReminderMode(v)).toBe("off");
  });

  it("the migration seeds OFF and 1440 idle minutes, never overwrites, and the SQL + sweep stop when off", () => {
    const sql = code(MIGRATION);
    expect(sql).toMatch(/VALUES \('cart_reminders_mode', '"off"'::jsonb/);
    expect(sql).toMatch(/VALUES \('cart_reminder_idle_minutes', '"1440"'::jsonb/);
    expect((sql.match(/ON CONFLICT \(key\) DO NOTHING/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/IF v_mode NOT IN \('owner_only','on'\) THEN RETURN; END IF;/);
    expect(stripComments(code(SWEEP))).toMatch(/if \(mode === "off"\) \{/);
  });

  it("one logical send per cart cycle: the ledger's UNIQUE(cycle_id) and the idempotency key", () => {
    expect(code(MIGRATION)).toMatch(/cycle_id\s+uuid NOT NULL UNIQUE/);
    expect(rules.cartReminderIdempotencyKey("abc")).toBe("cart-reminder-abc");
    expect(rules.CART_REMINDER_LABEL).toBe("cart-reminder");
    expect(stripComments(code(SENDER))).toMatch(/idempotencyKey: cartReminderIdempotencyKey\(String\(r\.cycle_id\)\)/);
  });

  it("finish statuses", () => {
    expect(rules.cartReminderFinishStatus({ sent: true })).toBe("sent");
    expect(rules.cartReminderFinishStatus({ sent: false, reason: "recipient_suppressed" })).toBe("suppressed");
    expect(rules.cartReminderFinishStatus({ sent: false, reason: "error" })).toBe("failed");
    expect(rules.cartReminderFinishStatus({ sent: false, reason: "not_found" })).toBe("failed");
    expect(rules.cartReminderFinishStatus({ sent: false, reason: "test_customer" })).toBe("skipped");
    expect(rules.cartReminderFinishStatus({ sent: false, reason: "no_items" })).toBe("skipped");
  });
});

describe("who is reminded (the SQL rule, pinned)", () => {
  const sql = code(MIGRATION);
  const cand = sql.slice(sql.indexOf("FUNCTION public.cart_reminder_candidates"), sql.indexOf("FUNCTION public.claim_cart_reminder"));

  it("consent, address, idle window, no order since, once per cycle, 7 days apart, stock, local hours", () => {
    expect(cand).toMatch(/JOIN customer_email_consents c ON c\.customer_id = k\.customer_id AND c\.kind = 'cart_reminder' AND c\.opted_in/);
    expect(cand).toMatch(/NOT EXISTS \(SELECT 1 FROM suppressed_emails s WHERE lower\(s\.email\) = lower\(btrim\(cu\.email\)\)\)/);
    expect(cand).toMatch(/k\.updated_at <= now\(\) - v_idle/);
    expect(cand).toMatch(/k\.updated_at >= now\(\) - interval '7 days'/);
    expect(cand).toMatch(/cash_orders o WHERE o\.customer_id = k\.customer_id AND o\.created_at >= k\.updated_at/);
    expect(cand).toMatch(/layaway_accounts a WHERE a\.customer_id = k\.customer_id AND a\.created_at >= k\.updated_at/);
    expect(cand).toMatch(/cart_reminder_sends s WHERE s\.cycle_id = k\.cycle_id/);
    expect(cand).toMatch(/s\.customer_id = k\.customer_id AND s\.claimed_at > now\(\) - interval '7 days'/);
    expect(cand).toMatch(/p\.status = 'active' AND v\.stock_qty >= 1/);
    expect(cand).toMatch(/extract\(hour FROM now\(\) AT TIME ZONE b\.tz\) BETWEEN 9 AND 19/);
  });

  it("test gate: on → real or owner-readable; owner_only → owner-readable only", () => {
    expect(cand).toMatch(/CASE WHEN v_mode = 'owner_only' THEN b\.owner_addr ELSE \(NOT b\.is_test OR b\.owner_addr\) END/);
    expect(cand).toMatch(/lower\(btrim\(cu\.email\)\) = 'chajewelsjapan@gmail\.com' OR lower\(btrim\(cu\.email\)\) LIKE '%@chajewelsjp\.com'/);
  });

  it("the claim re-checks consent and the cycle under lock", () => {
    const claim = sql.slice(sql.indexOf("FUNCTION public.claim_cart_reminder"), sql.indexOf("FUNCTION public.finish_cart_reminder"));
    expect(claim).toMatch(/kind = 'cart_reminder' AND opted_in FOR SHARE/);
    expect(claim).toMatch(/customer_carts WHERE customer_id = p_customer_id AND cycle_id = p_cycle_id/);
    expect(claim).toMatch(/ON CONFLICT \(cycle_id\) DO NOTHING/);
  });

  it("stage B reads her latest unconsumed quote of THIS cycle", () => {
    expect(cand).toMatch(/cq\.created_at >= e\.cycle_started_at/);
    expect(cand).toMatch(/cq\.consumed_at IS NULL/);
  });
});

describe("what the email says", () => {
  it("the form per language and quote; Japanese never takes the layaway form", () => {
    expect(rules.reminderForm("en", null)).toBe("stage_a");
    expect(rules.reminderForm("ja", null)).toBe("stage_a");
    expect(rules.reminderForm("en", { quote_mode: "full", quote_currency: "JPY" })).toBe("full_jpy");
    expect(rules.reminderForm("en", { quote_mode: "full", quote_currency: "PHP" })).toBe("full_php");
    expect(rules.reminderForm("ja", { quote_mode: "full", quote_currency: "PHP" })).toBe("full_php");
    expect(rules.reminderForm("en", { quote_mode: "layaway", quote_currency: "JPY", quote_term: 6 })).toBe("layaway");
    expect(rules.reminderForm("ja", { quote_mode: "layaway", quote_currency: "JPY", quote_term: 6 })).toBe("stage_a");
    expect(rules.quoteTerm({ quote_term: 6 })).toBe(6);
    expect(rules.quoteTerm({ quote_term: "x" })).toBe(3);
    expect(rules.quoteTerm({ quote_term: 24 })).toBe(3);
  });

  it("the Japanese copy of the template holds no layaway word, and the template guards the form itself", () => {
    const t = code(TEMPLATE);
    for (const w of rules.JA_FORBIDDEN) {
      // "layaway" appears in English identifiers/comments; the Japanese words must be absent everywhere.
      if (/^[　-鿿]+$/.test(w)) expect(t).not.toContain(w);
    }
    expect(t).toMatch(/lang === 'ja' && p\.form === 'layaway' \? 'stage_a' : p\.form/);
    expect(t).toMatch(/lang === 'en' && form === 'stage_a' \? reserveLine\(i\) : null/);
    expect(t).toMatch(/<Html lang=\{lang\}/);
    // One language per email: no second-language block.
    expect(t).not.toMatch(/<Block lang="en"/);
  });

  it("money is the Hub's: no percentage, rate or conversion computed in the template or sender", () => {
    for (const f of [TEMPLATE, SENDER]) {
      const s = stripComments(code(f));
      expect(s).not.toMatch(/\* 0\.|\* 100|\/ 100|0\.3\b|toPhp|phpRate|jpy_php \*/);
    }
    const s = stripComments(code(SENDER));
    expect(s).toMatch(/variantPricePhp\(i\.price_jpy, ctx\.fx\)/);
    expect(s).toMatch(/attachDownPayments\(supabase, \[\{ product_variants: items/);
    expect(s).toMatch(/planLayawayQuote\(\{ price_jpy: sum, term_months: term, currency \}/);
    expect(s).toMatch(/rpc\("layaway_quote", plan\.args\)/);
    expect(s).toMatch(/if \(!plan\) form = "stage_a";/);
    expect(rules.percentFromFraction(0.3)).toBe(30);
    expect(rules.percentFromFraction(1)).toBeNull();
    expect(rules.yenWithPesos(68000, 27016)).toBe("¥68,000 (₱27,016)");
    expect(rules.yenWithPesos(68000, null)).toBe("¥68,000");
    expect(rules.planFiguresFromQuote({ eligible: true, term_downgraded: true, deposit: 1, monthly: 1, term_months: 3, total: 3 }, "JPY")).toBeNull();
  });

  it("the sender block and the links", () => {
    const t = code(TEMPLATE);
    expect(t).toMatch(/COMPANY_ADDRESS\[lang\]/);
    expect(t).toMatch(/STOREFRONT_REPLY_TO/);
    expect(t).toMatch(/href=\{p\.unsubscribeUrl\}/);
    const s = stripComments(code(SENDER));
    expect(s).toMatch(/\/cart\/restore/);
    expect(s).toMatch(/\/cart-reminders\/unsubscribe\?token=/);
    expect(s).toMatch(/sendStorefrontEmail\(/);
    const reg = code("supabase/functions/_shared/email-templates/preview-registry.ts");
    for (const k of ["storefront-cart-reminder-ja", "storefront-cart-reminder-en", "storefront-cart-reminder-en-layaway", "storefront-cart-reminder-ja-php"]) {
      expect(reg).toContain(`'${k}'`);
    }
  });
});

describe("the sweep and the website routes", () => {
  it("service role or system_health; purge → candidates → claim → send → finish; no retry", () => {
    const s = stripComments(code(SWEEP));
    expect(s).toMatch(/requireAuth\(req, \{ allowServiceRole: true \}\)/);
    expect(s).toMatch(/requirePermission\(ctx, "system_health"\)/);
    expect(s).toMatch(/rpc\("purge_stale_customer_carts"\)/);
    expect(s).toMatch(/rpc\("cart_reminder_candidates"/);
    expect(s).toMatch(/rpc\("claim_cart_reminder"/);
    expect(s).toMatch(/if \(!claimId\) \{/);
    expect(s).toMatch(/rpc\("finish_cart_reminder"/);
    // PR 10: the "we reserve and confirm" sentence is always on.
    expect(s).toMatch(/const reserveFirst = true;/);
    expect(s).not.toMatch(/web_reservation_mode/);
    expect(code("supabase/config.toml")).toMatch(/\[functions\.cart-reminder-sweep\]\s+verify_jwt = true/);
  });

  it("the cron job posts to it hourly at :31 with the Vault key", () => {
    const sql = code(MIGRATION);
    expect(sql).toMatch(/cron\.schedule\('cart-reminder-sweep', '31 \* \* \* \*'/);
    expect(sql).toMatch(/\/functions\/v1\/cart-reminder-sweep/);
    expect(sql).toMatch(/vault\.decrypted_secrets WHERE name = 'email_queue_service_role_key'/);
  });

  it("website: GET/PUT /me/cart, PUT /me/cart-reminders, GET /me carries cart_reminders, the unsubscribe link always answers the same", () => {
    const w = stripComments(code(WEBSITE));
    expect(w).toMatch(/req\.method === "GET" && segments\[0\] === "me" && segments\[1\] === "cart" && !segments\[2\]/);
    expect(w).toMatch(/req\.method === "PUT" && segments\[0\] === "me" && segments\[1\] === "cart" && !segments\[2\]/);
    expect(w).toMatch(/req\.method === "PUT" && segments\[0\] === "me" && segments\[1\] === "cart-reminders" && !segments\[2\]/);
    expect(w).toMatch(/rpc\("website_set_cart"/);
    expect(w).toMatch(/rpc\("set_cart_reminder_consent"/);
    expect(w).toMatch(/cart_reminders: \{ opted_in: \(cartConsent as AnyRec \| null\)\?\.opted_in === true \}/);
    const unsub = w.slice(w.indexOf('segments[0] === "cart-reminders" && segments[1] === "unsubscribe"'));
    expect(unsub).toMatch(/rpc\("withdraw_cart_reminder_by_token"/);
    expect(unsub).toMatch(/return jsonResponse\(\{ status: "unsubscribed" \}\);/);
    expect(unsub.slice(0, unsub.indexOf("return notFound()"))).not.toMatch(/suppressed_emails/);
  });

  it("every customer-scoped cart route needs the customer JWT (requireCustomerUser) after the API key", () => {
    const w = code(WEBSITE);
    for (const marker of ['segments[1] === "cart" && !segments[2]', 'segments[1] === "cart-reminders" && !segments[2]']) {
      let from = 0;
      let n = 0;
      while ((from = w.indexOf(marker, from)) !== -1) {
        const block = w.slice(from, from + 400);
        expect(block).toMatch(/requireCustomerUser\(req, supabase\)/);
        from += marker.length;
        n++;
      }
      expect(n).toBeGreaterThan(0);
    }
  });

  it("a provider unsubscribe withdraws our consent and rings a bell, from both webhooks", () => {
    expect(stripComments(code("supabase/functions/handle-email-suppression/index.ts"))).toMatch(/payload\.reason === 'unsubscribe'[\s\S]*withdrawCartRemindersForAddress\(/);
    expect(stripComments(code("supabase/functions/handle-email-events/index.ts"))).toMatch(/'email\.unsubscribed'[\s\S]*withdrawCartRemindersForAddress\(/);
    const h = stripComments(code("supabase/functions/_shared/cart-reminder-unsubscribe.ts"));
    expect(h).toMatch(/rpc\("withdraw_cart_reminder_by_email"/);
    expect(h).toMatch(/p_type: "cart_reminder_unsubscribed"/);
  });
});
