# Website receipts (領収書)

Owner decisions 2026-10-27. Migration `supabase/migrations/20270216100000_website_receipts.sql`.
Code: `_shared/receipt-math.ts` (rules), `_shared/receipt-pdf.ts` (PDF), `_shared/website-receipts.ts`
(routes), `_shared/receipt-email.ts` + `email-templates/receipt-ready.tsx` /
`layaway-receipt-ready.tsx` (email), `website-receipt-emails/` (sweep). Contract:
`supabase/contracts/api.md` "Receipts".

## Rules

- **Website orders only.** `cash_orders` and `layaway_accounts` with `source_channel = 'web'`.
  Page365 / live / Hub orders never get one.
- **One final receipt per order**, issued when the order is fully paid: status `completed`, the
  non-voided payments less card/Paidy refunds cover the order total (a layaway's total includes its
  non-waived penalties), and no Square dispute other than `WON`.
- **Tax (owner, locked; corrected twice on 2026-10-27).** Every amount is already tax-included;
  nothing is added. The receipt follows generate-invoice's rule: item rows are shown EXCLUDING tax so
  they add up exactly to the subtotal. No exchange rate, no 10%対象 / 内消費税 breakdown.

  Item table: 品名 / Item · 数量 / Qty · 単価（税抜） / Unit price (excl. tax) · 金額（税抜） / Amount (excl. tax)
  - unit price excl. tax = Math.round(tax-included unit price ÷ 1.1) (SQL: round(unit × 10 / 11))
  - line amount excl. tax = unit price excl. tax × qty

  | JA | EN | figure |
  |---|---|---|
  | 小計（税抜） | Subtotal (excl. tax) | Σ line amounts excl. tax (= the item rows exactly) |
  | 消費税（10%） | 10% Tax | Σ tax-included item amounts − subtotal |
  | 割引 | Discount | discount_amount (coupon included) + points, as a minus; shown even at 0 |
  | 送料 | Shipping fee | shipping_fee as stored; shown even at 0 |
  | 代引手数料 | COD fee | cod_fee — only when > 0 |
  | 延滞金 | Late fee | non-waived layaway penalties — only when > 0 |
  | 合計（税込） | Total (tax incl.) | subtotal + tax − discount + shipping + COD fee + late fee = money received |

  - money received = non-voided payments − points (LOYALTY-) − card/Paidy refunds. Store credit is a
    payment line.
  - The block must add up EXACTLY, and Σ unit × qty must equal Σ stored line totals. When the stored
    data does not (lines edited at Confirm, an overpayment, a paid penalty later waived, no item
    lines), NO receipt is issued — never a balancing line — and an issued one is cancelled
    (`does_not_add_up`). The sync logs a WARNING; find such orders with the query below.
  - Owner examples: 1 item ¥100,000 → 単価/金額（税抜） ¥90,909, 小計 ¥90,909, 消費税 ¥9,091, 合計
    ¥100,000. 2 items ¥60,000 + ¥40,000 → ¥54,545 + ¥36,364 = 小計 ¥90,909, 消費税 ¥9,091,
    割引 −¥0, 送料 ¥0, 合計 ¥100,000.
  - Stored as printed: each item's `unit_price_ex` / `line_ex` in `lines.items`; `subtotal`,
    `tax_amount`, `taxable_total` (Σ tax-included item amounts). `fx_rate_used` is never printed.

- **Peso orders — HELD, owner decision pending.** The layout needs per-line peso amounts, and none
  exist: item lines are stored in YEN only (`unit_price_jpy` / `line_total_jpy`), and checkout never
  derived per-line pesos — it converts the total and the shipping once (`_shared/settlement.ts`
  `settleFullPaymentInPhp`: "the items are the remainder"); staff service lines on a peso order are
  even stored as `Math.round(pesos ÷ rate)` yen (`confirm-web-draft/index.ts`). So no peso receipt is
  issued (`web_receipt_sync` → `not_issued: peso_pending_owner_decision`). Options for the owner:
  (a) convert each line with the order's rate and give the rounding remainder to one line so the
  lines equal the stored peso product amount; (b) one peso line for all pieces (titles listed
  without amounts); (c) store per-line peso amounts at Confirm from now on (a checkout change).
- **Cancel, never edit.** Figures are a snapshot. When an order with an issued receipt leaves
  `completed`, is refunded (Square COMPLETED refund, any Paidy refund), disputed, reassigned, or its
  totals / discount / shipping / COD fee / penalties change (a waiver included) while it stays
  completed, the receipt is CANCELLED with the reason (`not_completed`, `refunded`, `disputed`,
  `not_fully_paid`, `does_not_add_up`, `owner_changed`, `figures_changed`) and, if the order is still fully paid, a
  NEW number is issued. Receipts are never deleted (guard trigger).
- **The switch.** `system_settings.web_receipts_mode`: `off` (nothing issued) | `test` (TEST- orders
  only) | `on` (real orders only). Changed ONLY by `set_web_receipts_mode(mode, expected)` — admin,
  or the database owner in the SQL Editor; audited; guard trigger. Turning it to test or on stamps
  `web_receipts_live_at`; only orders completed at or after it get a receipt. Orders completed while
  off never get one. Cancellation of existing receipts works whatever the switch says.
- **Numbers.** `CJR-YYYY-NNNNNN` — YYYY = the JST year of issue, NNNNNN = its own sequence
  (`website_receipt_number_seq`, never reset). Not an invoice number, not a `cash_receipt_sheet_id`
  ("Cash Receipt" Google-Sheet tab), not the `payment-receipt` Hub email.
- **Downloads.** Every download is a row in `website_receipt_issues` (language, addressee, purpose).
  The first is the original; from the second on the PDF is marked 再発行 / REISSUED.
- **Addressee / purpose.** The customer edits them (trimmed; addressee ≤ 60, purpose ≤ 40, no
  control characters; empty purpose = お品代として) while the receipt is issued.
- **No layaway wording** anywhere on the receipt. The Hub returns all of a customer's receipts; the
  storefront hides layaway ones on the Japanese site (`layawayOffered`).

## Data model

`website_receipts`: id, receipt_number, cash_order_id | layaway_account_id (exactly one), customer_id,
currency, order_number (web reference), lines (snapshot), total_paid (= received), penalty_total,
taxable_total (product amount), subtotal, tax_amount, fx_rate_used (not printed), addressee, purpose, verify_code (20 random
bytes, hex), status issued | cancelled, cancelled_at, cancel_reason, issued_at, created_at,
email_sent_at, email_attempts, email_last_error. Partial unique indexes: at most one `issued` per
order. RLS: staff read; customers only through the `website` function (service role).

`website_receipt_issues`: receipt_id, issue_no, is_reissue (= issue_no > 1), language, addressee,
purpose, issued_at. Append-only.

`lines` = { items[{title, sku, quantity, unit_price_jpy, line_total_jpy}], goods_total, discount,
coupon_code, points, shipping, cod_fee, penalties, order_total, payments[{method, amount}],
store_credit, refunds, received, product_amount, subtotal, tax, discount_total, adds_up }. Item
amounts are yen; they print per line only on a yen receipt.

## How receipts are created and cancelled

Deferred CONSTRAINT triggers (`trg_zz_web_receipt_sync`, `DEFERRABLE INITIALLY DEFERRED`) on
`cash_orders`, `layaway_accounts`, `penalty_fees`, `square_refunds`, `square_disputes` and
`paidy_refunds` run at COMMIT and call `web_receipt_sync(kind, id)`. Running at commit means they see
every payment the completing transaction wrote, whatever path completed the order (reviewer Confirm,
store credit, points, layaway allocation, restore, Shopify, a browser write). No existing function
body was changed. A failure inside the sync is logged as a WARNING and never rolls back the
payment, cancel or refund that fired it. The sync locks the order row and is idempotent.

## Finding orders that do not add up

Read-only, for the SQL Editor — completed web orders with no issued receipt whose block does not add up:

    SELECT 'cash' AS kind, o.id, o.web_reference, s -> 'lines' ->> 'product_amount' AS product,
           s -> 'lines' ->> 'received' AS received
      FROM public.cash_orders o, LATERAL (SELECT public.web_receipt_snapshot('cash', o.id) AS s) x
     WHERE o.source_channel = 'web' AND o.status = 'completed' AND (s ->> 'adds_up')::boolean = false
    UNION ALL
    SELECT 'layaway', a.id, a.web_reference, s -> 'lines' ->> 'product_amount', s -> 'lines' ->> 'received'
      FROM public.layaway_accounts a, LATERAL (SELECT public.web_receipt_snapshot('layaway', a.id) AS s) x
     WHERE a.source_channel = 'web' AND a.status = 'completed' AND (s ->> 'adds_up')::boolean = false;

## Endpoints (website function; x-api-key)

- `GET /me/receipts` — the customer's receipts.
- `PATCH /me/receipts/:id` — addressee / purpose.
- `GET /me/receipts/:id/pdf?lang=ja|en` — the PDF; records a download.
- `GET /receipts/verify?code=` — public (no customer JWT): number, issue date, total, currency,
  valid/cancelled — nothing else. 30 lookups per IP per 10 minutes per instance.

## The PDF

Server-side, pdf-lib 1.17.1 + @pdf-lib/fontkit 1.1.1 + qrcode 1.5.4 via `npm:` specifiers in the edge
function (package.json and the package guard untouched). A4, Japanese by default, English on `lang=en`.

- **Font:** the WHOLE Noto Sans JP Regular, NOT subset — fontkit's subsetting drops most glyphs of
  this font (TTF and OTF; proven in pdf.js and macOS PDFKit, 2026-10-27). `locl` is turned off (in a
  Latin run it swaps the digits for alternates that print widely spaced). The file is NOT in the repo
  (5.7 MB; a server-side bundled function may be at most 5 MB): it lives in the PRIVATE bucket
  `receipt-assets` at **`fonts/NotoSansJP-Regular.ttf`** and is cached in memory per instance.
  Upload the static Regular (400) TTF of Noto Sans JP (Google Fonts, OFL). A missing font answers
  503 `receipt_unavailable` before a download is recorded.
- **Seal:** `receipt-assets/seal/seal.png` (transparent PNG, ~300 px square is plenty for print),
  read server-side, drawn 19 mm next to the issuer block with the receipt number printed faintly
  across it. Missing → rendered without it, warning logged. Never committed, never public.
  The seal is an image object inside the PDF: a determined person with a PDF tool can extract it.
  The overprinted receipt number and the verify code are the protection; full flattening would need
  rasterising the page, which needs a new dependency.
- **Size / time (local, 2026-10-27, Apple M-series):** ~3.37 MB per PDF; 370–450 ms per render. Every
  render logs `website_receipt_pdf: rendered` with font_ms, font_cached, seal_ms, render_ms,
  pdf_bytes — read it in test mode on Supabase (2 s CPU limit per request).
- **Follow-up if Supabase is too slow or the files too large (option b):** a pre-cut font (JIS level
  1 + 2 kanji, kana, Latin, the receipt's symbols) uploaded to the same path; the code does not change.

## Email

`website-receipt-emails` (pg_cron every 10 minutes, Vault key `email_queue_service_role_key`) sends
one "receipt ready" email per issued receipt: order receipts in the customer's language
(`emailLang(customer_lang, delivery country)`), plan receipts in English only. It links to the order
/ plan in My Account ONLY — never the PDF, no attachment. Sent / no address / test customer /
suppressed take the receipt off the queue; other failures retry up to 5 times within 7 days. A
receipt cancelled before its email is never emailed.

## Tests

- `supabase/tests/website-receipts/run.sh` — the migration applied twice on a scratch PostgreSQL,
  then every scenario (switch, deferral, coupon/points/COD, store credit, void → new number, figures
  change, owner change, refunds, disputes, peso layaway with penalty and waiver, test mode, downloads,
  details, verify, guards, email queue, privileges).
- `src/test/receipt-math.test.ts` (vitest, CI) — items excl. tax and the totals block (1 item; the
  owner's 2-item example; 3 items with qty 2 + discount + shipping + COD fee; layaway late fee; peso
  held; does-not-add-up), numbering, reissue, cancellation, switch.
- `development/website-receipts.test.ts` (deno, CI) — rows, routes, email, migration hygiene;
  `RECEIPT_TEST_FONT=<ttf>` also renders real PDFs.

## Not built here

- The storefront pages (My Account receipt list / download / edit, `/receipts/verify`) — storefront repo.
- A Hub card for the switch (today: `SELECT public.set_web_receipts_mode('test');` in the SQL Editor).
