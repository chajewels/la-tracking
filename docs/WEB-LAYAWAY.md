<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## WEB LAYAWAY — NON-NEGOTIABLE (added 2026-09-14, Phase 2 step 4)

  A web layaway is a `layaway_accounts` row with `source_channel = 'web'` —
  the same table, the same schedule, the same payments, the same invariants as
  any Hub-created plan. There is no second account model. The web-only columns
  are `web_reference` (CJ-W-XXXXXX, what the customer and the emails say),
  `quote_id`, `customer_lang`, `fx_rate_used` / `fx_rate_date`, `expired_at`,
  and the two deadline fields below. Item lines live in
  `layaway_account_items`, the layaway sibling of `cash_order_items` — the
  same parallel-child-table pattern as `payments` / `cash_payments`.

  ONE WRITER: `create_web_layaway_atomic`. It consumes the checkout quote,
  recomputes the plan from `layaway_quote` rather than trusting the quote's
  stored figures, refuses `below_plan_minimum`, inserts the account, the
  schedule and the item lines, and decrements stock — one transaction. The
  `website` edge function never writes a layaway row itself.
  THE INVOICE NUMBER IS RESERVED AT QUOTE TIME (2026-09-18): a layaway
  `checkout_quotes` row draws `reserved_invoice_seq` from `web_order_number_seq`
  on insert (trigger `trg_checkout_quotes_reserve_invoice`), `POST /checkout/quote`
  returns it as `invoice_number` / `web_reference` so the agreement is signed
  against the plan's real number, and `create_web_layaway_atomic` carries that
  same number through to the account. Abandoned quotes leave sequence gaps by
  design.

  THE DEPOSIT DEADLINE IS A FIELD, NOT A COMPUTED RULE (owner decision
  2026-09-13). `transfer_due_at` is when the deposit must arrive. It is offered
  at creation (Hub and web alike) and moved afterwards through ONE control:
  `set_account_deadlines` behind the `set-account-deadlines` edge function,
  gated on `edit_account`, audited with old value, new value and reason. A
  REASON IS REQUIRED to change it (owner decision 2026-09-15): the edge
  function refuses an empty or absent one with 400 `reason_required` BEFORE
  calling the RPC, and the Hub keeps Save disabled until it is filled. Moving
  this deadline decides when a customer's piece is released, so an audit row
  with a null reason records that it happened and nothing about why. Creation
  is exempt — it sets a first deadline rather than changing one. On a
  cash order it writes `transfer_due_at` AND `expires_at` together, because
  the hourly cron reads `expires_at` and a customer must never be shown a
  deadline the cron does not act on. Web layaway default: 72 hours.
  There is no 24h/72h violation predicate, no forfeiture lookup and no
  automatic violator classification — those were replaced by this field.

  A DEADLINE IS MOVED, NEVER REMOVED (harness finding 3, 2026-09-15).
  `set_account_deadlines` and `set-account-deadlines` both refuse a null
  `transfer_due_at` with `deadline_required`. There is no "clear the deadline"
  act and none is to be built: the hourly sweep selects on `transfer_due_at IS
  NOT NULL`, so a cleared deadline is a web plan holding its stock forever with
  no expiry path and no error anywhere. A BACKDATED deadline stays legal — it is
  how staff release a hold deliberately — but the RPC returns
  `deadline_in_past: true` and the Hub warns, so a mistyped year is visible when
  it is made.

  WHAT HAPPENS AT A DEADLINE DEPENDS ON THE CHANNEL (harness finding 2,
  2026-09-15). auto-expire-cash-orders sweeps layaways with `source_channel =
  'web'` ONLY, yet Hub-created plans carry `transfer_due_at` too. On a Hub
  layaway the deadline is a staff reminder and nothing automatic happens; on a
  cash order the job cancels every pending order past `expires_at` but returns
  stock for web ones only. Any surface that states a consequence must state the
  one that applies to THAT order.
  THE DEADLINE IS SPENT ONCE THE DEPOSIT IS CONFIRMED (harness finding 1,
  2026-09-15). A layaway whose deposit has landed is still `active`, so a
  status-only gate let the date be moved: `ok`, a written column, and an audit
  row for a decision nothing would act on (the sweep never looks at a plan with
  `total_paid > 0` again). `set_account_deadlines` now refuses with
  `already_paid`, or `payment_exists` when the cache says zero and the ledger
  disagrees — the same two tests `expire_web_layaway_atomic` makes, in the same
  order, because INVARIANT 1 makes payments authoritative. The Hub withdraws the
  control and SAYS WHY rather than hiding it. LAYAWAY ONLY: a cash order's
  deadline is `expires_at` and the hourly job cancels a pending order with a
  balance whatever has been paid, so a partially-paid cash order's deadline is
  still live and still moveable.

  THERE IS ONE DEADLINE, NOT TWO (owner decision 2026-09-15). A second column,
  `settlement_due_at`, was added on 2026-09-14 and REMOVED on 2026-09-15: it
  was built to an answer nobody had asked the purpose of, nothing ever read it,
  and no account ever carried a value (0 of 1,449 at the drop). Do not
  re-add a settlement date to `layaway_accounts`, to `set_account_deadlines`,
  or to either creation form. The plan's own last schedule row is when the plan
  ends; `end_date` already records it. The related rule Cynthia described — an
  unpaid deposit NOT releasing the piece while a settlement date is still
  ahead — is NOT built; it is filed in docs/PENDING.md and needs a decision
  before any column comes back.

  EXTENSION IS A LATER DEADLINE, AND ONLY WHILE THE ORDER IS LIVE. Live means
  active / overdue / extension_active / reactivated for a layaway, pending for
  a cash order. An expired or cancelled order is NEVER revived: if the
  customer comes back the order is created fresh, so there is no stock
  re-hold path to get wrong. (The pre-existing cash-order revive button,
  Bug #217, survives for expired cash orders only and is the one exception,
  predating this rule. On a WEB cash order it is ONE RPC since 2026-09-23,
  #298: revive_web_cash_order_atomic via revive-web-cash-order, edit_account,
  reason required — re-takes the stock or refuses out_of_stock, resets
  payment_status to pending_transfer, and sets transfer_due_at = expires_at by
  web_deposit_deadline_hours. Never revive a web order with client-side writes.)

  A STAFF FORFEIT OF A WEB LAYAWAY RETURNS ITS STOCK (2026-09-23, #298).
  manual_forfeit_layaway_atomic flips the status, cancels the unpaid schedule,
  puts the pieces back on sale and stamps layaway_accounts.stock_released_at,
  in one transaction; the customer gets the storefront layaway-forfeited email.
  While stock_released_at is set the plan holds no stock, and
  trg_rehold_released_web_layaway_stock takes it back — or fails the status
  change with web_layaway_stock_unavailable — when the plan returns to a live
  status (the one-time reactivation). AUTOMATIC forfeits release too (#299,
  2026-09-23): trg_release_forfeited_web_layaway_stock returns a web plan's
  pieces in the same statement as ANY status change to forfeited /
  final_forfeited while stock_released_at is NULL, so auto-forfeit-settlement
  (LOCKED, untouched apart from its email) is covered, and the customer gets
  the same storefront layaway-forfeited email from both paths
  (_shared/layaway-forfeit-email.ts; `final` variant for final_forfeited).
  REACTIVATION IS ALL-OR-NOTHING: reactivate-account's un-cancel, account flip
  and Extension Month row are one transaction (reactivate_layaway_atomic); a
  sold piece refuses with out_of_stock naming it and nothing changes.

  EXPIRY: `expire_web_layaway_atomic`, swept hourly by
  auto-expire-cash-orders, releases a web layaway whose deposit never arrived
  — `source_channel='web'`, `total_paid = 0`, `expired_at IS NULL`,
  `transfer_due_at` past. It sets status `'cancelled'` and stamps
  `expired_at` (no new enum value), cancels pending schedule rows, returns the
  stock ONCE, writes an audit row, and emails the customer that nothing was
  paid and nothing is owed. It refuses on `already_paid`, `payment_exists`
  and `submission_pending` (INVARIANT 12). There is NO cancel-after-deposit:
  once a deposit is confirmed the plan is a normal layaway and follows the
  normal overdue / penalty / forfeiture path.

  THE WRITER'S REFUSAL RESTS ON `term_downgraded`, NOT ON `eligible` (harness
  observation C, 2026-09-15). `create_web_layaway_atomic` refuses on `NOT
  eligible OR term_downgraded`. While the 3M plan has no minimum, every basket
  clears some term, so `layaway_quote` always returns `eligible: true` and the
  first half never fires — a ¥500 basket asking for 12M comes back `eligible:
  true, term_months: 3, term_downgraded: true`. Never drop `term_downgraded` as
  redundant: without it every below-minimum basket silently writes itself a 3M
  plan. The `eligible` half is the backstop for the day 3M gets a minimum.

  TWO BASES, NEVER CONFLATED:
    deposit  = 30% of the TOTAL (product + shipping + services)
    loyalty  = the PRODUCT amount only, less any points redeemed
  `loyalty_jpy_amount` is therefore set from the quote's yen subtotal and is
  ALWAYS IN YEN, even on a peso plan — a peso total converted into the column
  would inflate the customer's tier progress. The settlement rate and its
  date are stored on the account for audit.

  CURRENCY is the customer's choice at checkout. Yen plans store yen. Peso
  plans convert at the stored `fx_rate`: shipping is converted and the
  subtotal is the remainder, so the parts always sum to the settlement total
  exactly. Web orders paid in full may settle in pesos too since 2026-09-25
  (docs/CASH-ORDERS.md "WEB ORDERS IN PESOS").

  DISPLAYED DOWN PAYMENTS COME FROM THE HUB (H-DP, 2026-09-25). The storefront
  shows no money figure it computed: catalog variants carry `down_payment_jpy`
  / `down_payment_php` / `down_payment_pct` (from `website_down_payments`,
  which calls `layaway_quote`), and the calculator asks `POST /layaway/quote`
  with `{ price_jpy, currency }` so the Hub converts. ONE formula, the
  checkout's: `price_php = HU(price_jpy × rate)`, then
  `layaway_quote(price_php, term, 'PHP').deposit`. For one piece at ₱0 shipping
  that is exactly what `create_web_layaway_atomic` stores (proven over 2,519
  cases in src/test/hub-down-payments.test.ts). The checkout's own peso
  layaway quote uses the same integer half-up (H3), so it cannot land ₱1 low
  on an exact .5. Peso term minimums are `min_amount_php`, never the yen
  minimum at a rate.

  Web layaway accounts are NEVER hard-deleted (`trg_prevent_web_layaway_delete`),
  the same rule cash web orders already carry.

