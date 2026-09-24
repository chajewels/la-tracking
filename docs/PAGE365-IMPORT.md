<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## PAGE365 IMPORT — NON-NEGOTIABLE (added 2026-09-19)

  A CSR pastes a public Page365 invoice link; the Hub fetches it, the CSR
  confirms, and the Hub creates a normal cash order or layaway plan. There is
  NO new write path — `create-cash-order` and `create-layaway-account` create
  the order exactly as they do for a hand-typed one, so plan minimums, the
  loyalty gate, permissions and the `is_test` prefix all still apply.

  `page365-fetch-order` NEVER WRITES AN ORDER. Link in, draft out, into
  `page365_drafts`. It refuses the whole import naming the field when anything
  is missing or the totals do not reconcile to the yen — a half-parsed draft is
  worse than none, because the CSR cannot see what is absent until the order is
  already wrong.

  THE `?sig=` IS A CAPABILITY, NOT AN IDENTIFIER. Anyone holding the full link
  can read that customer's name, phone and address. It is used for the single
  outbound fetch and dropped: never stored on the draft, never on the order,
  never logged, never returned. Only the slug and the invoice number survive.

  PAGE365 INVOICES ARE JPY (owner decision 2026-09-19) — item prices and
  shipping alike. The draft is yen throughout; the ACCOUNT currency is the
  CSR's choice at confirmation. A PHP plan converts at
  `system_settings.php_jpy_rate`, and the rate plus the moment it was read
  travel with the draft so the peso total can be reproduced later. NEVER use
  `src/lib/currency-converter.ts` `getConversionRate()` server-side or as the
  basis of a stored figure: it reads `localStorage` with a hardcoded 0.42
  fallback, so it is per-browser and not auditable.

  A RESIZE FEE IS A SERVICE, NOT A PRODUCT LINE. The parser flags it
  `kind: 'service'`. A service belongs in `account_services` (already inside
  `total_amount`) and must never reach `loyalty_jpy_amount`, which is the
  product amount alone — booking one as a product inflates the customer's tier
  progress with a fee paid for labour.

  ITEM NOTES ARE DISPLAYED, NEVER APPLIED. "Layaway (May) 8M / DP on 09/20 /
  Resize # 16" is free text a human wrote. The CSR reads it and sets the term;
  nothing parses it into fields. Page365 stock is not a stock source, and
  `origin` is never auto-set.

  PHOTOS ARE COPIED, NEVER HOTLINKED — `promotions/page365/<no>/<n>.<ext>`,
  into `{cash_order,layaway_account}_items.image_url`. An order outlives the
  external system it came from. A photo that cannot be copied is left null; a
  missing picture is cosmetic and is not worth refusing a sound import.

  A CONSUMED DRAFT IS A COURTESY, NOT THE GUARD. `consume_page365_draft` (a
  SECURITY DEFINER RPC — `page365_drafts` deliberately has no UPDATE policy)
  stamps `consumed_at` after a successful import, and the review screen treats
  a failure as non-fatal because the order already exists. What actually stops
  a double import is `uq_{cash_orders,layaway_accounts}_page365_no` plus the
  409 `already_imported` both create functions return.

  ONE HUB ORDER PER PAGE365 INVOICE, and one invoice_number across BOTH order
  tables — see `public.invoice_numbers` in docs/SCHEMA-FACTS.md. The registry
  triggers are named `trg_zz_*` so they fire AFTER `enforce_test_invoice_prefix`
  and record the final, possibly `TEST-` prefixed, value; never rename them to
  something that sorts earlier.

  DISCOUNTS: `price_total` IS ALREADY NET (added 2026-09-23). Page365 discounts
  the INVOICE, not the lines. `price_subtotal` and every item `subtotal` stay at
  full price, and `price_total` = subtotal + shipping − `price_discount` −
  `campaign_discount`. Both fields are read, both are subtracted, and the
  reconcile is that identity to the yen; a negative in either is refused by name.
  Summing the two is deliberate — if Page365 ever reported ONE discount in BOTH,
  the total stops reconciling and the import is refused, which beats silently
  halving a customer's total. Reading neither is what refused EVERY discounted
  invoice with a 422 until this landed.
  The draft carries `discount_jpy`, `discount_breakdown` and, for display only,
  `promotion_code` and `discount_campaign_name` — a promo code is never written
  to the order. The review screen PRE-FILLS the Discount field from
  `discount_jpy` and marks it "From Page365" until the CSR types over it.
  LOYALTY BASIS = PRODUCT LINES − DISCOUNT, in yen (owner rule 2026-09-23:
  "loyalty excludes the discount and the shipping fee"). The whole discount
  comes off the product amount; services and shipping were already outside it.
  Points must never be earned on money the customer did not spend. While the
  discount is still Page365's own the basis uses the draft's exact yen figure
  rather than converting the peso input back, so the basis cannot drift when the
  CSR toggles the currency.

  THE UI IS THE ONLY WAY IN, AND IT NEVER AUTO-DECIDES. Sales → the split
  button's "From Page365" opens a paste box; a successful fetch navigates to
  `/page365/review/:draftId`, where every parsed field is editable before
  anything is created. The customer is SUGGESTED, never auto-selected — matches
  are listed with the basis shown (name / phone / name + phone) because live
  phone data is only 80 clean E.164 of 891, with 10 colliding digit-groups.
  Item notes are displayed beside their line and never parsed. A RESIZE FEE
  arrives flagged `kind: 'service'` and the CSR can move any line between
  product and service; the loyalty basis sent to the creating function is the
  PRODUCT total in yen, LESS the discount (see DISCOUNTS below) — services and
  shipping are never in it.
  Currency is the CSR's choice at review: JPY default, and PHP converts the
  total, shipping and discount with the rate the DRAFT carries (`payload.fx`,
  `system_settings.php_jpy_rate`) — shown once on screen with its source and
  read time. Line items stay in yen whatever the account currency.
  THE ROUTE IS PERMISSIONED ON EITHER CREATE KEY. `/page365/` in
  PermissionsContext resolves to `create_cash_order OR create_account`, because
  the screen can produce either and gating on one would lock out a user who
  holds the other; the cash/layaway toggle then offers only the type they can
  actually create. An unmapped path there returns false for everyone but admin
  — the documented new-feature lockout.

  LINE ITEMS ARE WRITTEN INSIDE THE CREATING FUNCTION (`_shared/order-extras.ts`),
  not by the browser afterwards. The old post-RPC writes in NewAccount.tsx and
  NewCashOrder.tsx swallowed their own failure into a `toast.warning` on an
  order the CSR had just been told was created successfully. On an import
  nobody typed the lines, so nobody would know what was lost. A failure now
  rolls the order back. Every extra field is optional and a caller that sends
  none behaves exactly as before.

