# Website Payment Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every website order screen and email describes the customer's real payment method and state, every payment transition that matters reaches her, and after a reject she can pay another way.

**Architecture:** The Hub (Supabase edge functions plus one migration) gains:
- per-language email subjects;
- method-aware copy;
- two generic "update" templates, one for orders and one for layaway;
- new API fields: `latest_decision`, list-row state, draft `total_after_points`;
- a customer method-switch endpoint backed by one atomic RPC;
- a `notify-shipped` function.

The storefront reads those fields through one pure display helper and renders:
- the notice;
- the switch;
- the after-points totals.

Every new field is optional on the storefront, so the release order cannot break the live site.

**Tech Stack:**
- Hub: Deno edge functions, React Email (`renderEmail` only), Postgres plpgsql, Deno tests in `development/`.
- Storefront: Next.js 15, TypeScript, `node --test` on `.mjs` with type-stripping.

**Spec:** `docs/superpowers/specs/2026-10-05-payment-lifecycle-design.md`. The owner approved it on 2026-10-05 15:28 JST. Read it with this plan.

## Global Constraints

- **Branches:**
  - Hub work goes on `feat/payment-lifecycle`, cut from `develop`. It becomes one PR into `develop`, then the `develop` → `main` release.
  - Storefront work goes on `feat/payment-lifecycle`, also cut from `develop`. It becomes one PR, merged **after** the Hub deploy.
- **Generated and frozen files:**
  - Never hand-edit `src/integrations/supabase/types.ts`; cast at the call site instead.
  - Never touch `package.json` or lock files.
- **Database functions:**
  - Function bodies start from the live body (`pg_get_functiondef`).
  - Patches are md5-guarded and use the existing `pg_temp.cj_patch` pattern.
  - After any CREATE FUNCTION, re-assert REVOKE/GRANT.
  - `scripts/function-drift-audit` must report 0/0/0.
- **Email:**
  - Render only with `renderEmail`.
  - Layaway emails are **English only** with no `lang` prop (guard: `development/layaway-english.test.ts`).
- **Japanese storefront:**
  - Nothing about layaway is visible on `ja` (guard: `check:layaway-ja`).
  - Every new i18n key has both `ja` and `en`.
- **Money:** the storefront computes no money (guard: `check:money`). `total_after_points` and `amount_due` come from the Hub.
- **Fixed rules:**
  - `payment_status = 'pending_transfer'` keeps its name and meaning.
  - C1 stays: a customer switch is allowed **only** after a rejected submission and with no lock.
  - INVARIANT 12 is unchanged; `needs_clarification` does not freeze automation.
- **Exact copy** (from the spec, verbatim):
  - Paidy/card heading 「お支払い待ち」 / "Awaiting payment"
  - step 3: transfer 「お支払い案内・お振込」, Paidy 「お支払い（ペイディ）」, card 「お支払い（カード）」
  - draft row label 「お支払い予定額」
  - switch link 「ほかのお支払い方法に変更する」 / "Pay another way"
  - email button JA 「ご注文ページを見る」
  - in-window Paidy refusal line 「ほかの方法でのお支払いをご希望の場合は、ご連絡ください」
- **Subjects:** `ja` → Japanese + " / " + English; `en` → English only.
- **Missing language** → delivery country: JP gets Japanese, anything else English.
- **Typecheck:**
  - Hub: `npx tsc -p tsconfig.app.json --noEmit`.
  - Storefront: `npm run typecheck`.

## Review Focus

1. **The storefront talks to the old Hub.** Before the Hub deploy, `latest_decision`, `total_after_points`, `chosen_method` on list rows and the switch endpoint are all absent. Every page must render as today, with no crash and no notice. Tests: S1 (`orderDisplay` with no fields), S2 (fixture without fields).
2. **A rejection older than a later confirmed payment** (a partial payment was rejected, then a transfer was confirmed) must show **no** notice. Test: H7 `latestDecision` "confirmed after rejected → null".
3. **Needs-clarification must not reopen payment.** The page shows the notice and **no** pay buttons; the switch is not offered. Tests: S1 (`payBlocked: true`), H7 (switch refuses `not_rejected`).
4. **An English customer gets only English.** That covers the subject and the body of every order email and every new update email. A missing `customer_lang` with a PH address also gets English. Test: H2.
5. **Points pay the whole order at Confirm.** She gets "paid in full", no "please pay ¥0" email and no payment reminder. Tests: H6 (confirm-web-draft path picks payment-received), H1 (reminder SQL excludes `remaining_balance = 0`; it already does, so assert it stays).

---

# Part A — Hub (`/home/claude/la-tracking`)

### Task H1: Migration — customer message, customer switch RPC, method-aware reminder

**Files:**
- Create: `supabase/migrations/20261111100000_payment_lifecycle.sql`
- Create: `supabase/functions/_shared/method-switch-rules.ts`
- Test: `development/method-switch-rules.test.ts`

**Interfaces:**
- Produces (SQL):
  - Column `payment_submissions.customer_message text NULL`. Its comment says it is the reviewer text shown to the customer, written only on a staff reject or needs-clarification.
  - `public.switch_web_payment_method_by_customer_atomic(p_order_id uuid, p_customer_id uuid, p_method text) RETURNS jsonb`
    - SECURITY DEFINER; execute granted to service_role only.
    - Returns `{ok:true, old_method, payment_method, reference}` or `{error}`.
    - Error codes: `not_found`, `not_web_order`, `not_payable`, `payment_in_progress`, `not_rejected`, `unchanged`, `bad_method`, `method_requires_yen`.
    - Writes `cash_orders.payment_method` and one `audit_logs` row: action `payment_method_changed`, `new_value_json.actor = 'customer'`, `performed_by_user_id` NULL.
  - `web_payment_reminder_eligible`: add a column `payment_method text` to the RETURNS TABLE. Return the stored `payment_method` for cash orders and `'transfer'` for layaways. This is a DROP + CREATE with the same body and the new column; re-assert grants.
- Produces (TS):
  - `canCustomerSwitch(input: { status: string; paymentStatus: string|null; sourceChannel: string|null; lock: string|null; latestDecision: 'rejected'|'needs_clarification'|null; currency: string; from: string; to: 'transfer'|'paidy'|'square' }): { ok: true } | { ok: false; error: string }`.
  - It mirrors the SQL refusal order exactly: `not_web_order`, `not_payable`, `payment_in_progress`, `not_rejected`, `bad_method`, `unchanged`, `method_requires_yen`.

- [ ] **Step 1: Write the failing test** `development/method-switch-rules.test.ts`. Cases (each asserts the `error` string or `ok`):
  - rejected Paidy → transfer: ok
  - `latestDecision: null` → `not_rejected`
  - `'needs_clarification'` → `not_rejected`
  - `lock: 'paidy_authorized'` → `payment_in_progress`
  - `status: 'completed'` → `not_payable`
  - `sourceChannel: 'hub'` → `not_web_order`
  - PHP to `'square'` → `method_requires_yen`
  - same method → `unchanged`
  - `to: 'bitcoin'` → `bad_method`
- [ ] **Step 2: Run** `deno test --config development/deno.ci.json --allow-read --allow-env development/method-switch-rules.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `canCustomerSwitch` in `_shared/method-switch-rules.ts`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Write the migration.**
  - Before writing, read the live bodies through Lovable `query_database` with `SET LOCAL lock_timeout='3s'` and `pg_get_functiondef` for `web_payment_reminder_eligible`. Build the new version from that live body. Record its md5 in a comment and STOP if live has moved.
  - **Switch RPC:**
    - Locks the order `FOR UPDATE`.
    - Checks `customer_id = p_customer_id`.
    - Uses `public.cash_order_payment_lock(p_order_id)`.
    - The "latest decision" is the newest `payment_submissions` row for the order whose status is in `('rejected','needs_clarification','confirmed')`. Only `'rejected'` passes.
    - Yen rule: `currency <> 'JPY'` refuses `'paidy'` and `'square'`.
  - The `customer_message` column is nullable with no default.
- [ ] **Step 6: Run the drift audit:** `bash scripts/function-drift-audit`. Expected: `a_differs 0, b_live_only 0, c_repo_only 0`. The new function is not live yet and is listed as pending in the audit's allow-list, as done for earlier migrations.
- [ ] **Step 7: Commit:** `git add supabase/migrations/20261111100000_payment_lifecycle.sql supabase/functions/_shared/method-switch-rules.ts development/method-switch-rules.test.ts && git commit -m "feat(db): customer message, customer method switch, method-aware reminder rows"`

### Task H2: Email language and subjects per language

**Files:**
- Modify: `supabase/functions/_shared/storefront-email.ts:44-46`
- Modify: `supabase/functions/_shared/email-templates/order-shared.tsx`, the `WORDS.viewOrder` entry
- Modify the subject functions in these templates: `order-confirmation.tsx`, `order-reserved.tsx`, `order-payment-received.tsx`, `order-payment-due.tsx`, `order-expired.tsx`, `order-payment-not-accepted.tsx`, `order-cancelled.tsx`, `order-reservation-lapsed.tsx`
- Modify: every caller of those subject functions (`grep -rn "Subject(" supabase/functions --include=*.ts`)
- Test: `development/email-language.test.ts`

**Interfaces:**
- Produces:
  - `emailLang(customerLang: unknown, country: string | null | undefined): Lang` in `storefront-email.ts`. Rule: `'en'` → en; `'ja'` → ja; anything else → `country === 'JP' ? 'ja' : 'en'`.
  - `pickLang` stays, as an alias for old callers: `pickLang(v) = emailLang(v, 'JP')`.
  - `subjectFor(lang: Lang, ja: string, en: string): string` in `order-shared.tsx`, returning `lang === 'ja' ? \`${ja} / ${en}\` : en`.
  - Every order subject function becomes `xSubject(reference: string, lang: Lang)`.
  - `WORDS.viewOrder.ja = 'ご注文ページを見る'`.
- Consumes: the country comes from `ship_to_snapshot->>'country'` (orders) or the draft's `ship_to_snapshot`. Each sender that calls `pickLang(order.customer_lang)` switches to `emailLang(order.customer_lang, snapshotCountry(order))`. Add `snapshotCountry(row: {ship_to_snapshot?: unknown}): string|null` to `storefront-email.ts`.

- [ ] **Step 1: Write the failing test** `development/email-language.test.ts`:
  - `emailLang('en','JP')==='en'`
  - `emailLang(null,'PH')==='en'`
  - `emailLang(null,'JP')==='ja'`
  - `emailLang(undefined,null)==='en'`
  - `orderPaymentNotAcceptedSubject('CJ-W-1','en')` contains no Japanese characters (`/[぀-ヿ一-龯]/`)
  - the `'ja'` subject contains both 「お支払いを確認できませんでした」 and "We could not accept your payment"
  - the same EN-has-no-CJK check runs for **every** order subject function listed above (loop)
  - rendered `OrderPaymentNotAcceptedEmail` with `lang:'ja'` contains 「ご注文ページを見る」
- [ ] **Step 2: Run** `deno test … development/email-language.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `emailLang`, `snapshotCountry`, `subjectFor`, the subject signatures and the `WORDS` change. Update every caller. Each loader's select must include `ship_to_snapshot`; add it where missing (`reservation-emails.ts` `loadOrder`/`loadDraft`, `payment-rejected-email.ts`, review-payment-submission `cashOrder` select at :461, auto-expire-cash-orders, cancel-cash-order).
- [ ] **Step 4: Run** the new test plus `development/payment-rejected-email.test.ts` (whose subject call needs the new `lang` arg). Expected: PASS. Then `deno check supabase/functions/*/index.ts`. Expected: no errors.
- [ ] **Step 5: Commit:** `git commit -am "feat(email): subject and fallback language follow the customer"`

### Task H3: Method-aware copy in the existing order emails

**Files:**
- Modify: `email-templates/order-payment-received.tsx`, `order-payment-due.tsx`, `order-expired.tsx`, `order-reserved.tsx`, `order-confirmation.tsx`, `order-payment-not-accepted.tsx`
- Modify: `_shared/payment-reminder-emails.ts:30-…`, `_shared/reservation-emails.ts` (`loadDraft`, `sendDraftReservedEmail`, `sendOrderReadyEmail`)
- Modify: `review-payment-submission/index.ts:1001-1016`
- Test: `development/payment-method-copy.test.ts`

**Interfaces:**
- Produces (new props):
  - `OrderPaymentReceivedProps`: adds `method: 'transfer'|'paidy'|'card'`, `pointsApplied?: number`, `remaining?: number|null`. When `remaining > 0`, a "still to pay ¥X by {deadline}" line is shown and the intro says 「一部を受領」. This is the **partial** variant. It needs `transferDueAt?: string|null` and `region?`.
  - `OrderPaymentDueProps`: adds `method`. When `method !== 'transfer'`, `methods` must be `[]` and the body says "pay with Paidy / card from your order page".
  - `OrderReservedProps`: adds `method`.
  - `OrderConfirmationProps`: adds `methodChanged?: { from: 'transfer'|'paidy'|'card' }`. When present, the heading is 「お支払い方法を変更しました」 / "Your payment method has changed", with a from → to line.
  - `order-expired.tsx` copy becomes method-neutral, e.g. JA intro 「お支払い期限（${when}）までにお支払いの確認ができなかったため…」 and "If you have already paid, reply…".
  - In `order-payment-not-accepted.tsx`, `COPY.*.transfer` changes to "reply to this email with your transfer receipt" (JA 「お振込の控えをこのメールにご返信ください」). It must contain no 「アップロード」 or "upload".
- Consumes: `emailLang` and the `xSubject(ref, lang)` signatures from H2. `web_payment_reminder_eligible.payment_method` from H1 is copied into `web_payment_reminders` by the claim function. If the claim table has no column for it, `sendClaimedPaymentReminder` reads `cash_orders.payment_method` itself, which is preferred because it needs no extra column.

- [ ] **Step 1: Write the failing test** `development/payment-method-copy.test.ts`. For each template × `method in ['paidy','card']` × `lang in ['ja','en']`:
  - the rendered plain text contains none of 「振込」, "transfer", "bank" (case-insensitive);
  - for `method:'transfer'` it **does** contain 「振込」 (ja) / "transfer" (en);
  - partial: `remaining: 500` renders 「¥500」 and "still to pay";
  - payment-due with `method:'paidy'` and `methods:[]` renders no account number field label;
  - not-accepted transfer: no "upload" / 「アップロード」.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** the template props and copy. Then wire the callers:
  - review-payment-submission passes `method: notAcceptedMethod(submission.payment_method)` (reuse the export from `payment-rejected-email.ts`) and `pointsApplied` from RPC `cash_order_points_paid`.
  - **Partial branch at :1017:** replace the `skipped_partial_payment` log with the same send, `remaining = Number(cashOrder.remaining_balance)`, idempotency key `order-payment-received-${cashPayment.id}`.
  - reminder: `method` from `cash_orders.payment_method` via `publicMethod`; `methods = method === 'transfer' ? await transferMethods(...) : []`.
  - `loadDraft` selects `payment_method`; `sendDraftReservedEmail` passes `method: publicMethod(d.payment_method)`.
  - `sendOrderReadyEmail({methodChanged:true})` reads the previous method from the newest `audit_logs` row (`entity_id = orderId`, action `payment_method_changed`, `old_value_json->>'payment_method'`) and passes `methodChanged: { from }`.
- [ ] **Step 4: Run** the test, plus `development/payment-rejected-email.test.ts` and `development/layaway-english.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat(email): every order email names the method she is actually paying with"`

### Task H4: Generic update emails (order and web layaway)

**Files:**
- Create: `supabase/functions/_shared/email-templates/order-update.tsx`
- Create: `supabase/functions/_shared/email-templates/layaway-update.tsx` (English only, no `lang` prop)
- Create: `supabase/functions/_shared/order-update-email.ts`
- Modify: `email-templates/preview-registry.ts`, adding one entry per variant
- Test: `development/order-update-email.test.ts`

**Interfaces:**
- Produces:
  - `type OrderUpdateVariant = 'needs_info' | 'deadline_moved' | 'shipped' | 'details_received'`
  - `OrderUpdateEmail(props: { lang: Lang; variant: OrderUpdateVariant; reference: string; currency: OrderCurrency; amount?: number|null; message?: string|null; deadline?: string|null; region: 'JP'|'OVERSEAS'; courier?: string|null; trackingNumber?: string|null; trackingUrl?: string|null; orderUrl: string|null })` and `orderUpdateSubject(variant, reference, lang)`.
  - Required copy by variant, ja + en (exact, from spec §5 B / D2):
    - needs_info: 「お支払いについて確認させてください」
    - deadline_moved: 「お支払い期限を {新期限} に変更しました」
    - shipped: 「発送しました」 + courier + tracking
    - details_received: 「お支払いのご連絡を受け付けました。確認後にあらためてご連絡します」
  - `LayawayUpdateEmail(props: { variant: 'rejected'|'needs_info'|'deadline_moved'|'shipped'; reference: string; currency; amount?; message?; deadline?; courier?; trackingNumber?; trackingUrl?; planUrl: string })` and `layawayUpdateSubject(variant, reference)`.
  - `sendOrderUpdateEmail(db: Db, args: { entity: 'cash_order'|'layaway'; id: string; variant: OrderUpdateVariant | 'rejected'; message?: string|null; amount?: number|null; idempotencyKey: string }): Promise<void>`
    - Never throws.
    - **Sends only when `source_channel = 'web'`.** Otherwise it returns without sending; the caller keeps its existing Hub email.
    - It loads the row, the customer (email, is_test), `customer_lang`, `ship_to_snapshot`, `transfer_due_at`, `tracking_number` and `shipping_methods(provider_name, title, tracking_url_template)`.
    - The tracking URL is `tracking_url_template` with `{tracking}` replaced, or null.
  - `isWebEntity(row: {source_channel?: unknown}): boolean`
- Consumes: `emailLang`, `snapshotCountry`, `subjectFor` (H2); `storefrontOrderUrl` / `storefrontLayawayUrl`; `sendStorefrontEmail`; `formatDeadline`.

- [ ] **Step 1: Write the failing test.**
  - Render every order variant in ja and en. ja contains the exact JA string above. **en contains no CJK characters**.
  - `needs_info` shows `message`. `shipped` shows the tracking number and the URL.
  - Every layaway variant renders English only (no CJK).
  - `isWebEntity({source_channel:'hub'}) === false`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the two templates (reuse `order-shared` `Panel`/`Row`/`WORDS`; `layaway-shared` for layaway) and `order-update-email.ts`.
- [ ] **Step 4: Run** the test and `development/layaway-english.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat(email): order and web-layaway update emails"`

### Task H5: Wire the senders

**Files:**
- Modify: `review-payment-submission/index.ts`:
  - the status write at :1545-1567;
  - the email block at :1757-1856;
  - the provider-ended branches at :590 and :753, which keep `customer_message` null.
- Modify: `submit-cash-payment/index.ts:302-338`
- Modify: `set-account-deadlines/index.ts`, after the successful RPC
- Modify: `confirm-web-draft/index.ts:207-209`
- Test: `development/web-order-senders.test.ts`, covering pure routing helpers only

**Interfaces:**
- Consumes: `sendOrderUpdateEmail`, `isWebEntity` (H4); `sendCashPaymentRejectedEmail` (existing); `sendOrderReadyEmail` (H3).
- Produces: `routeSubmissionEmail(input: { action: 'confirmed'|'rejected'|'needs_clarification'; isCashOrder: boolean; isWeb: boolean }): 'cash_rejected' | 'order_needs_info' | 'layaway_update' | 'hub_template' | 'none'`. It lives in `_shared/order-update-email.ts` so the decision is testable.

- [ ] **Step 1: Write the failing test** for `routeSubmissionEmail`:
  - cash + rejected → `cash_rejected`
  - cash web + needs_clarification → `order_needs_info`
  - cash non-web + needs_clarification → `none`
  - layaway web + rejected → `layaway_update`
  - layaway web + needs_clarification → `layaway_update`
  - layaway non-web + rejected → `hub_template`
  - confirmed → `none` (confirmed has its own existing path)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
  - **review-payment-submission:**
    - Add `customer_message: (action === 'rejected' || action === 'needs_clarification') ? (reviewer_notes || null) : undefined` to `updateData`.
    - Branch on `routeSubmissionEmail`.
    - Web layaway rejected / needs_clarification sends `sendOrderUpdateEmail({entity:'layaway', variant, message: reviewer_notes, idempotencyKey: \`${variant}-${submission_id}\`})` **instead of** the Hub template.
  - **submit-cash-payment:**
    - If `cashOrder.source_channel === 'web'`, call `sendOrderUpdateEmail({entity:'cash_order', id, variant:'details_received', amount: submittedNum, idempotencyKey: \`details-received-${submission.id}\`})`.
    - Else keep the Hub email. Add `source_channel` to its select if absent; it is already present at :140.
  - **set-account-deadlines:** on success, call `sendOrderUpdateEmail({entity, id, variant:'deadline_moved', idempotencyKey: \`deadline-moved-${id}-${transfer_due_at}\`})`. Map `entity_type 'layaway'` to `'layaway'`.
  - **confirm-web-draft:** after materialize, re-read the order. If `status === 'completed'` (points paid all), send `OrderPaymentReceivedEmail` with `method`, `pointsApplied` and `amountReceivedJpy: 0`, label `order-payment-received`, key `order-paid-by-points-${orderId}`. Else keep `sendOrderReadyEmail`.
- [ ] **Step 4: Run** the test and `deno check` on the four functions. Expected: PASS, no type errors.
- [ ] **Step 5: Commit:** `git commit -am "feat: web customers hear about needs-info, partial, deadline moves, staff-recorded payments"`

### Task H6: Website API — latest decision, list state, after-points, customer switch

**Files:**
- Create: `supabase/functions/_shared/latest-decision.ts`
- Modify: `supabase/functions/website/index.ts`:
  - GET /orders/:id (2663-2772)
  - GET /orders (2611-2661)
  - `shapeDraft` (374-404)
  - GET /layaway/:id (3180-3273)
  - a new route `POST /orders/:id/payment-method`, placed next to the paidy routes (~2774)
- Modify: `supabase/contracts/api.md` in the storefront repo, done in S2. The Hub's `docs/WEBSITE-VERCEL.md` notes the new fields.
- Test: `development/latest-decision.test.ts`

**Interfaces:**
- Produces:
  - `type LatestDecision = { status: 'rejected'|'needs_clarification'; method: 'transfer'|'paidy'|'card'; amount: number; decided_at: string; message: string|null }`
  - `latestDecision(rows: Array<{ status: string; payment_method: string|null; submitted_amount: number; updated_at: string; customer_message: string|null }>): LatestDecision | null`
    - Takes the newest row by `updated_at` among statuses `rejected`, `needs_clarification`, `confirmed`.
    - Returns null if that newest row is `confirmed` or there are none.
    - `method` goes through `publicMethod`.
  - Order detail adds `latest_decision: LatestDecision|null` and `can_switch_method: boolean`. The latter is `canCustomerSwitch(...)` (H1) is ok for at least one other allowed method, combined with whether Paidy/card are currently offered.
  - Order detail also adds `switch_methods: Array<'transfer'|'paidy'|'card'>` (the targets offered).
  - Layaway detail adds `latest_decision`.
  - List rows add:
    - `chosen_method: 'transfer'|'paidy'|'card'|null` (null when not a web order);
    - `being_checked: boolean` (an open submission or a lock);
    - `amount_due: number`, which is `remaining_balance`. That figure already nets points because the points payment is a real payment row; assert this on the live test order in the verification task.
  - `shapeDraft` adds `total_after_points: number`, defined as `max(0, total − points_value)`. On a layaway draft it equals `total`, because points apply to the deposit and the deposit row already shows that.
  - `POST /orders/:id/payment-method`:
    - Body `{ method: 'transfer'|'paidy'|'card' }`, mapped to stored `'square'` for card via `storedMethod`.
    - Calls the RPC from H1 with `customer.id`.
    - On `ok`, calls `sendOrderReadyEmail(supabase, id, { methodChanged: true })` and returns `{ ok: true, payment_method }`.
    - Errors return the RPC code: 409 for `payment_in_progress`, `not_rejected`, `not_payable`, `unchanged`; 400 for `bad_method`, `method_requires_yen`; 404 for `not_found`.
    - It **also** checks that a Paidy target is currently offered (`paidyOffer(...).offered`) and a card target is offered (`cardOffer(...)`). Otherwise it returns 409 `method_not_offered`.

- [ ] **Step 1: Write the failing test** for `latestDecision`:
  - `[]` → null
  - one rejected → object with the message
  - rejected then a later confirmed → null
  - needs_clarification newest → status `needs_clarification`
  - square → method `card`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `latest-decision.ts` and the five website changes. Add `updated_at, customer_message` to the submission selects used to feed it. Use a separate query for decided rows, so `pending_submissions` stays exactly as today.
- [ ] **Step 4: Run** the test and `deno check supabase/functions/website/index.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat(website): latest payment decision, list state, after-points totals, customer method switch"`

### Task H7: Shipped email

**Files:**
- Create: `supabase/functions/notify-shipped/index.ts`
- Modify: `supabase/config.toml`, adding `[functions.notify-shipped]` with `verify_jwt = true`, placed next to `change-payment-method`
- Modify: `src/components/shipping/ShipmentTrackingCard.tsx`, the `handleMarkShipped` success path only
- Test: `development/notify-shipped.test.ts`, covering the pure key helper

**Interfaces:**
- Produces:
  - Edge function `notify-shipped`:
    - POST `{ kind: 'layaway'|'cash_order', record_id: string }`.
    - Uses `requireAuth` and `requirePermission(ctx, 'edit_account')`, the same pattern as set-account-deadlines.
    - Re-reads the row and requires `shipped_at IS NOT NULL` and `tracking_number IS NOT NULL`; otherwise 409 `not_shipped`.
    - Calls `sendOrderUpdateEmail({entity, id, variant:'shipped', idempotencyKey: shippedKey(kind, id, shipped_at)})`.
    - Returns `{ ok: true }`.
  - `shippedKey(kind: string, id: string, shippedAt: string): string`, returning `` `shipped-${kind}-${id}-${shippedAt}` ``.
- Consumes: `sendOrderUpdateEmail` (H4). In the Hub UI it uses `supabase.functions.invoke('notify-shipped', { body: { kind, record_id: recordId } })`. This is fire-and-forget: errors are logged, the save is never blocked, and no toast appears on failure.

- [ ] **Step 1: Write the failing test.** `shippedKey('cash_order','a','2026-10-05')` equals `'shipped-cash_order-a-2026-10-05'`, and the key is stable.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the function, the config entry and the one-line invoke after a successful mark-shipped (not after undo).
- [ ] **Step 4: Run** the test, `deno check supabase/functions/notify-shipped/index.ts` and `npx tsc -p tsconfig.app.json --noEmit`. Expected: PASS, 0 errors.
- [ ] **Step 5: Commit:** `git commit -am "feat: email web customers when their order is marked shipped"`

### Task H8: Docs, CI, PR

**Files:**
- Modify: `.github/workflows/firebase-deploy.yml:297`. Append the seven new test files: `method-switch-rules`, `email-language`, `payment-method-copy`, `order-update-email`, `web-order-senders`, `latest-decision`, `notify-shipped`.
- Modify: `docs/CHECKOUT-CHOICE.md`. Add a section "Payment lifecycle (2026-10-05)" covering: the customer switch rule, `latest_decision`, the email list, and the language rule.
- Modify: `docs/OPEN-BUGS.md`. Add an entry: "auto-forfeit-settlement PATH 3 sends 'permanently forfeited' email — LOCKED function, owner decision pending".
- Modify: `CLAUDE.md`, one line under CHECKOUT CHOICE: "C1 exception: after a REJECTED submission the customer may switch method herself (switch_web_payment_method_by_customer_atomic), never while locked." It must stay under 100k characters.

- [ ] **Step 1: Run** all Deno tests with the exact CI line. Then run `deno lint --config development/deno.ci.json supabase/functions`, `npx tsc -p tsconfig.app.json --noEmit` and `bash scripts/function-drift-audit`. Expected: all green, drift 0/0/0.
- [ ] **Step 2: Commit** the docs and CI change. Push `feat/payment-lifecycle`.
- [ ] **Step 3: Open the PR into `develop`** with the attribution footer. Give the owner the exact `gh pr merge` command.

---

# Part B — Storefront (`/home/claude/cha-jewels-web`)

### Task S1: One pure display helper

**Files:**
- Create: `lib/order-display.ts`
- Modify: `components/account/order-progress.tsx`. `orderStage` moves to `lib/order-display.ts` and is re-exported for old imports. The labels array takes `stage3Key`.
- Test: `tests/order-display.test.mjs`

**Interfaces:**
- Produces:
  - `type DisplayMethod = 'transfer'|'paidy'|'card'`
  - `orderStage(o: HubOrder, beingChecked?: boolean): 1|2|3|4|5|null`. Same as today, except that `beingChecked` and stage 3 give **4**.
  - `orderDisplay(input: { order: HubOrder; chosenMethod?: DisplayMethod|null; beingChecked: boolean; latestDecision?: HubLatestDecision|null }): { headlineKey: 'pending'|'statusPendingTransfer'|'statusPendingPayment'|null; stage: 1|2|3|4|5|null; stage3Key: 'stagePayment'|'stagePaymentPaidy'|'stagePaymentCard'; notice: 'rejected'|'needs_info'|null; payBlocked: boolean }`
    - `headlineKey`: null means "use `orderStatusLabel`".
    - `payBlocked` is true when `latestDecision?.status === 'needs_clarification'`.
  - `orderStatusLabel(order, lang, chosenMethod?)` gains a third optional arg. With Paidy or card it returns `statusPendingPayment` where it returned `statusPendingTransfer`.
- Consumes: `HubLatestDecision` (S2 type). Write S2's type addition first, in the same commit.

- [ ] **Step 1: Write the failing test** `tests/order-display.test.mjs`:
  - transfer pending → stage3Key `stagePayment`, headline null/transfer;
  - Paidy pending → stage3Key `stagePaymentPaidy`, `orderStatusLabel(...,'paidy').text === 'お支払い待ち'` for ja;
  - card → `stagePaymentCard`;
  - beingChecked → stage 4 and headline `pending`;
  - latestDecision rejected → notice `rejected`, `payBlocked` false;
  - needs_clarification → notice `needs_info`, `payBlocked` true;
  - **no `chosenMethod` and no `latestDecision` (old Hub)** → same output as today for transfer, notice null.
- [ ] **Step 2: Run** `npm run test:unit`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add i18n keys:
  - `orders.statusPendingPayment` {ja 「お支払い待ち」, en "Awaiting payment"}
  - `orders.stagePaymentPaidy` {ja 「お支払い（ペイディ）」, en "Payment (Paidy)"}
  - `orders.stagePaymentCard` {ja 「お支払い（カード）」, en "Payment (card)"}
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: order status and steps follow her payment method"`

### Task S2: Types, client, fixtures, contract

**Files:**
- Modify: `lib/types.ts` (HubOrder, HubOrderDetail, HubDraft, HubLayawayDetail)
- Modify: `lib/hub-api.ts` (add `orderPaymentMethod`)
- Modify: `lib/fixtures.ts`
- Modify: `supabase/contracts/api.md`
- Test: `tests/fixtures-contract.test.mjs`

**Interfaces:**
- Produces:
  - `HubLatestDecision = { status: 'rejected'|'needs_clarification'; method: CheckoutMethod; amount: number; decided_at: string; message: string|null }`
  - `HubOrderDetail` gets these **optional** fields: `latest_decision?: HubLatestDecision|null; can_switch_method?: boolean; switch_methods?: CheckoutMethod[]`
  - `HubOrder` gets `chosen_method?: CheckoutMethod|null; being_checked?: boolean; amount_due?: number`
  - `HubDraft` gets `total_after_points?: number`
  - `HubLayawayDetail` gets `latest_decision?: HubLatestDecision|null`
  - `hub.orderPaymentMethod(jwt: string, id: string, method: CheckoutMethod): Promise<{ ok: true; payment_method: CheckoutMethod }>` makes a POST to `/orders/${id}/payment-method`.

- [ ] **Step 1: Write the failing test.**
  - The fixture order with a rejected Paidy decision exposes `latest_decision.status === 'rejected'` and `can_switch_method === true`.
  - **A second fixture without any new field** loads through `orderDisplay` without throwing.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the types, client and fixtures. The preview flag `NEXT_PUBLIC_PREVIEW_REJECTED=1` returns the rejected fixture. Document the four fields and the POST in `api.md`.
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `git commit -am "feat: Hub contract for latest decision, list state, after-points and method switch"`

### Task S3: Order page — notice, switch, side card

**Files:**
- Create: `components/account/payment-decision-notice.tsx`
- Create: `components/commerce/switch-method.tsx` (client)
- Create: `lib/payment-method-actions.ts` (`"use server"`)
- Modify: `app/account/orders/[id]/page.tsx`:
  - lines 76-122 (use `orderDisplay`);
  - line 136 (stage and stage3Key);
  - lines 144-182 (the notice above `PaymentDueCard`; `payBlocked` hides it; the switch under her method's box when `can_switch_method`);
  - lines 289-292 (an 「お支払い金額」 row when `pointsApplied > 0`, value `remaining_balance`).
- Modify: `app/account/orders/page.tsx:78-89` and `app/account/page.tsx:111-119`. Pass `o.chosen_method` and `o.being_checked` into `orderStatusLabel`; use `orders.pending` when `being_checked`.
- Test: `tests/payment-method-actions.test.mjs`, covering the pure `switchErrorKey` helper exported from `lib/switch-method-copy.ts`.

**Interfaces:**
- Consumes: `orderDisplay` (S1); `hub.orderPaymentMethod` (S2).
- Produces:
  - `switchMethodAction(orderId: string, method: CheckoutMethod): Promise<ActionResult<{ payment_method: CheckoutMethod }>>`. It reads the JWT like `lib/paidy-actions.ts` `customerJwt()`, validates `orderId` with `/^[\w-]{1,64}$/`, and calls `revalidatePath(\`/account/orders/${orderId}\`)` on success.
  - `switchErrorKey(code: string): 'switchInProgress'|'switchNotAllowed'|'switchFailed'`:
    - `payment_in_progress` → `switchInProgress`
    - `not_rejected`, `not_payable`, `method_not_offered`, `method_requires_yen`, `unchanged` → `switchNotAllowed`
    - anything else → `switchFailed`
- New i18n keys, ja/en; JA where the spec fixes it:
  - `orders.switchLink`: 「ほかのお支払い方法に変更する」 / "Pay another way"
  - `orders.switchConfirm`
  - `orders.switchInProgress`
  - `orders.switchNotAllowed`
  - `orders.switchFailed`
  - `orders.decisionRejected`: 「前回のお支払い（{method} {amount}・{date}）はお受けできませんでした。」 / English equivalent
  - `orders.decisionNothingCharged`
  - `orders.decisionNeedsInfo`: 「お支払いの確認のため、ご連絡が必要です。」 / English equivalent
  - `orders.decisionReplyHint`
  - `orders.decisionMessage`
  - `orders.amountToPay`: 「お支払い金額」
  - `orders.paidyContactToSwitch`: 「ほかの方法でのお支払いをご希望の場合は、ご連絡ください」. It is shown under PaidyPay when `can_switch_method` is false and the chosen method is Paidy.

- [ ] **Step 1: Write the failing test** for `switchErrorKey`: all four mappings above plus an unknown code.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the components, the action and the page edits.
  - `SwitchMethod` lists only `switch_methods`. A press calls the action, then `router.refresh()`.
  - The notice is `role="status"`, with message text shown as written (no HTML).
- [ ] **Step 4: Run** `npm run test:unit && npm run typecheck && npm run check:i18n && npm run check:money && npm run check:terms`. Expected: all pass.
- [ ] **Step 5: Commit:** `git commit -am "feat(orders): last-payment notice, pay another way, amount to pay"`

### Task S4: Draft page, lists, legacy page, remaining copy

**Files:**
- Modify: `app/checkout/complete/d/[draft_id]/page.tsx`:
  - lines 108-113: `draft.nothingYet` JA changes to 「…お支払いはお控えください」;
  - lines 124-131: when `pointsValue > 0 && draft.total_after_points != null`, add a row `draft.totalSoFar` with `money(draft.total)`, and use `draft.amountToPay` 「お支払い予定額」 with `money(draft.total_after_points)` as the total;
  - lines 146-149: step 3 key by `chosen`.
- Modify: `app/account/orders/page.tsx` draft rows and `components/account/draft-rows.tsx:51-53`. Show `total_after_points ?? total`.
- Modify: `app/checkout/complete/[order_id]/page.tsx`. After line 62: `if (!isAwaitingConfirmation(order)) redirect(\`/account/orders/${order.id}\`)`.
- Modify: `lib/i18n.ts`:
  - `orders.reservedNote` becomes method-neutral; drop お振込先 and use 「お支払い方法と期限」.
  - `paidy.errMismatch`, `paidy.errFailed`, `card.errDeclined`, `card.errUnavailable`, `card.errFailed`: replace 「銀行振込をご利用ください」 / "use bank transfer" with 「ほかの方法をご希望の場合はご連絡ください」 / "contact us if you'd like to pay another way".
  - New keys: `complete.next3Paidy` 「ペイディでお支払い — 確定メールのあとで」, `complete.next3Card` 「カードでお支払い — 確定メールのあとで」 (+ en), `draft.amountToPay`.
- Test: `tests/draft-steps.test.mjs`, covering a pure helper `draftStep3Key(mode, method)` exported from `lib/order-display.ts`.

**Interfaces:**
- Produces: `draftStep3Key(mode: CheckoutMode, method: CheckoutMethod|undefined): 'next3'|'next3Layaway'|'next3Paidy'|'next3Card'`.

- [ ] **Step 1: Write the failing test:**
  - layaway → `next3Layaway`
  - full + paidy → `next3Paidy`
  - full + card → `next3Card`
  - full + undefined → `next3`
  - every JA text of the five reworded error keys contains no 「銀行振込をご利用ください」 (read `dict` directly)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all gates: `npm run test:unit && npm run typecheck && npm run check:terms && npm run check:i18n && npm run check:money && npm run check:contrast && npm run check:analytics && npm run check:cutouts`. Expected: all pass.
- [ ] **Step 5: Commit.** Push `feat/payment-lifecycle`, open the PR into `develop` with the footer, and write the merge command in the release note. **Hold the merge until the Hub deploy is done.**

---

# Part C — Release and verification

### Task R1: Release in order

- [ ] **Step 1:** The owner merges the Hub PR into `develop`. Then: `git fetch origin main`, merge `main` into `develop` if it moved, and open the release PR `develop` → `main`. Owner squash-merges, then merge `main` back into `develop` immediately.
- [ ] **Step 2:** Build the single Lovable apply+deploy message.
  - **Assertions:** code-only greps that differ from pre-release main. For example:
    - `grep -c "^export function emailLang" supabase/functions/_shared/storefront-email.ts` → 1;
    - `grep -c "switch_web_payment_method_by_customer_atomic" supabase/migrations/20261111100000_payment_lifecycle.sql` ≥ 1;
    - `grep -c "\"/payment-method\"\\|segments\\[2\\] === \"payment-method\"" supabase/functions/website/index.ts` ≥ 1;
    - plus line counts.
  - **Apply:** the migration.
  - **Deploy:** website, review-payment-submission, submit-cash-payment, set-account-deadlines, confirm-web-draft, change-payment-method, web-payment-reminder-sweep, auto-expire-cash-orders, cancel-cash-order, web-reservation-sweep, paidy-webhook, paidy-reconcile, square-webhook, square-reconcile, preview-transactional-email, notify-shipped.
  - Check the queue, then send once after the owner's OK.
- [ ] **Step 3:** After the deploy, re-run the comment-stripped assertion check on the deployed bodies. Then ask the owner to merge the storefront PR, then the storefront release `develop` → `main`.

### Task R2: Live verification (Claude in Chrome, owner-paced)

- [ ] **Step 1:** CJ-W-900067 order page:
  - heading 「お支払い待ち」, step 「お支払い（ペイディ）」;
  - rejected notice with the test message;
  - 「ほかのお支払い方法に変更する」 present.
  Then switch to transfer: bank details appear, and the "method changed" email arrives in JA + EN with 「ご注文ページを見る」.
- [ ] **Step 2:** Confirm in the DB that `remaining_balance` = 980 and the list `amount_due` = 980 (the after-points assumption in H6).
- [ ] **Step 3:** On a new test order placed with the site's **English** toggle, check that the subject and body are English only.
- [ ] **Step 4:** On a test order, run needs-clarification, then deadline move, then a staff-recorded payment, then mark shipped. Expect four emails, each method-correct and each linking to the website.
- [ ] **Step 5:** Run the remaining live tests from the spec §7: Paidy test A, card sandbox with points, layaway agreement + C2.
- [ ] **Step 6:** Phone width (375 px) on the order page and the draft page. Update the project status doc and give the owner the visual checklist.
