# Apple Pay and Google Pay on the card page — investigation and plan

**Status: PLAN ONLY, not started.** A follow-up to Square card go-live (docs/SQUARE.md
decision Q3: "Cards only at launch; Apple Pay / Google Pay a follow-up PR after go-live").
Implementation starts only after Square card is switched **On in production** and the owner
says go. The first step is the sandbox check in "Step 0" below. No code is merged before it
passes.

Investigated 2026-10-10 (read-only) against cha-jewels-web `origin/develop` `ee6325e` and
la-tracking `origin/main` `83f288e2`. Re-read both before starting, because line numbers move.

## Goal and owner rules

Add Apple Pay and Google Pay buttons to the storefront's card page
(`/account/orders/[id]/pay-card`, Square Web Payments SDK). A customer can then pay a
confirmed cash order with a wallet instead of typing a card. These rules apply to wallets
exactly as they do to cards:

- Cash orders only (full payment), never layaway. Offered only while the Hub's
  `square_mode` / `square_audience` allow it.
- Every payment needs the signed Card Purchase Agreement first (no amount threshold, D9).
- Hold, then capture. Authorised when she pays, charged when staff Confirm in the Hub,
  voided on Reject. Square Dashboard is the source of truth.
- Yen only, the exact Hub amount, never computed on the storefront.

## Owner decisions (2026-10-10)

| # | Decision |
|---|---|
| O1 | After the wallet token, call `payments.verifyBuyer(token, verificationDetails)` and send its `verification_token`. **Prove it in sandbox first. If verifyBuyer returns no token for Apple Pay or for Google Pay, STOP and report. No D7 exception is added.** |
| O2 | Same Card Purchase Agreement and the same terms tick (`card-terms-v1`) for wallets. No new version. |
| O3 | Label wallet payments "Apple Pay (VISA ····1234)" / "Google Pay (…)" in the staff note, the storefront held line and the email (H4 included). |
| O4 | Tokusho: 「クレジットカード（Apple Pay・Google Pay可）」. Only after storefront PR #319 merges, and only in the release where wallets go live. |
| O5 | No separate switch. Wallets follow the card offer. |

## Step 0 — sandbox check (go/no-go, before any code is merged)

Run on a storefront preview branch alias, with the sandbox domain registered (owner step 2),
`square_mode = test` and the TEST customer. Record each answer here.

| Check | Pass | If it fails |
|---|---|---|
| Delayed capture | The wallet payment comes back `APPROVED`, with `delayed_until` about 7 days out, and `autocomplete: false` is honoured | `COMPLETED` (charged at once) → STOP. The Hub's card endpoint files `COMPLETED` too (`website/index.ts` "payment.status !== APPROVED && !== COMPLETED"), so it would be charged before staff Confirm. |
| verifyBuyer (O1) | Returns a token for Apple Pay AND for Google Pay | No token for either → STOP and report (no D7 exception). |
| Token prefix | The wallet `tokenize()` token starts `cnon:` | Another prefix → widen `isSquareSourceId` (`lib/card.ts`) on evidence only. |
| What Square returns | Write down `source_type`, `card_details.card.card_brand` / `last_4`, `entry_method`, `wallet_type` | Labels come from the storefront's `wallet` field (Square documents no web wallet marker), so this only informs the wording. |
| Confirm / Reject / refund | Capture, void and a Dashboard refund each land in the Hub like a typed card | Fix before release. |
| CSP | `/api/csp-report` shows the hosts Google Pay / Apple Pay need on pay-card | Narrow S6 to exactly those hosts. |

## Part A — storefront card flow today (cha-jewels-web)

- **`app/account/orders/[id]/pay-card/page.tsx`**
  - L77 `const card = cardOffer(detail);`. L83 redirects to the order page when there is
    no offer, an open `card_payment`, a pending submission or a staff question.
  - The agreement gate runs **before** the form: L107 `agreementStatus({ doc: "card", order: order.id })`,
    then L109 `cardAgreementGate(status, card)`. The form is drawn only on `gate === "form"`
    (L126–157).
  - L87: if the CSP could not be set, the page fails closed (a plain line, no form).
  - L174: `<CardPay key={card.amount_jpy} …>` uses the Hub's figure only.
- **`components/commerce/card-pay.tsx`**
  - L122 `Square.payments(card.app_id, card.location_id)`, L128 `payments.card()`,
    L133 `attach("#cj-card-container")`.
  - The token, with 3-D Secure inside it (L185–192):
    `c.tokenize({ amount: String(card.amount_jpy), currencyCode: "JPY", intent: "CHARGE", customerInitiated: true, sellerKeyedIn: false, billingContact })`.
    There is no separate `verifyBuyer`. The repo has no `applePay` / `googlePay` /
    `paymentRequest` anywhere.
  - Outcomes: 200 → "held" (brand ····last4, capture-by); 202 → "processing"; refusals are
    worded through `cardRefusalCode` ("nothing was charged" only where the Hub's answer
    proves it). After any outcome the page calls `router.refresh()`.
- **`lib/card.ts`**
  - L61–63 `squareSdkSrc` (sandbox vs production square.js).
  - L257–259 `isSquareSourceId`: `/^cnon:[A-Za-z0-9_-]{8,200}$/`.
  - L274–278 `tokenizeCode`: Invalid → form, Cancel → verification_required, otherwise
    verification_failed.
- **`lib/card-actions.ts` `cardAuthorizeAction`**
  - Re-reads the order and the offer from the Hub (L73, L82).
  - `amount_changed` if the amount moved (L86).
  - The agreement gate again, fail-closed (L94–106).
  - Then `POST /orders/:id/card` (L115–122) with
    `{ source_id, verification: "sdk_tokenize_with_verification", terms: { accepted_at, version: "card-terms-v1", ip, user_agent }, agreement, billing, expected_amount_jpy }`.
  - `HubCardInput` already allows an optional `verification_token`.

## Part B — Hub (la-tracking)

**CreatePayment body** (`_shared/square.ts` `createPaymentBody`):

- `idempotency_key`: `cj-card-<sha256(order\nsourceId)>` (`card-rules.ts` `cardIdempotencyKey`)
- `source_id`
- `verification_token`: forwarded when sent
- `amount_money`: `{ amount, currency: "JPY" }`
- `location_id`: from `system_settings.square_location_id`
- `autocomplete: false`, `delay_action: "CANCEL"`
- `reference_id`: `cja_…`
- `customer_details: { customer_initiated: true, seller_keyed_in: false }`
- `billing_address`, `buyer_email_address`

**Card endpoint** (`website/index.ts`, `POST /orders/:id/card`):

- The token is checked with `/^[A-Za-z0-9_:-]{8,200}$/`, so any Square token shape passes.
- A `verification_token` is forwarded and recorded as `verification_token_supplied`
  (`card-rules.ts` `cardVerificationEvidence`).
- The agreement binding is checked with `agreementBindingProblem`.
- `APPROVED` **or `COMPLETED`** is filed (see Step 0).

**Every place that assumes a typed card:**

| Place | What it reads | Wallet effect |
|---|---|---|
| `_shared/square.ts` `paymentFacts` | `card_details.card.card_brand`, `last_4`, `avs_status`, `cvv_status` | **Works but mislabels.** Fields are optional and null-safe. Apple Pay `last_4` is probably the device account number (Not verified). |
| `website/index.ts` card answer + `cardPaymentState` | `card: { brand, last4 }` → storefront "VISA ····1234" | **Mislabels.** No wallet name. |
| `_shared/square-sync.ts` `fileForAttempt` `p_notes` | `Card authorisation (Square) from the website (…)` | **Mislabels** the staff submission. |
| SQL `file_square_authorization_atomic` | `coalesce(p_card_brand,'card') ····last4` | Same mislabel. Left unchanged. The edge note carries the wallet (no migration). |
| `_shared/email-templates/order-update.tsx` | `cardLine = brand •last4` | **Mislabels** the customer email. |
| `src/components/website/SquareOperationsPanel.tsx` | `{card_brand ?? "Card"} ····{card_last4}` | Mislabels (staff only). Not changed in this plan. The submission note carries the wallet. |
| `card-rules.ts` + `square_payments.verification` (free text, no CHECK) | 3-D Secure evidence | Would be untrue as `sdk_tokenize_with_verification` for a wallet. With O1 it becomes `verification_token_supplied`. |
| reconcile / webhook / refund / dispute / "Finish recording" | Match on `reference_id` (`cja_`) and `square_payment_id` only | **No break.** Nothing reads `source_type`, `entry_method` or wallet fields. |
| `reserve_square_attempt` (latest live body) | `p_verification` stored as given | **No break.** |

Nothing in the Hub rejects a wallet payment. The gaps are labels, the 3-D Secure evidence,
and the unverified delayed capture (Step 0).

## Part C — Square's current docs (2026-10-10)

1. **paymentRequest.**
   - `countryCode`, `currencyCode` and `total` are all required.
   - A JPY total is a whole-number string ("represented as `"10"` in currencies without
     fractional denominations, such as JPY").
   - The billing contact option is `requestBillingContact`.
   - "Sellers in Japan can now accept digital wallet payments with Apple Pay and Google
     Pay" (changelog 2025-08-20).
   - **Wallet `tokenize()` takes no arguments** (reference `ApplePay`, `GooglePay`).
   - Wallet guides: "SCA should be used for all customer-initiated transactions, including
     digital wallet payments … might be declined", recommending `verifyBuyer`. The SCA
     page says "Square will be deprecating verifyBuyer()" (hence O1's sandbox proof).
   - Apple Pay: "call tokenize() immediately within the button's click handler. Avoid any
     async operations".
   - Amount-must-match: Not verified. The plan passes the Hub's amount anyway.
   - Pages: PaymentRequestOptions, LineItem, ApplePay, GooglePay,
     `/docs/web-payments/digital-wallets`, `/docs/web-payments/sca`,
     `/docs/web-payments/apple-pay`.
2. **Apple Pay domain.**
   - The file comes from
     `https://app.squareup.com/digital-wallets/apple-pay/apple-developer-merchantid-domain-association`
     and is hosted at `/.well-known/apple-developer-merchantid-domain-association`.
   - "This file is subject to change … avoiding long-lived caches". A file extension added
     by the server breaks validation.
   - Registration in the Developer Console: Sandbox → "Add Sandbox Domain";
     Production → "Add Domain". `POST /v2/apple-pay/domains` takes only `domain_name`.
     No Apple merchant ID is needed.
   - Apple: "register and verify all top-level domains and subdomains where you'll display
     the Apple Pay button"; "Domains can't be behind a proxy or redirect".
   - Pages: `/reference/square/apple-pay-api/register-domain`,
     `/docs/web-payments/apple-pay`, developer.apple.com "Configuring your environment".
3. **Google Pay.**
   - Requires HTTPS, the Google Pay API Terms of Service and Google's brand guidelines.
   - `Cross-Origin-Opener-Policy: same-origin` breaks it on iOS. **The storefront sets no
     COOP** (checked in the repo and live).
   - Button options: `buttonColor` black / white / default, `buttonType` long / short,
     `buttonSizeMode` static / fill, `buttonRadius`, `buttonBorderType`.
   - Google merchant registration: Not verified (Square mentions none).
   - Pages: `/docs/web-payments/google-pay`, GooglePayButtonOptions.
4. **Delayed capture.**
   - "7 days for online (card not present) payments".
   - "By default, `delay_action` is set to `CANCEL`".
   - Wallet support and any Japan limit: **Not verified** → Step 0.
   - Page: `/docs/payments-api/take-payments/card-payments/delayed-capture`.
5. **What a wallet payment looks like in the Payment object.**
   - `source_type` is one of CARD, BANK_ACCOUNT, WALLET, BUY_NOW_PAY_LATER,
     SQUARE_ACCOUNT, CASH, EXTERNAL.
   - The `WALLET` brands are Cash App, PayPay and so on, **not Apple Pay or Google Pay**.
   - `card_details.wallet_type` (beta) is "Currently only populated for in-person Apple Pay
     payments".
   - No web wallet marker is documented. Web wallets probably come back as `CARD` →
     Step 0.
6. **Brand rules.**
   - Apple: Apple's artwork only; "Pay" never translated; the mark no smaller than other
     marks; clear space ¼ of its height; "Apple Pay" always in English.
   - Google: Google's button only; no smaller than other buttons; 8 dp clear space; the
     name never translated.
   - Who draws the buttons: the merchant places and styles the Apple button with Apple's
     CSS; Square's SDK draws the Google button.
7. **Japan and CSP.**
   - Online brands: Visa, Mastercard, Amex, Discover, Diners, JCB (no UnionPay).
   - Square's CSP page lists no Apple Pay / Google Pay hosts → Step 0.

## Part D — Square account (owner, read-only API, 2026-10-10)

- **Locations.** Two ACTIVE, both with `CREDIT_CARD_PROCESSING`:
  - `LH9F4NX3X9M9F` "Cha Jewels" (立石6-5-1)
  - `LGRVDGQM1XMY6` "Cha Jewels Japan" (MOBILE, 上野)
- **Which one the card offer uses: Not verified here.** The offer sends
  `system_settings.square_location_id` (read in `website/index.ts` `cardOffer`). The value
  is live data only; no repo file or doc records it. Read it on Hub → Website → Settings →
  Card payments, or in the latest `square-preflight` report (`get_square_settings` →
  `preflight`), before Step 0. Write it here.
- **Apple Pay domains.** They cannot be listed through the API (register only), so check
  them in the Developer Console.
- **Application ids (sandbox `sandbox-sq0idb-…` / production `sq0idp-…`).** Also in
  `system_settings` (`square_app_id`). Read them on the same Settings card.

## Part E — serving the Apple Pay file from Next.js

- **Live today.**
  - `https://chajewelsjp.com/…` → **308** to `https://www.chajewelsjp.com/…` (Vercel domain
    setting; there is no `vercel.json` and `next.config.ts` has no `redirects`).
  - `https://www.chajewelsjp.com/.well-known/apple-developer-merchantid-domain-association`
    → **404**.
- **Middleware.** The matcher (`middleware.ts`, `config.matcher`) skips only paths that end
  in a file extension. This path has none, so the middleware runs on it, but only adds the
  CSP and `X-Frame-Options` headers and maybe the language cookie. It never redirects.
- **Plan.**
  - Put the file at `public/.well-known/apple-developer-merchantid-domain-association`, with
    no extension.
  - Register **`www.chajewelsjp.com` only**: the apex redirects, which Apple refuses, and
    customers never stay on the apex.
  - The content type Vercel serves: Not verified. The console check decides.

## The plan — storefront (cha-jewels-web, feature branch → `develop`)

**S1 — `public/.well-known/apple-developer-merchantid-domain-association`.**
- Square's file, byte for byte, from the URL in C2.
- If the sandbox and production files differ (Not verified), serve them from a route
  handler per environment instead.

**S2 — `lib/card.ts`, after `squareSdkSrc`:**
```ts
/** Apple Pay / Google Pay on the Web Payments SDK (Japan since 2025-08-20). Sent to the Hub as `wallet`; never a figure. */
export type CardWallet = "apple_pay" | "google_pay";
export function isCardWallet(v: unknown): v is CardWallet { return v === "apple_pay" || v === "google_pay"; }
/** Square's PaymentRequestOptions: the Hub's amount passed through as a string (JPY has no decimals). Nothing computed. */
export function walletPaymentRequest(amountJpy: number) {
  return { countryCode: "JP", currencyCode: "JPY", total: { amount: String(amountJpy), label: "Cha Jewels" } } as const;
}
```
`tokenizeCode` gets a wallet case:
```ts
export function tokenizeCode(status: string, wallet = false): "form" | "verification_required" | "verification_failed" | "wallet_cancelled" {
  if (wallet && (status === "Cancel" || status === "Abort")) return "wallet_cancelled";
  // …existing lines unchanged
```

**S3 — `lib/types.ts`.**
- `HubCardInput`: add `wallet?: "apple_pay" | "google_pay";`.
- `HubCardResult.card` and `HubCardPayment`: add `wallet?: "apple_pay" | "google_pay" | null;`.

**S4 — `lib/card-actions.ts`.**
```ts
// CardAuthorizeInput:
  wallet?: CardWallet;
  /** O1: verifyBuyer's token for a wallet payment (wallet tokenize() carries no verification details). */
  verificationToken?: string;
// after the expectedAmountJpy check:
  const wallet = input.wallet == null ? null : isCardWallet(input.wallet) ? input.wallet : "bad";
  if (wallet === "bad") return { ok: false, code: "failed" };
  const vToken = typeof input.verificationToken === "string" && /^[A-Za-z0-9:_-]{8,500}$/.test(input.verificationToken) ? input.verificationToken : null;
  if (wallet && !vToken) return { ok: false, code: "verification_required" };
// in hub.orderCard(...):
      ...(wallet ? { wallet, verification_token: vToken! } : {}),
// held result:
      wallet: result.card?.wallet ?? wallet ?? null,
```
The agreement gate, the amount check and the offer re-read are unchanged and apply to
wallets (O2).

**S5 — `components/commerce/card-pay.tsx`.**
- **Types.**
  ```ts
  type SquareWallet = { tokenize: () => Promise<TokenResult>; attach?: (el: string, o?: Record<string, unknown>) => Promise<void>; destroy?: () => Promise<unknown> };
  type SquarePayments = { card: () => Promise<SquareCard>; setLocale?: (l: string) => unknown;
    paymentRequest: (o: ReturnType<typeof walletPaymentRequest>) => unknown;
    applePay: (r: unknown) => Promise<SquareWallet>; googlePay: (r: unknown) => Promise<SquareWallet>;
    verifyBuyer: (token: string, d: VerificationDetails) => Promise<{ token?: string } | null> };
  ```
- **Init**, after the card form is ready. Each wallet is tried on its own; a failure never
  touches the card form:
  ```ts
  paymentsRef.current = payments;
  const req = payments.paymentRequest(walletPaymentRequest(card.amount_jpy));
  try { const ap = await payments.applePay(req); if (cancelled) await destroyCard(ap as never); else { appleRef.current = ap; setWallets((w) => ({ ...w, apple: true })); } }
  catch (err) { console.info("[card-pay] Apple Pay not available here:", err); }
  try { const gp = await payments.googlePay(req); if (cancelled) await destroyCard(gp as never);
        else { await gp.attach!("#cj-google-pay", { buttonColor: "black", buttonType: "long", buttonSizeMode: "fill" }); googleRef.current = gp; setWallets((w) => ({ ...w, google: true })); } }
  catch (err) { console.info("[card-pay] Google Pay not available here:", err); }
  ```
  The cleanup also destroys `appleRef` and `googleRef`.
- **`pay(via: "card" | CardWallet)`.**
  - The existing synchronous checks stay first: terms tick, `cardBilling`, the double-click
    guard.
  - Then the token, with no `await` before it:
    `via === "card" ? c.tokenize(details) : walletRef.tokenize()`.
  - A wallet token is followed by `verifyBuyer(token, details)`. No token back → stop with
    `verification_failed` ("nothing charged"; the token is never used).
  - Then `cardAuthorizeAction(…, { wallet, verificationToken })`.
- **JSX.** A wallet block after the terms tick, above the card button: an Apple button
  (Apple's CSS `-webkit-appearance: -apple-pay-button; -apple-pay-button-type: pay; -apple-pay-button-style: black;`
  in `app/globals.css`, `lang="en"`), a `#cj-google-pay` container, then `walletDivider`.
  Everything is 48 px, the same size as the card button. Google's button cannot be
  disabled, so a click without the tick shows `terms_required` from `pay`.
- **Held line.** With a wallet it uses `heldVia`: "Apple Pay (VISA ····1234)" (O3).
- **`errorText`.** `case "wallet_cancelled": return t("card", "errWalletCancelled");`.

**S6 — `lib/csp.ts`**, enforced pay-card policy only (provisional, narrowed in Step 0):
```ts
/** Google Pay, loaded by Square's SDK (payments.googlePay). Not on Square's CSP page — confirmed from /api/csp-report in sandbox. */
const GOOGLE_PAY = ["https://pay.google.com", "https://www.gstatic.com"];
// script-src: …SQUARE_SCRIPT, ...GOOGLE_PAY      connect-src: …SQUARE_CONNECT, "https://pay.google.com"
```
`frame-src https:` already covers Google's frames. Update `tests/csp.test.mjs` to match.

**S7 — copy.** `lib/i18n.ts` `card` section only, so `check:i18n` passes. "Apple Pay" and
"Google Pay" are never translated.

| Key | JA | EN |
|---|---|---|
| `walletDivider` | またはカード情報を入力してお支払い | Or enter your card below |
| `applePayLabel` | Apple Payで支払う | Pay with Apple Pay |
| `googlePayLabel` | Google Payで支払う | Pay with Google Pay |
| `heldVia` | {wallet}（{card}）を承認しました（与信の確保のみで、まだ請求はしていません）。お支払いを確認した時点で請求し、メールでお知らせします。 | Your {wallet} payment ({card}) is authorised — not charged yet. We charge it when we confirm your payment, and we will email you then. |
| `errWalletCancelled` | お支払いが完了しませんでした。請求は発生していません。もう一度お試しいただくか、カード情報を入力してお支払いください。 | The payment wasn't completed. Nothing was charged. Please try again, or enter your card below. |

**S8 — tokusho (O4).** In `lib/content/legal.ts`, the payment-methods text becomes
クレジットカード（Apple Pay・Google Pay可）, with the EN wording to match. Only after #319
merges (it rewrites this text into `paymentMethodsText`), and only in the release where
wallets go live.

**S9 — storefront `CLAUDE.md`.** One sentence on the card bullet: wallets live inside
`CardPay`; the agreement and tick still come first; the wallet sends verifyBuyer's token;
the Apple file lives in `public/.well-known`.

## The plan — Hub (la-tracking; PR `develop` → `main`; the Lovable deploy is a SEPARATE message)

**No migration.** `verification` is free text and `evidence` is jsonb.

**H1 — `_shared/card-rules.ts`:**
```ts
export type CardWallet = "apple_pay" | "google_pay";
/** What the storefront reports; Square documents no wallet marker for web payments (Payment reference, 2026-10-10). */
export function cardWalletOf(v: unknown): CardWallet | null { return v === "apple_pay" || v === "google_pay" ? v : null; }
export function walletLabel(w: CardWallet | null): string | null { return w === "apple_pay" ? "Apple Pay" : w === "google_pay" ? "Google Pay" : null; }
```

**H2 — `website/index.ts`, card endpoint.**
- After the `verification` line:
  ```ts
  const wallet = cardWalletOf(body.wallet);
  if (body.wallet != null && !wallet) return jsonResponse({ error: "card_mismatch", detail: "bad_wallet" }, 409);
  // O1: a wallet token carries no verification details; its SCA is the verifyBuyer token.
  if (wallet && !verificationToken) return jsonResponse({ error: "verification_required" }, 409);
  ```
- `evidence`: add `wallet`.
- The 200 answer's `card`: add `wallet`.
- `cardPaymentState`: add `wallet`, read from the hold's attempt `evidence->>wallet`, so the
  order page's held line can name it.

**H3 — `_shared/square-sync.ts` `fileForAttempt`.**
- The note becomes `Card authorisation (Square, Apple Pay) from the website (…)` when the
  attempt's `evidence.wallet` is set; otherwise it is unchanged.
- Check first that the `attempt` row from `reserve_square_attempt` carries `evidence`;
  reconcile reads `select("*")`. If it does not, re-read the attempt by id.

**H4 — email (O3).**
- `sendPaymentSubmittedEmail(…, card: { brand, last4, holdUntil, wallet })` →
  `_shared/order-update-email.ts` → `email-templates/order-update.tsx`:
  `cardLine = wallet ? \`${wallet} (${brand} •${last4})\` : …`.
- Add a preview-registry entry for each wallet.

**H5 — tests.** deno / vitest for `cardWalletOf`, the H2 refusals, the note text and the
email card line.

**H6 — docs.** In `docs/SQUARE.md`, change Q3 to "shipped" and add a "Wallets" section.
Add one line to the CLAUDE.md Square rule.

## What the owner does

1. Before Step 0, read `square_location_id` and the two app ids from Hub → Website →
   Settings → Card payments, and write them in Part D.
2. Square Developer Console → the application → **Sandbox** → Apple Pay → **Add Sandbox
   Domain** → the storefront preview branch alias (Claude Code gives the exact host and
   confirms the file is served first).
3. After the storefront release: **Production** → Apple Pay → **Add Domain** →
   `www.chajewelsjp.com` only.
4. Google Pay: check the console for any Google Pay setting. Square documents none.
5. Have Safari with Apple Pay and a sandbox test card, and Chrome with Google Pay, ready
   for Step 0.

## Test plan

1. **Step 0 in sandbox** (above), both wallets, plus a typed-card regression run: hold →
   Confirm → captured.
2. **Each wallet:** agreement unsigned → no form; tick missing → `terms_required`; sheet
   closed → "nothing charged"; pay → held; staff **Confirm** → captured and recorded.
   Second order: **Reject** → voided plus the "payment not accepted" email. Third order:
   capture, then a **Square Dashboard refund** → recorded in the Hub plus the refund email.
   Check the labels in the staff note, the held line and the email.
3. **Live** (after the production domain is registered):
   - One small order with Apple Pay: hold → Confirm → capture → Dashboard refund.
   - One small order with Google Pay: Reject → void.
   - Square Dashboard is the source of truth at every step.

## Release order

1. **Hub PR** (H1–H6) `develop` → `main`, merged by the owner.
2. **Lovable message, separate and sent once by Claude Code after the owner's OK.** It
   deploys `website` and every function that imports the changed `_shared` files, with
   source assertions. The current storefront sends no `wallet`, so nothing changes for it.
3. **Storefront PR** (S1–S7, S9) → `develop` → Step 0 on the branch alias → `develop` →
   `main`.
4. **Production Apple Pay domain registration**, then the live test.
5. **S8 (tokusho)** in the same release as wallets going live, after #319.

**What stays hidden.** The buttons sit inside the card form, which is drawn only where the
Hub offers card (`square_mode`, audience, confirmed yen cash order, never layaway, agreement
signed). Apple Pay also stays hidden until its domain is registered. While card is Off,
nobody sees either button (O5).

## Not verified

- Wallets with delayed capture, and the hold length for wallets → Step 0.
- verifyBuyer returning a token for Apple Pay and for Google Pay → Step 0 (O1: STOP if not).
- What a web wallet payment looks like in the Payment object, and the Apple Pay `last_4` → Step 0.
- The wallet token prefix → Step 0.
- The Google Pay / Apple Pay CSP hosts → Step 0.
- Whether the Apple Pay file differs between sandbox and production, and the content type served.
- Google merchant registration (Square mentions none).
- Which location id the card offer uses, and the app ids (live `system_settings`) → owner step 1.
- Whether `reserve_square_attempt`'s answer includes `evidence` → before H3.
- Japan-specific SCA rules for wallets.
