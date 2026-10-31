# Security hardening — record

Owner-requested security investigation of 2026-10-31 (website + Hub, read-only; every finding re-checked in code or the live database). The full list (34 items), plan and tracker are in the owner's Notion page "Cha Jewels — Security Hardening Plan + SEO Master Plan Tracker". This file records what lands in THIS repository. The storefront half of batch 1 is `chajewels/cha-jewels-web` PR #455 (`docs/security/SECURITY-HARDENING-2026-10-31.md` there).

## Batch 1 (2026-10-31): H-07 and H-01 — Hub side

Owner instruction: fix W-01, W-02, W-03, H-07, H-01 first. W-01..W-03 are storefront-only.

### H-07 (High) — Messenger links customers type are shown to staff as clickable links
- Before: `messenger_link` was stored as typed on three customer save paths (`website` POST /auth/customer, `customer-portal` update_profile, `setup-customer-account`) and rendered raw in about 15 places (`href={c.messenger_link}`, `window.open(messengerLink)`), so a `javascript:` value would run in a staff session when clicked. Live data 2026-10-31: 673 links, 0 dangerous, 4 without a scheme.
- After:
  - TWO checks in ONE module, `supabase/functions/_shared/profile-messenger-link.ts`:
    - SAVE rule `normalizeMessengerLink` (same rule as the storefront's `lib/profile-messenger-link.ts`; the Hub test checks the shared regex and limit, not full equivalence): empty → null; with a scheme only http/https; without one `https://` is added (the forms' hint is `m.me/username`); dotted host, no credentials, no whitespace/control/backslash, ≤ 200 chars; the canonical `url.href` is stored.
    - DISPLAY rule `safeMessengerHref` (every render / open, and every staff save): safety only — http/https, dotted host, no credentials, no control character or backslash; no length cap and no whitespace refusal, so long links staff saved keep opening. Live 2026-10-31: 673 links, 0 over 200 chars, 3 with spaces (all three are names, not links — they show no button, correctly).
  - Save paths: `website` → 422 `messenger_link_invalid`; `customer-portal` → 400 with the English message + `code`; `setup-customer-account` stores no link (and logs) rather than blocking the account, because the sign-up form (`PortalSetup.tsx`) refuses it first; the portal profile form refuses it too.
  - Rendering: every Messenger href / window.open goes through `src/lib/messenger-href.ts` (`messengerHref`, `openMessenger`); a link that fails the display rule renders no link and no button (the "Copy & Open Messenger" buttons in Monitoring / Penalty follow-up are gated on it; the portal activation modal falls back to the generic share link; the multi-invoice dialog says "No usable Messenger link"). Side effect: the 4 scheme-less links now open as `https://…` instead of resolving as broken relative links.
  - Staff save paths (Edit / New customer, customer page edit, CSV import, AI command) refuse a link that would not be clickable ("Messenger link must be a web address… — or leave it empty"); `bulk-import` stores only a safe link (otherwise none). An existing bad value must be cleared before that customer is saved again.
  - Customer re-saving her portal profile (`customerProfileMessengerLink`, browser + `customer-portal`): a link she did not change is kept when the display rule accepts it, so a long link staff saved never blocks her from updating her phone or email. The save rule measures the stored canonical form (`url.href`), not only what was typed.
  - Promo / announcement `link_url` (staff-authored, also shown on the customer portal) now goes through `safeHttpUrl`.
- Not changed: no database-level check (a separate, owner-approved migration if wanted).

### H-01 (High) — payment proofs are publicly readable by link
- Live 2026-10-31: bucket `payment-proofs` `public = true`, 4,663 objects; 5,217 submission rows store `/object/public/payment-proofs/…` links. Listing is NOT open (no anon SELECT policy), but every file opens without signing in for anyone holding its link.
- Order of the fix (Bug #166 broke production by flipping first): (1) every viewer signs → (2) deploy → (3) owner-approved switch to private → (4) verify.
- This batch does step (1) in code:
  - Staff: `PaymentSubmissions.tsx`, `CashOrderDetail.tsx`, `AccountDetail.tsx` and `PaymentProofs.tsx` open, download and "open in new tab" through `openProof()` (`src/lib/proof-url.ts`: fresh 1-hour signed URL; view opens the tab on the click so popup blockers do not stop it; download uses a temporary link to the attachment-served URL, so no empty tab; a failure shows "Could not open / download this proof"). The proof links are real buttons (no `href="#"`). Payment Proofs → Download no longer falls back to the stored public URL. Thumbnails already used signed URLs.
  - Customers: `customer-portal` returns `proof_view_url` (1-hour signed, `_shared/proof-signing.ts`, works for PIN/token customers who cannot sign in the browser), signing ONLY files stored under her own layaway / cash order ids (live 2026-10-31: every id-prefixed proof belongs to the submission's own customer; about 30 legacy proofs with other names get no signed link, and so do bulk payment import batch proofs, stored under `bulk-import/<batch>/…` — correctly, since one batch proof can cover several customers). The portal opens that link and falls back to the stored URL only while the bucket is still public.
  - Writers are unchanged: they keep storing the public-shaped URL, which the DB guard `trg_guard_payment_submission_proof_url` and `isAllowedProofUrl` require; it is now an identifier.
- **BLOCKER before step (3) — owner decision needed:** cash receipts / invoice Google Sheets embed proofs with `=IMAGE("<proof_url>")` (`_shared/cash-receipt.ts`, written by `generate-invoice`, `review-payment-submission`, `rebuild-cash-receipts`, `append-cash-receipt`). Google fetches those images anonymously, so making the bucket private breaks every receipt image, existing and future. Options: (a) receipts embed long-lived signed links instead (new code + rebuild of existing sheets); (b) keep the bucket public and accept link-based access; (c) another storage location for receipt images. Nothing is flipped until the owner chooses.
- **Pre-switch checklist (all before step 3):**
  1. Owner decision on the receipts blocker above, and its code shipped.
  2. `customer-portal` deployed (so `proof_view_url` is present); then remove the portal's fallback to the stored URL (`proofViewHref` in `CustomerPortal.tsx`) in the same change as the switch.
  3. Live check of storage policies on `payment-proofs`: staff (authenticated with the right role) can SELECT/sign; there is NO anon SELECT policy. Storage policies are not in the migrations.
  4. `payment_files.file_url` (written by `review-payment-submission`) holds public URLs; nothing reads it today — note it as stale, or sign on read if a reader is ever added.
  5. Proofs not stored under an order id will no longer open in the customer portal (staff still can): the ~30 legacy ones AND every bulk payment import batch proof (`bulk-import/<batch>/…`, `BulkPaymentImport.tsx`) — this group keeps growing with each bulk import. If customers must see those, the import would need to save a per-row copy under each account id (owner decision).
- Deploy (step 2) is a separate Lovable deploy-only message after the owner releases this to `main`: `customer-portal` (H-01, H-07), `website`, `setup-customer-account` and `bulk-import` (H-07). The frontend goes live with the Firebase deploy of `main`.

### Verification (branch `security/proofs-signed-links-messenger`, base `develop` `2437cbe4`)
- `npx tsc -p tsconfig.app.json --noEmit` exit 0; `check-no-explicit-any` 0; `check-anon-policies` clean.
- CI vitest list 48 files / 1,174 tests pass (after the correction batch), including new `src/test/security-batch1.test.ts` (17 tests after the correction batches; the original 4 fail against the old code: raw Messenger hrefs, unchecked save paths, raw promo links, direct proof links).
- `deno lint` (322 files) clean; `deno check` of `website`, `customer-portal`, `setup-customer-account`, `bulk-import` clean; CI Deno suite 629 passed / 0 failed.
- `npm run build` succeeds.

### Correction batch (independent review, 2026-10-31)
Review of #455 + #691 found no blocker; all 6 should-fix items and the notes were applied; a second review of the corrections found 2 more (an unchanged long link blocking the portal profile save; bulk-import batch proofs missing from the checklist), both applied, plus the canonical-length check: display rule separated from the save rule (long links kept), buttons gated on a usable link, failed proof opens/downloads now say so, AccountDetail + PaymentProofs moved to `openProof` (no popup-blocked open, no public fallback), `href="#"` proof links became buttons, downloads leave no empty tab, portal signs only the customer's own files, staff save paths checked, canonical `url.href` stored, the new 422 recorded in `docs/WEBSITE-VERCEL.md`, pre-switch checklist above extended.

### H-22 (High) — portal customer could set someone else's email (fixed in this batch, 2026-10-31)
- Before: `customer-portal` update_profile stored `profile.email` as typed. The website links a new sign-in to the customer row holding that VERIFIED email (`website` POST /auth/customer, `setup-customer-account`), so a portal customer (565 live customers use token-only access) could type another person's email and that person's later website sign-up would land on her row — the victim's orders would then show in the attacker's portal. A linked customer could also block someone's sign-up (409 `email_already_linked`).
- After: an unchanged email (case-insensitive) is kept; the ONLY change allowed from the portal is to the customer's own confirmed sign-in email (Bearer JWT, `email_confirmed_at` set). Anything else → 400 `email_change_not_allowed`, and the portal shows "To change your email address, please message Cha Jewels and we will update it for you." Staff still change emails in the Hub (duplicate checks apply there).
- `notes` is a shared field by design (the portal labels it "Any notes for Cha Jewels…" and shows it back to her). Staff screens now say so ("the customer can see and edit these in her portal — do not write internal notes here"). Live: 6 customers have notes, 4 of them have portal access.
- Live audit: 20 `portal_profile_update` rows since 2026-03 (the audit stores no old value, so how many changed email cannot be told).
- Deploy: `customer-portal` (already in the deploy list above).

### Markup and remaining review notes (2026-10-31)
- The 12 Messenger buttons that were a `<Button>` inside an `<a>` (invalid nested controls; read twice by screen readers) are now one control (`Button asChild`), icon-only ones labelled "Open Messenger".
- Kept on purpose: the proof download uses a temporary link without `target` — Storage serves it as an attachment, so the Hub page stays; a missing file is caught before the click. The "not a web address" branch in the Monitoring / Penalty follow-up Messenger handlers stays as a defensive fallback (their buttons are already gated).
- Tests: `src/test/security-batch1.test.ts` now 17 tests (H-22 and the button markup added).
