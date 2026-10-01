<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## PAYMENT SUBMISSION FLOW (locked — 2026-04-13, restore added 2026-06-04, universal-submission redesign 2026-06-12)

  ALL payments regardless of submitter must go through
  Submissions review before appearing in Proof of Payment.

  UNIVERSAL-SUBMISSION POLICY (locked 2026-06-12, Bug #219):
    Recording a payment ALWAYS creates a pending payment_submissions
    row, for EVERY role including admin and finance. Direct writes to
    the payments table happen ONLY via the confirmation flow
    (review-payment-submission). Cash orders already comply
    (submit-cash-payment is submission-only for all roles).

    The previous confirm_payment-coupled direct-write branches in
    record-payment / record-multi-payment were removed. The dialog's
    "find a confirmed row, else INSERT a fresh pending submission"
    fallback in RecordPaymentDialog was removed (it was the root
    cause of the 19115/18132 stray-pending incident).

  Flow:
    1. Customer submits via portal → status='submitted'
    2. Staff/Admin/Finance/CSR submits from AccountDetail → status='submitted'
       (no role exception — every role goes through submissions)
    3. Admin/Finance reviews in Submissions tab → clicks Confirm
       → status='confirmed' AND payment row is created via
       review-payment-submission
    4. ONLY confirmed submissions appear in Proof of Payment

  NO payment goes directly to Proof of Payment without
  confirmation in Submissions tab. The payments table is written
  ONLY by review-payment-submission (single source of writes).

  The only way status becomes 'confirmed' is via explicit reviewer
  click in the Submissions tab (review-payment-submission edge
  function). Nothing else writes status='confirmed' — all INSERT
  paths (submit-payment, record-payment for every role,
  record-multi-payment for every role, submit-cash-payment for
  every role) use status='submitted'.

  RESTORE PATH (added 2026-06-04):
    A rejected submission can be restored to the review queue by users
    with reject_submission permission. Restore action:
    - Validates submission.status === 'rejected' (400 otherwise)
    - Flips status to 'submitted' (re-enters queue)
    - Preserves reviewer_user_id and reviewer_notes as rejection history
    - Writes audit_logs entry: entity_type='payment_submission',
      action='restored_from_rejected', captures restorer + optional reason
    - Works for both layaway and cash-order submissions
    - Does NOT fire customer notifications (internal recovery action)
    - Does NOT create or modify payments, allocations, schedule, or
      cash_orders — only flips submission.status

  PROOF REQUIRED — ALL submit paths + confirm (updated 2026-06-30):
    proof_url is now REQUIRED for EVERY submit path, enforced
    server-side with a 400 "Proof of payment is required" when
    proof_url is missing/empty/whitespace:
      - Portal: submit-payment + submit-cash-payment (added 2026-06-06).
      - Staff: record-payment + record-multi-payment (added 2026-06-30) —
        the prior staff exemption / insert-then-attach-without-proof flow
        is GONE. Staff dialogs now upload proof FIRST and pass proof_url
        in the invoke body; the edge function attaches it to the created
        submission. Preview calls (preview_only) write nothing and are
        exempt.
    No submission can be CONFIRMED without proof: review-payment-submission
    returns 400 "Proof of payment is required to confirm this submission."
    when action='confirmed' and proof_url is empty — covers both layaway
    and cash-order confirm branches.
    Staff can attach/replace proof on a pending submission directly from
    the Submissions tab (proof-only action; layaway + cash).
    BulkPaymentImport (rebuilt 2026-10-01): ONE proof per batch, uploaded
    first to payment-proofs/bulk-import/<batch_key>/; a row may carry its
    own https proof_url (optional 6th CSV column) which wins over the batch
    proof. A row with neither is refused by the database.

  BATCH INSERT — insert_payment_submissions_batch (migration 20261020100000,
    owner-approved plan 2026-10-01): one transaction, all rows or none;
    idempotent on p_batch_key (= the submissions' reference_number — a retry
    with the same key inserts nothing and returns the existing ids); the
    per-account advisory lock + 30-minute same-amount duplicate check of
    insert_payment_submission_guarded, except rows of the same batch never
    count as each other's duplicates; NO 24-hour rate cap (owner D-1:
    caller is admin/finance); one audit_logs row per submission
    (staff_bulk_import_submitted | staff_multi_payment_submitted). Callers:
    Bulk Payment Import (browser, has_permission bulk_payment_import) and
    record-multi-payment (service role, is_staff(p_user_id)). The payments
    table is still written only by review-payment-submission, one confirm
    at a time ("Confirm all in this batch" = later step, owner D-3).

  2026-06-06: record-payment + record-multi-payment now set sender_name
    at payment_submissions insert (staff name from user_metadata/email),
    so notify_submission_created staff-bell bodies no longer show
    "Unknown sender" for staff-recorded payments.


## Rules moved from CLAUDE.md (2026-10-02, verbatim)

Moved out of CLAUDE.md on 2026-10-02 to keep it under 100 KB. Text is verbatim (only the 2-space CLAUDE.md indent removed); CLAUDE.md keeps the one-line rules and a pointer here.

### Payment submission rate limits — where each cap is implemented

Implemented in record-payment/index.ts. DP caps filter the count by
submission_type='downpayment' so DP and non-DP caps are independent
(hitting the DP cap does not consume installment headroom and vice
versa).

submit-payment/index.ts uses a flat 3-cap for all submissions (no
DP branch, no trade branch). Customer-portal DP submissions hit
this cap at attempt 4 regardless of trade status.

record-multi-payment/index.ts is uncapped (intentional — staff
batch entry path).

HTTP 429 returned on cap exceeded. Frontend handler in
RecordPaymentDialog.tsx parses error.message containing 'Too many'.

### record-multi-payment uses the batch RPC (2026-10-02)

`record-multi-payment` requires `batch_key` on a real submit (400 without it;
preview exempt) and writes all legs with ONE `insert_payment_submissions_batch`
call (`p_source = 'multi_invoice'`), after the preview loop. A refusal from the
RPC comes back as 409 (`duplicate_submission_detected`, SQLSTATE 23505) or 400
(its own message); nothing is inserted. The per-leg `payment_submissions`
insert + audit loop is gone.
