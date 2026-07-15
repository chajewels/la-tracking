## AUDIT RPCs

  All audit RPCs live in Supabase SQL Editor — NOT in repo
  migrations. Function bodies recorded here so future Claude
  sessions can see what exists without querying the live DB.

### audit_account(p_invoice_number text) RETURNS JSONB

  Per-account real-time audit. Called by "Check Health"
  button in AccountDetail (admin + finance). Returns JSONB
  with checks array, each entry { label, expected, stored, pass }.

  CHECK-10 ("sum of pending months matches remaining balance") —
  FINAL LOGIC (2026-07-15): subtract only the UNALLOCATED DP overage.
    v_dp_overpaid  = GREATEST(0, v_dp_paid - downpayment_amount)
    v_dp_allocated = SUM(allocated_amount) of non-voided DP payments
    v_sum_pending := v_sum_pending - GREATEST(0, v_dp_overpaid - v_dp_allocated)
  Rationale: DP payments may or may not allocate to schedule rows.
  When DP overage IS allocated onto a row (dp_allocated > 0) it is already
  in v_sum_pending — subtracting it again double-counts. When it is NOT
  allocated (dp_allocated = 0, INVARIANT 11 case) it never reached the
  pending side and must be subtracted. Subtracting only the unallocated
  remainder reconciles both shapes.
  History: 2026-06-19 added a BLANKET `v_dp_overpaid` subtraction (correct
  only for unallocated overage; examples 19119, 19128). 2026-07-06 (Bug
  #250) REMOVED it on the premise that DP excess always waterfalls into
  schedule rows (correct only for allocated overage) — this reintroduced
  false failures on 19128/19196/19217/19237/19240. 2026-07-15 replaced
  both with the conditional above, verified against all 7 accounts
  (allocated: 19122, 19260 → subtract 0; unallocated: the other 5 →
  subtract full overage).

### audit_all_accounts() RETURNS TABLE

  System-wide audit. Calls audit_account() per account in a
  loop (per Known Fixed Bug #28, rewritten 2026-04-19 to
  delegate rather than reimplement). Returns:
    invoice_number text, status text,
    all_pass boolean, failed_checks text[]

  Called by "Run System Audit" button in Dashboard (admin only).

### audit_delete_cleanup_invariants() RETURNS TABLE

  Schema-invariant audit RPC. Detects FK gaps in
  delete-cleanup edge functions before they cause
  production 500 errors. Created 2026-04-28 after
  tonight's reconciliation_log + extension_requests
  incidents (see Known Fixed Bugs #50 and #51) revealed
  delete-account was vulnerable to silent schema drift
  from SQL-Editor-created tables.

  Lives in: Supabase SQL Editor (not in repo migrations).

  Signature:
    RETURNS TABLE (
      delete_function text,
      parent_table    text,
      child_table     text,
      fk_name         text,
      on_delete       text,
      in_allowlist    boolean,
      finding_type    text,
      severity        text,
      message         text
    )

  Empty result = healthy. Any rows returned = drift to
  investigate.

  Allowlist flags (set per allowlist row):
    - defensive = true — entry is CASCADE belt-and-
      suspenders cleanup. Stale check is skipped because
      the entry is intentionally redundant with DB-level
      CASCADE.
    - pre_check_protected = true — the parent edge
      function rejects deletion via a pre-check rather
      than cleaning up. Missing-cleanup check is skipped
      because the pre-check enforces the invariant.

  Audited parents:
    - layaway_accounts → delete-account
      (14 child entries, all covered after commits
       bdac341 + 1ff9cd8)
    - customers → delete-customer
      (2 entries: customer_analytics defensive,
       layaway_accounts pre_check_protected)
    - cash_orders → none yet
      (no delete-cash-order function exists; surfaces
       preventive findings as severity='info' so future
       gaps are visible before a delete function is
       built)

  Function body (current production):

  ```sql
  CREATE OR REPLACE FUNCTION public.audit_delete_cleanup_invariants()
  RETURNS TABLE (
    delete_function text,
    parent_table    text,
    child_table     text,
    fk_name         text,
    on_delete       text,
    in_allowlist    boolean,
    finding_type    text,
    severity        text,
    message         text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $$
    WITH
    allowlist (delete_function, parent_table, child_table,
               defensive, pre_check_protected) AS (
      VALUES
        -- delete-account (supabase/functions/delete-account/index.ts)
        -- 14 direct-FK children. payment_allocations is excluded
        -- because it is deleted indirectly via payment_id IN
        -- (paymentIds) and has no direct FK to layaway_accounts.
        ('delete-account',  'layaway_accounts', 'payment_submission_allocations', false, false),
        ('delete-account',  'layaway_accounts', 'payment_submissions',            false, false),
        ('delete-account',  'layaway_accounts', 'penalty_waiver_requests',        false, false),
        ('delete-account',  'layaway_accounts', 'penalty_fees',                   false, false),
        ('delete-account',  'layaway_accounts', 'csr_notifications',              false, false),
        ('delete-account',  'layaway_accounts', 'extension_requests',             false, false),
        ('delete-account',  'layaway_accounts', 'reminder_logs',                  false, false),
        ('delete-account',  'layaway_accounts', 'reconciliation_log',             false, false),
        ('delete-account',  'layaway_accounts', 'account_services',               false, false),
        ('delete-account',  'layaway_accounts', 'final_settlement_records',       false, false),
        ('delete-account',  'layaway_accounts', 'penalty_cap_overrides',          false, false),
        ('delete-account',  'layaway_accounts', 'statement_tokens',               false, false),
        ('delete-account',  'layaway_accounts', 'payments',                       false, false),
        ('delete-account',  'layaway_accounts', 'layaway_schedule',               false, false),
        -- delete-customer (supabase/functions/delete-customer/index.ts)
        ('delete-customer', 'customers',        'customer_analytics',             true,  false),
        ('delete-customer', 'customers',        'layaway_accounts',               false, true),
        -- cash_orders has no delete function (soft-cancel only). The
        -- payment_proofs.cash_order_id FK (added 2026-06-15) is a blocking
        -- FK to cash_orders; it is allowlisted (NOT given a DELETE step)
        -- so the otherwise-preventive 'info' finding is suppressed. Any
        -- NEW blocking FK to cash_orders not listed here still surfaces.
        ('(none - soft-cancel only)', 'cash_orders', 'payment_proofs',             false, false)
    ),
    parents (parent_table, delete_function) AS (
      VALUES
        ('layaway_accounts', 'delete-account'),
        ('customers',        'delete-customer'),
        ('cash_orders',      '(none — soft-cancel only)')
    ),
    -- All blocking FKs in pg_constraint pointing at audited parents.
    fks AS (
      SELECT
        p.parent_table,
        p.delete_function,
        regexp_replace(c.conrelid::regclass::text, '^public\.', '') AS child_table,
        c.conname AS fk_name,
        CASE c.confdeltype
          WHEN 'a' THEN 'NO ACTION'
          WHEN 'r' THEN 'RESTRICT'
        END AS on_delete
      FROM pg_constraint c
      JOIN parents p
        ON c.confrelid = ('public.' || p.parent_table)::regclass
      WHERE c.contype = 'f'
        AND c.confdeltype IN ('a', 'r')
    ),
    -- Finding 1: blocking FK exists, child not covered by allowlist.
    -- pre_check_protected entries silently cover the FK so they do
    -- not appear here. Cash_orders gaps are info, others are critical.
    missing AS (
      SELECT
        f.delete_function,
        f.parent_table,
        f.child_table,
        f.fk_name,
        f.on_delete,
        false AS in_allowlist,
        CASE
          WHEN f.parent_table = 'cash_orders' THEN 'preventive_no_delete_fn'
          ELSE 'missing_cleanup'
        END AS finding_type,
        CASE
          WHEN f.parent_table = 'cash_orders' THEN 'info'
          ELSE 'critical'
        END AS severity,
        format(
          '%s blocks DELETE on %s but is not in the %s cleanup list. Add an explicit DELETE in the edge function or a pre-check that rejects deletion.',
          f.fk_name, f.parent_table, f.delete_function
        ) AS message
      FROM fks f
      WHERE NOT EXISTS (
        SELECT 1 FROM allowlist a
        WHERE a.parent_table = f.parent_table
          AND a.child_table  = f.child_table
      )
    ),
    -- Finding 2: allowlist entry that no longer matches a blocking FK.
    -- defensive entries are excluded because they are intentionally
    -- redundant (CASCADE at the DB level handles them, the explicit
    -- DELETE is belt-and-suspenders).
    stale AS (
      SELECT
        a.delete_function,
        a.parent_table,
        a.child_table,
        NULL::text AS fk_name,
        NULL::text AS on_delete,
        true AS in_allowlist,
        'stale_allowlist_entry' AS finding_type,
        'warning' AS severity,
        format(
          'Allowlist tracks %s.%s for %s but no NO ACTION/RESTRICT FK to %s exists. The FK may have been changed to CASCADE/SET NULL, or the table was dropped.',
          a.parent_table, a.child_table, a.delete_function, a.parent_table
        ) AS message
      FROM allowlist a
      WHERE a.defensive = false
        AND NOT EXISTS (
          SELECT 1 FROM fks f
          WHERE f.parent_table = a.parent_table
            AND f.child_table  = a.child_table
        )
    )
    SELECT * FROM missing
    UNION ALL
    SELECT * FROM stale
    ORDER BY severity DESC, parent_table, child_table;
  $$;

  REVOKE ALL ON FUNCTION public.audit_delete_cleanup_invariants() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.audit_delete_cleanup_invariants() TO authenticated;
  ```

  Maintenance rule:
    Whenever a new SQL-Editor table is created with a
    NO ACTION/RESTRICT FK to any audited parent, EITHER:
      1. Add the table to the relevant edge function's
         cleanup list AND add a row to the allowlist
         VALUES block, OR
      2. Set defensive=true (CASCADE at the DB level
         covers it; allowlist entry is redundancy), OR
      3. Set pre_check_protected=true (parent edge
         function's pre-check rejects deletion when
         this child has rows).
    Then run `SELECT * FROM audit_delete_cleanup_invariants()`
    in SQL Editor to confirm zero new findings.

  Verification — initial run on 2026-04-28: returned
  exactly 4 rows:
    - 3 critical: delete-customer missing cleanup for
      cash_orders, extension_requests, payment_submissions
    - 1 info:     cash_payments preventive (no
      delete-cash-order function exists)
    - 0 layaway findings: delete-account is fully
      covered after commits bdac341 + 1ff9cd8.

  After delete-customer fix (Known Fixed Bug #53,
  same day 2026-04-28): the 3 critical rows are
  resolved. Once Cynthia adds the 3 new allowlist
  rows to the audit RPC in SQL Editor:
    ('delete-customer', 'customers', 'cash_orders',         false, true),
    ('delete-customer', 'customers', 'extension_requests',  false, false),
    ('delete-customer', 'customers', 'payment_submissions', false, false)
  the RPC returns exactly 1 row — the cash_payments
  info finding (preventive, unchanged because no
  delete-cash-order function exists yet).

### email_send_log table

  Tracks every transactional email attempt with status
  (pending → sent / failed / suppressed / dlq), template_name,
  recipient_email, error_message. Use as ground-truth for
  email delivery diagnostics. NOTE: prior session notes
  referenced a "transactional_email_log" table — that name
  is incorrect; the actual table is email_send_log.

