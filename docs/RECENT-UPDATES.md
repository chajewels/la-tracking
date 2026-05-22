## Recent Updates

  2026-05-19 night — Phase B/C/D cleanup patch (commit 413bf0b):
  (1) CREATE writes invoice_number=NULL for shipping_fee/service_fee/
  catalog_reward (REDEEM-{id} placeholder removed; column nullable since
  2026-05-19). (2) APPROVE bell body now type-aware — points-only types
  include the customer's notes inline (bell was already unconditional;
  Gap-2 "FK gate" premise was false, nothing ungated). (3) loyalty-redeem
  email renders "Purpose: {notes}" for points-only vs "Applied to: INV #…"
  for new_order_discount (notes added to templateData + template prop).
  CLAUDE.md locked type-rules table extended with invoice_number column +
  bell + email rules. Deploy: process-loyalty-redemption +
  send-transactional-email (registry coupling). new_order_discount paths
  and VOID branch unchanged.

  2026-05-19 evening — Design correction: shipping_fee and service_fee
  redemptions are now strictly points-only (no FK, no invoice_number,
  required notes). Last night's locked rules incorrectly tied these to
  existing accounts. Phase B/C/D Patch (commit fa8b6f7):
  process-loyalty-redemption CREATE/APPROVE/VOID branches type-aware,
  RedemptionForm strips order picker for shipping/service and adds
  required notes textarea, RedemptionApprovalModal displays notes
  prominently. Historical cancelled redemptions referencing TEST-004
  (08d1d0e0, af636465, bfd0da07) remain as audit artifacts of the
  pre-correction design.

  2026-05-19 morning — Phase 7-bis: ported fetchWithRetryOnRateLimit
  helper to daily-reconciliation (commit 7ac176f). Fixes silent
  account skip on Supabase outbound rate limit (empirical: 2026-05-19
  01:00 UTC cron skipped invoice 18175 and TEST-001). Same pattern
  as Bug #114 / Phase 7 fix in send-reminders. Issue 3 resolution
  rationale documented; stale "do not use redemption flow" warning
  at line ~6692 removed (contradicted resolved status).

  2026-05-18 evening — Redemption end-to-end shipped: Phase B
  (synthetic payment + inline waterfall allocation on approve,
  commits 2b0fb64/2afca0f/8130ace), Phase C (type-aware form +
  picker + mobile fix, af6bcba/ce70934/64a0b25/3d073c8), Phase D
  (RedemptionApprovalModal type-aware labels), Phase E (this
  CLAUDE.md sync). Redemption-wiring Issues 1+2+3 RESOLVED &
  VERIFIED end-to-end (cash 19034 + layaway TEST-004 08d1d0e0);
  reconcile-account confirmed diagnostic-only; payments
  submitted_by_type CHECK + schema facts documented; void-path
  cleanup (D1), atomic rollback (D2), GAS-delete sync (D3)
  deferred.

  2026-05-19 07:34 UTC — Customers menu mobile crash fixed (commit 165c51a).
  Option A active-letter-only grouped view. Was Bug #80 follow-up; grouped view
  rendered all 662 CustomerCards causing iOS WebKit OOM. Mobile test confirmed.

  2026-05-19 mid-session — DB UPDATE: TEST-001 status active→completed (cache
  sync; audit 12/12 pass). TEST-004 status overdue→active (canonical audit
  reports no rows currently overdue).

  2026-05-19 07:58 UTC — RedemptionForm.tsx dead-code cleanup (commit 210dcb2).
  -51 net lines: deleted unused state (selectedOrderId/Kind, loadingOrders,
  ordersError), unused useMemo (eligibleOrders), unused helpers. tsc green.

  2026-05-19 08:34 UTC — RedemptionForm orders-fetch dual-auth fix (commit
  f941e6e). Phase B Step 4-B2 5th missed call site closed: orders-fetch now uses
  getPortalAuthHeaders helper, sending Bearer JWT for session-auth (email/password)
  customers and ?token=X for legacy token-auth. Previously sent anon key as
  Authorization Bearer (broken for both modes — Path 0 silently rejected, no
  fallback worked). Empirically verified: customer Carl Aurel Largo redeemed
  new_order_discount on his account 20000.

  2026-05-19 08:38–08:39 UTC — First real-customer end-to-end Phase B Patch 2
  verification on account 20000: redemption a31bf7b1 (confirmed, 200 pts, ¥200)
  → synthetic payment 61f354ca (ref LOYALTY-a31bf7b1) → allocation fcc68f51
  (installment, schedule row 1, ¥200) → row 1 partially_paid (paid_amount=200)
  → account total_paid +200. Carl then submitted ¥7,500 Rakuten Bank payment
  (implicit DP); final state: total_paid 7,700, remaining 17,300, status active.
  audit_account('20000') all 12 checks pass. 43-phase Issues 1+2+3 empirically
  closed twice (TEST-004 08d1d0e0 + Carl 20000 a31bf7b1).

  2026-05-19 09:09 UTC — Bug #82 THIRD occurrence (commit 9e3bd1f). Bulletproof
  table-anchor replaces React-Email <Button> across 5 auth templates
  (signup/recovery/magic-link/invite/email-change). Root cause: React-Email
  Button renders nested <span> that Yahoo strips. Empirically verified on
  h8redthanblue@yahoo.com at 18:23 JST. See Bug #82 entry for universal rule.

  2026-05-19 evening — Sequence 2 (customer portal auth migration) scope
  collapsed. feature/email-password-auth branch confirmed gone (Scenario C:
  work shipped incrementally to main over the past 2 weeks). Original 'HIGH
  risk, dedicated test session needed' framing no longer applicable. Remaining
  items: P5 session timeout (LOW, ~45min), P3 loyalty staff visibility
  (feature), P6 admin audit log (feature).
