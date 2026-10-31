# Security hardening — record

Owner-requested security investigation of 2026-10-31 (website + Hub, read-only; every finding re-checked in code or the live database). The full list (34 items), plan and tracker are in the owner's Notion page "Cha Jewels — Security Hardening Plan + SEO Master Plan Tracker". This file records what lands in THIS repository. The storefront half of batch 1 is `chajewels/cha-jewels-web` PR #455 (`docs/security/SECURITY-HARDENING-2026-10-31.md` there).

## Batch 1 (2026-10-31): H-07 and H-01 — Hub side

Owner instruction: fix W-01, W-02, W-03, H-07, H-01 first. W-01..W-03 are storefront-only.

### H-07 (High) — Messenger links customers type are shown to staff as clickable links
- Before: `messenger_link` was stored as typed on three customer save paths (`website` POST /auth/customer, `customer-portal` update_profile, `setup-customer-account`) and rendered raw in about 15 places (`href={c.messenger_link}`, `window.open(messengerLink)`), so a `javascript:` value would run in a staff session when clicked. Live data 2026-10-31: 673 links, 0 dangerous, 4 without a scheme.
- After:
  - ONE rule, `supabase/functions/_shared/profile-messenger-link.ts` (identical to the storefront's `lib/profile-messenger-link.ts`): empty → null; with a scheme only http/https; without one `https://` is added (the forms' hint is `m.me/username`); dotted host, no credentials, no whitespace/control/backslash, ≤ 200 chars.
  - Save paths: `website` → 422 `messenger_link_invalid`; `customer-portal` → 400 with the English message + `code`; `setup-customer-account` stores no link (and logs) rather than blocking the account, because the sign-up form (`PortalSetup.tsx`) refuses it first; the portal profile form refuses it too.
  - Rendering: every Messenger href / window.open goes through `src/lib/messenger-href.ts` (`messengerHref`, `openMessenger`); a link that fails the rule renders no link. Side effect: the 4 scheme-less links now open as `https://…` instead of resolving as broken relative links.
  - Promo / announcement `link_url` (staff-authored, also shown on the customer portal) now goes through `safeHttpUrl`.
- Not changed: staff forms (Edit/New customer, CSV import, `bulk-import`) still save what staff type; anything they save is neutralised at render. A database-level check is a separate, owner-approved migration if wanted.

### H-01 (High) — payment proofs are publicly readable by link
- Live 2026-10-31: bucket `payment-proofs` `public = true`, 4,663 objects; 5,217 submission rows store `/object/public/payment-proofs/…` links. Listing is NOT open (no anon SELECT policy), but every file opens without signing in for anyone holding its link.
- Order of the fix (Bug #166 broke production by flipping first): (1) every viewer signs → (2) deploy → (3) owner-approved switch to private → (4) verify.
- This batch does step (1) in code:
  - Staff: `PaymentSubmissions.tsx` and `CashOrderDetail.tsx` open, download and "open in new tab" through `openProof()` (`src/lib/proof-url.ts`: fresh 1-hour signed URL; tab opened on the click so popup blockers do not stop it; `download` served as attachment). Thumbnails already used signed URLs; `AccountDetail.tsx` and `PaymentProofs.tsx` already signed.
  - Customers: `customer-portal` returns `proof_view_url` (1-hour signed, `_shared/proof-signing.ts`, works for PIN/token customers who cannot sign in the browser); the portal opens that link and falls back to the stored URL only while the bucket is still public.
  - Writers are unchanged: they keep storing the public-shaped URL, which the DB guard `trg_guard_payment_submission_proof_url` and `isAllowedProofUrl` require; it is now an identifier.
- **BLOCKER before step (3) — owner decision needed:** cash receipts / invoice Google Sheets embed proofs with `=IMAGE("<proof_url>")` (`_shared/cash-receipt.ts`, written by `generate-invoice`, `review-payment-submission`, `rebuild-cash-receipts`, `append-cash-receipt`). Google fetches those images anonymously, so making the bucket private breaks every receipt image, existing and future. Options: (a) receipts embed long-lived signed links instead (new code + rebuild of existing sheets); (b) keep the bucket public and accept link-based access; (c) another storage location for receipt images. Nothing is flipped until the owner chooses.
- Deploy (step 2) is a separate Lovable deploy-only message after the owner releases this to `main`: `customer-portal` (H-01, H-07), `website` and `setup-customer-account` (H-07). The frontend goes live with the Firebase deploy of `main`.

### Verification (branch `security/proofs-signed-links-messenger`, base `develop` `2437cbe4`)
- `npx tsc -p tsconfig.app.json --noEmit` exit 0; `check-no-explicit-any` 0; `check-anon-policies` clean.
- CI vitest list 47 files / 1,166 tests pass, including new `src/test/security-batch1.test.ts` (10 tests; 4 of them fail against the old code: raw Messenger hrefs, unchecked save paths, raw promo links, direct proof links).
- `deno lint` (322 files) clean; `deno check` of `website`, `customer-portal`, `setup-customer-account` clean; CI Deno suite 629 passed / 0 failed.
- `npm run build` succeeds.

### New finding recorded during this batch (not fixed here)
- **H-22 (to investigate):** `customer-portal` update_profile lets a portal customer overwrite her own `customers.email` and `customers.notes` with no verification. The storefront links a customer to a sign-in by email, so an unverified email change may let one customer's record be linked to another person's sign-in; and if `notes` is staff-only, customers can overwrite it. Needs a read of how `email` and `notes` are used before any change.
