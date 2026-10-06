# Website payment lifecycle — one-batch fix (design spec)

Date: 2026-10-05. Status: **APPROVED** by the owner 2026-10-05 15:28 JST; §9 added by owner directive 2026-10-06 08:51 JST.
Repos: Hub `chajewels/la-tracking` (one PR) + storefront `chajewels/cha-jewels-web` (one PR).
Builds on: `claude/checkout-payment-choice-and-points-plan-2026-10-04.md` (C1–C7) and
`docs/CHECKOUT-CHOICE.md`.

## 1. Why

Owner's live test on 2026-10-05:
- Reservation CJ-W-900067, Paidy, 12,000 points, ¥980 to pay.
- A Paidy payment was rejected from the Hub. The rejection email arrived correctly.
- "View order" then opened a page that says 「お振込待ち」 and shows the step 「お支払い案内・お振込 / Bank Transfer」.
- The page offers only Paidy, and nothing says the last payment was cancelled.

The owner asked for **every** payment flow to be checked and fixed in one go, not one at a time.

A read-only audit of both repos (2026-10-05) found the problems below. Each has a file reference in the audit; the key ones are quoted here.

## 2. What the owner decided

| # | Decision | Source |
|---|---|---|
| D1 | After a Paidy or card payment is **rejected**, her order page keeps her chosen method first and **also lets her switch herself** to another method the order allows (e.g. bank transfer). The switch is audited like a staff change. | Owner, 2026-10-05 12:4x ("Same method + switch") |
| — | Everything marked *(recommended)* below is Claude's recommendation, approved or changed by the owner when she approves this spec. | — |

## 3. Things that are correct and stay as they are

- After a reject, the email's button opens the order page and she can pay again. **This is intended.**
- The Japanese button 「ご注文を確認する」 means "check your order". Chrome translated it as "Confirm your order", which reads as if it confirms something. It is renamed (§5 A, last row).
- `cash_orders.payment_status = 'pending_transfer'` is the Hub's internal word for "money due", and many checks depend on it. **It is not renamed.** The screens stop showing it as "transfer" (§4 A).
- Web cash orders have no receipt upload. Staff record transfers. This is not changed here; only the copy that wrongly says "upload" is fixed (§5 E).
- Layaway is bank transfer only (C2). Its transfer wording is correct.

## 4. Storefront (cha-jewels-web) — what she sees

### A. Status heading and step tracker follow her method
Today every label comes from `payment_status`, so all methods read "transfer" (`lib/order-status.ts:55,59`, `components/account/order-progress.tsx:30`). Fix:

- **Heading** while money is due:
  - transfer: 「お振込待ち」 / "Awaiting transfer" (unchanged)
  - Paidy and card: 「お支払い待ち」 / "Awaiting payment"
  - while a payment is being checked: 「お支払いを確認中です」 (already exists)
- **Step 3 label:**
  - transfer: 「お支払い案内・お振込」
  - Paidy: 「お支払い（ペイディ）」
  - card: 「お支払い（カード）」
- **While a payment is being checked**, the tracker moves to step 4 「入金確認」, the "being checked" step. Today it stays on step 3.
- **Where this applies:** the same rule runs on the order page, the order list and the account home. The list and home get the fields they need from the Hub (§6 2).

### B. "Your last payment was not accepted" notice
The order page gets a notice above the payment box when the most recent decided payment was rejected or needs clarification.
- **Rejected:** 「前回のお支払い（ペイディ ¥980・10月5日）はお受けできませんでした。」 + the staff message if one was written + "nothing was charged" for Paidy/card.
- **Needs clarification:** 「お支払いの確認のため、ご連絡が必要です。」 + the staff message + "reply to the email we sent or contact us".
  - **No new payment buttons** are shown while needs clarification is open. Her money may already be with us.
- The Hub supplies this (§6 1). The page never works it out itself.

### C. Switch method after a reject (D1)
- **When it shows:** her chosen method is Paidy or card, the latest decided payment on the order is **rejected**, nothing is in progress, and the order is payable.
- **What she sees:** under her method's box, 「ほかのお支払い方法に変更する」 / "Pay another way", listing the other methods the order allows:
  - transfer always;
  - card only on a yen order with the card offer whole;
  - Paidy only where Paidy is offered.
- **Choosing one** calls a new Hub endpoint (§6 3). The page reloads showing the new method.
- **Not offered while** a payment is in progress, on layaway, or when she never had a rejected payment. C1 stays as it is for everyone else.
- **Paidy refusing her inside its own window** (e.g. 「メールアドレスまたは携帯電話番号が異なります」) leaves no record on our side. So that case shows a line 「ほかの方法でのお支払いをご希望の場合は、ご連絡ください」 instead of a switch. *(recommended)*

### D. Draft / thank-you page (`app/checkout/complete/d/[draft_id]`)
- **Step 3** follows her method:
  - transfer 「お振込 — メールに記載の期限まで」
  - Paidy 「ペイディでお支払い — 確定メールのあとで」
  - card 「カードでお支払い — 確定メールのあとで」
- **Totals:** when points are used, the last row becomes 「お支払い予定額」 = total − points (¥980), with the full total shown as a row above it. The figure comes from the Hub (§6 4).
- 「…お振込はお控えください」 becomes method-neutral 「…お支払いはお控えください」.
- The order list and the plan list draft rows show the same after-points figure.

### E. Smaller fixes
- `orders.reservedNote` (mentions お振込先): method-neutral.
- **Legacy thank-you page** `app/checkout/complete/[order_id]`: once the order is confirmed it **redirects to the order page**. That stops it showing 「お振込先の準備中です」 to Paidy and card buyers.
- **Order page side card:** when points are used, shows 「お支払い金額」 (total after points) under "Total".
- **Paidy and card error texts** that say 「銀行振込をご利用ください」 (she cannot switch herself unless D1 applies) are reworded to 「ほかの方法をご希望の場合はご連絡ください」. Where D1 applies, the switch link is shown instead.

## 5. Hub emails (la-tracking) — what she receives

### A. Wording fixes (emails that say "transfer" to Paidy and card buyers)

| Email | Today | Fix |
|---|---|---|
| order-payment-received | 「お振込…を確認」 / "your transfer" for every method | Method-aware: transfer 「お振込を確認」, Paidy 「ペイディでのお支払いを確認」, card 「カードでのお支払いを確認」. When points were used, a points line is added and the total shown is the after-points amount. |
| order-payment-due (reminder) | Bank details + 「お振込期限」 for every method; the SQL does not look at the method | Method-aware: Paidy and card get "pay with Paidy / card from your order page" + the button, and **no bank details**. Transfer stays as it is. *(recommended: send to all methods, worded per method, rather than skipping Paidy and card)* |
| order-expired | 「お振込期限までにご入金…」 | Method-neutral: 「お支払い期限までにお支払いの確認ができなかったため…」 |
| order-reserved (draft) | 「お支払い方法とお振込先をメールで」 | Uses her chosen method: transfer "the bank details will be in the confirmation email"; Paidy and card "you can pay with Paidy / card once we confirm". |
| order-ready when **points pay the whole order** | "Please pay ¥0 by transfer" + bank details | Sends **order-payment-received** ("fully paid by points") instead. |
| order-payment-not-accepted (transfer) and order-payment-due | "upload your receipt on your order page" (no such upload) | "reply to this email with your transfer receipt" |
| order-method-changed | Reuses the "ready" heading, says nothing about a change | Heading 「お支払い方法を変更しました」, old → new method, then the new method's instructions. Also sent after D1's self-switch. |
| Every order email's button | 「ご注文を確認する」 (translated as "Confirm your order") | 「ご注文ページを見る」 |

### B. New emails *(recommended — owner to approve)*

| Moment | Email | Where it is sent from |
|---|---|---|
| Staff mark a web-order payment **needs clarification** | 「お支払いについて確認させてください」 + staff message + order link | review-payment-submission (today the cash-order branch sends nothing) |
| **Partial** payment confirmed on a web order | 「¥X を受領しました。残り ¥Y を {期限} までに」 | review-payment-submission (today `skipped_partial_payment`) |
| Staff **move the deadline** (set-account-deadlines) | 「お支払い期限を {新期限} に変更しました」 | set-account-deadlines (web orders and web layaways) |
| Staff enter a **tracking number** | 「発送しました」 + courier + tracking number + order link. Two existing emails already promise this. | new small edge function `notify-shipped`, called by the Hub tracking card after save; once per order (idempotency key) |

### C. Web layaway emails *(recommended)*
For **web** layaways (source_channel 'web') only, the old Hub emails become website-style emails in English (layaway rule), linking to `/account/layaway/:id`, not the portal:
- staff reject;
- needs clarification.

Hub-created layaways keep their portal emails.

### D2. Staff record a payment for a website order (owner question 2026-10-05 13:10)
How it works today, checked in code and on live:
- Both sides read one database. So a payment staff record in the Hub (Cash order → Record payment → `submit-cash-payment`) appears on her website order page right away as 「お支払いを確認中です」. When a reviewer presses Confirm, the page shows "Paid".
- Payments she makes on the website go into the same Hub Payment Submissions queue: Paidy, card, and layaway receipt uploads. Every new submission rings the staff bell (trigger `notify_submission_created`, which labels web orders CJ-W-…).
- Emails today:
  - staff record → the **old Hub English email** "cash-payment-submitted", linking to `portal.chajewelsjp.com`. That is wrong for a website customer.
  - Confirm → the website "payment received" email, which says 「お振込」 (fixed in §5 A).
- **Fix *(recommended)*:** for a **website** order, the staff-record step sends a website-style email in her language instead: 「お支払いのご連絡を受け付けました。確認後にあらためてご連絡します」, with the amount and a link to her order page. Hub-created cash orders keep their current email.

### D3. Email language (owner question 2026-10-05 13:10)
How it works today:
- The website writes the language of the site she checked out on (the 日本語/English toggle, cookie `cj-lang`) onto the draft and the order as `customer_lang`.
- Every website email reads that field:
  - `ja` → Japanese first, then the same text in English below;
  - `en` → English only.
- Test order CJ-W-900067 was saved as **`ja`** on both the draft and the order (checked on live). The checkout was done on the **Japanese** site. Chrome's automatic translation made it look like English, so the system followed the language that was actually set.
- Two real gaps remain:
  1. **The subject line is always Japanese first, even for an English customer.** Fix: the subject is in her language only, Japanese + English only for `ja`.
  2. **When the language is missing, the email defaults to Japanese** (`pickLang`). Fix: when missing, use the delivery country (Japan → Japanese first, otherwise English).
- Test tip: place English test orders with the site's **English** toggle, not Chrome translation.

### D. Left out of this batch (listed so nothing is forgotten)
- ~~Paidy / Square refund, dispute, fraud cancel, automatic card void, and manually issued store credit stay staff-handled with no automatic email.~~ **Superseded 2026-10-06 by §9** (owner: "full notifications … all cycles"): refunds, fraud cancel, automatic card void and manual store credit now email the customer; card-hold-expiring and dispute stay staff-bell only.
- auto-forfeit-settlement sends the "permanently forfeited" email on the final-settlement path (PATH 3). That function is **LOCKED** by CLAUDE.md, so it is reported in docs/OPEN-BUGS.md for a separate owner decision, not changed here.
- Layaway "expired" says "nothing was paid" even when points were used. It gets a separate wording fix in the same Hub PR (template only, no logic).

## 6. Hub API (website function) — what the site needs

1. **`latest_decision`** on the order detail and the layaway detail: `{ status: 'rejected'|'needs_clarification', method, amount, decided_at, message }` for the newest decided submission, only if it is newer than any confirmed one.
   - `message` is a **new column** `payment_submissions.customer_message`. It is written only by the staff Reject / Needs-clarification paths: the reviewer's text, which the dialog already tells staff the customer sees.
   - Provider-ended rejections write no message. Their notes are internal English.
2. **Order list rows** (`GET /orders`) add `chosen_method`, `being_checked` (boolean) and `amount_due` (remaining after points). The list and account home then label correctly.
3. **`POST /orders/:id/payment-method`** (customer JWT, D1). It calls a new RPC `switch_web_payment_method_by_customer_atomic(order, customer, method)`:
   - Refuses unless:
     - the order is hers, web, pending, payable;
     - there is no lock (`cash_order_payment_lock`);
     - her latest decided submission is rejected;
     - the target method is allowed: transfer always, Paidy/card only if yen and currently offered.
   - Writes `payment_method`, audit row `payment_method_changed` with actor `customer`, and sends order-method-changed.
4. **Draft detail and draft list rows** add `total_after_points` = total − points value, computed by the Hub.

## 7. Testing

- **Storefront:** unit tests for the method-aware status/step helper, the notice, the switch visibility rule and the after-points figure (`tests/*.test.mjs`). All CI gates must pass (check:terms, i18n, layaway-ja, money, contrast, typecheck, test:unit).
- **Hub:** Deno tests:
  - render every changed or new email for transfer / Paidy / card, JA and EN;
  - no 振込 / "transfer" text in any Paidy or card render;
  - the switch RPC refusal matrix.
  - Tests are added to the CI line.
- **Live (owner-paced, Claude in Chrome), after release:**
  1. Order CJ-W-900067: notice + "Pay another way" visible; switch to transfer → bank details + method-changed email.
  2. Paidy test A: approve ¥980 → Capture in the Paidy dashboard → Hub records → "Paidy payment received" email (method-correct) → refund in Paidy.
  3. Card sandbox with points (second test product).
  4. Layaway: sign the agreement as Test Customer; check Paidy/card greyed out (C2).
  5. Needs clarification + deadline move + tracking entry on a test order → three emails.
  6. Phone width (375 px) for the order page and the draft page.
- **Function drift audit** at 0. Lovable deploy message with source assertions (code-only greps that differ from pre-release main).

## 8. Release

- One Hub PR into `develop` containing:
  - the migration: new column, new RPC, patched `web_payment_reminder_eligible`, record-only bodies;
  - functions: website, review-payment-submission, set-account-deadlines, notify-shipped, change-payment-method, confirm-web-draft, auto-expire-cash-orders, web-payment-reminder-sweep, reservation emails;
  - templates, tests and docs.
  It then goes `develop` → `main` with the Hub UI tracking-card call in the same release.
- One storefront PR into `develop` → `main`. It is merged **after** the Hub release is deployed, because it reads the new API fields. Every new field is read defensively, so the order of the two releases cannot break the live site.
- Then one Lovable apply+deploy message, sent by Claude Code after the owner's OK.

## 9. Addendum — every payment cycle reaches her (owner directive 2026-10-06 08:51 JST)

Owner: "I want the full notifications, from payment, placing order, confirmation, rejection, cancellation, abandoned, all cycles — implemented all, not asking 1 by 1." Source: `claude/payment-lifecycle-email-addendum-2026-10-06.md` (audit of Hub main 8421e9ee + storefront main b425859). Live finding: on CJ-W-900068 the card hold (08:24 JST) sent **no email**; only Confirm (08:31) sent "payment received".

Every email below is sent by the Hub through `sendStorefrontEmail` (test gate, Reply-To, one `email_send_log` row per attempt), never throws, and is **web only** (`source_channel = 'web'`) unless stated. Order emails: her language (`emailLang`, JA first + EN, EN-only for `en`). Layaway emails: English only, no `lang` prop.

| # | Moment | Email (JA / EN heading) | Sent from | Once per |
|---|---|---|---|---|
| 1 | She pays by Paidy or card herself (website, or the same authorisation recovered by webhook / hourly check) | 「お支払いを受け付けました」 / "We have received your payment": method, amount (the Hub's filed figure), card brand •last4; card: 「仮売上（まだ請求されていません）」 / "card hold — not charged yet" + hold end date (`formatDeadline`, JST/PHT); 「確認後に改めてご連絡します」; order button. The wording makes **no claim** about any message from Paidy itself (not established — see "Checked during build"). | `filePaidyAuthorization` (outcome created/recovered) and `fileForAttempt` (outcome `filed`) — the two writers every path uses | submission id (`payment-submitted-<submission>`) |
| 2 | Web **layaway** payment reported — by her upload (website `POST /layaway/:id/pay`) or by staff (submit-payment) | "We have received your payment details" + amount + plan link `/account/layaway/:id` | website, submit-payment (web plan: instead of the portal "payment-submitted") | submission id |
| 3 | Routine web layaway emails: instalment reminder + grace period (send-reminders), penalty applied / escalation / waiver revoked (penalty-engine), penalty waived (approve-waiver), payment voided (void-payment) | Website-style EN `layaway-update` variants `reminder`, `penalty`, `penalty_reinstated`, `penalty_waived`, `payment_voided`; plan link | the same functions; a Hub-created plan keeps its portal template | the existing keys, unchanged |
| 4 | Web layaway reactivated after forfeit (reactivate-account) | "Your plan has been reactivated" + new deadline (`extension_end_date`) + remaining + plan link | reactivate-account, **email block only** (LOCKED function: owner-approved email change, logic untouched) | account id (existing key) |
| 5 | Loyalty emails on a web order / web plan: points earned, promo bonus, tier upgrade, tier restored | Website-style `web-loyalty` template, her language (layaway: EN), CJ-W reference, button to the website `/loyalty` | award-loyalty-points (web source only; Hub sources keep their templates) | the existing keys, unchanged |
| 6 | Staff void / restore a payment on a web cash order | 「お支払い記録を取り消しました」 / 「お支払い記録を復元しました」 + amount, reason (void), new balance, order link. The Hub void dialog tells staff the website customer sees the reason. | void-cash-payment, restore-cash-payment | payment id + void time |
| 7 | Points used at checkout | No separate email — the ready email already shows "Points used −¥X" and the after-points amount (`ItemsTable pointsApplied`, built in H3). Confirmed. | — | — |
| 8 | Refund pending on a cancelled web order is paid | Hub action **"Mark refund issued"** on the cancelled web order (refund method, date, optional note; audited; only while `refund_status = 'refund_pending'`) → 「返金が完了しました」 / "Your refund has been sent" + amount, method, date | new RPC `mark_web_order_refund_issued_atomic` + new edge function `mark-refund-issued` | order id |
| 9 | Refund made in the Square or Paidy dashboard (webhook / reconcile records it) | 「返金を受け付けました」 / "We have processed your refund" + amount, method, 「反映まで日数がかかる場合があります」 | `syncSquareRefund` (only when `record_square_refund` reports a change to `COMPLETED`), `syncPaidyPayment` (a newly inserted `paidy_refunds` row) | provider refund id |
| 10 | Fraud cancel / automatic card void / mismatch void | Fraud cancel → the order-cancelled email with the neutral reason 「お支払いを確認できなかったため」 / "We could not confirm your payment". A card hold voided automatically with no submission (amount mismatch, Paidy took the order, risk HIGH not cancelled) → order-payment-not-accepted, `provider_ended`, card. **Never names fraud.** The website order page shows the same neutral reason instead of the stored staff reason. | `fraudCancel`, `handleFilingException` | order id / Square payment id |
| 11 | Card hold expiring | No customer email — staff bell only (unchanged). | — | — |
| 12 | Dispute opened | No customer email — staff bell only (unchanged). | — | — |
| 13 | Store credit issued manually | 「ストアクレジットを発行しました」 / "Store credit has been added to your account" + amount, currency, expiry (1 year), how to use (staff apply it to her next order in the same currency). Every customer (Hub and web), language from her latest web order else her country. | issue-store-credit | lot id |
| 14 | auto-forfeit PATH 3 | LOCKED — docs/OPEN-BUGS.md only, unchanged. | — | — |

Dead code removed in the same PR (no callers since PR 10): `sendOrderReservedEmail`, `sendLayawayReservedEmail`, `sendOrderCantSupplyEmail`, `sendLayawayDeclinedEmail`, `sendOrderReservationLapsedEmail`.

### Checked during build (2026-10-06, repo + live read-only)
- **Does Paidy email her on authorisation?** Not established by any doc in the repo or the project. Paidy states it sends no cancellation email (order-payment-not-accepted header). Item 1 is therefore worded without any reference to a Paidy message.
- **Does approving checkout points enqueue anything?** No. Live: `loyalty_redemptions` has no triggers; `loyalty_transactions` has only `trg_loyalty_transactions_immutable` and `trg_note_loyalty_transaction` (writes order notes, no notification). No live function inserts into `loyalty_notifications`. `confirm-web-draft` approves through `approve_redemption_atomic` (SQL), not `process-loyalty-redemption`.
- **Any path that changes `refund_status` after cancel?** No. Live: the only function whose body mentions `refund_status` is `terminate_web_order_atomic` (md5 7ca713d8…). Item 8 adds the first one.

### Tests added (R2 live)
Card sandbox: pay → "received" email within a minute (JA+EN); Confirm → "payment received"; Reject → "not accepted". Paidy test A: filing email. Web layaway: upload receipt → EN received email. Square sandbox refund → refund email. Every new template variant has a fixture in `development/email-encoding.test.ts` (CI fails otherwise).
