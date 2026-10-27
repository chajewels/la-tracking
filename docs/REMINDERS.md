# Reminders (Web Payment & Cart)

Moved verbatim from CLAUDE.md on 2026-10-28 (Option A split); CLAUDE.md keeps a one-line pointer and every money rule.

## WEB PAYMENT REMINDERS — NON-NEGOTIABLE (added 2026-10-04)

  Full text: docs/WEB-PAYMENT-REMINDERS.md.
  - ONE transactional reminder before a confirmed, unpaid WEB order's / web
    layaway's deadline (6h before a 24h one, 24h before a 72h one); max 2 per
    order; web only. It never reads consent / cart-reminder / suppression data.
  - SQL decides (web_payment_reminder_eligible, claim_ under a row lock);
    the edge function only sends via sendStorefrontEmail. Change the TS mirror
    (_shared/web-payment-reminder-rules.ts) with the SQL.
  - Switch web_payment_reminders_mode off|owner_only|on (fail-closed) +
    owner list: changed ONLY via set_web_payment_reminders (admin, audited);
    never in a migration or SQL.
  - Layaway emails are ENGLISH ONLY — subjects AND bodies, every layaway
    email (owner rule, 2026-09-27). Layaway templates have NO lang prop and no
    Japanese copy; never pass one or add one. Guarded by
    development/layaway-english.test.ts (CI). Exceptions: the registered
    company name in the footer and stored transfer-account details.

## CART REMINDERS (STAGES A/B) — NON-NEGOTIABLE (added 2026-10-01)

  Full text: docs/CART-REMINDERS.md. Migration 20261021100000_cart_reminders.sql.
  - PROMOTIONAL: opt-in only (consent kind 'cart_reminder', checkbox OFF by
    default), append-only consent events (never UPDATE/DELETE), full sender
    block in every email; ONE email per cart cycle, never within 7 days, never
    once an order exists.
  - SQL decides WHO and WHEN (cart_reminder_candidates / claim_cart_reminder);
    the sweep only renders and sends. Switch cart_reminders_mode off|owner_only|on
    (fail-closed; seeded off).
  - The opt-out link touches ONLY the consent row; a PROVIDER unsubscribe
    withdraws consent and rings bell cart_reminder_unsubscribed.
    Full text: docs/CART-REMINDERS.md "Rules moved from CLAUDE.md".
  - Stage D (payment reminders) reads NO cart-reminder data and never will.
