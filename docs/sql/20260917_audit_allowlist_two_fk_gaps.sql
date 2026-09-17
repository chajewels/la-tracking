-- Run in the Supabase SQL Editor, AFTER delete-customer has been deployed.
-- Deployed 2026-09-17: "Successfully deployed edge functions: delete-customer".
--
-- audit_delete_cleanup_invariants() lives in the SQL Editor, not in repo
-- migrations (docs/AUDIT-RPCS.md). Its allowlist is a hardcoded VALUES block
-- inside the function body, so adding a row means replacing the function.
--
-- This adds the two rows for the FK gaps delete-customer now clears:
--
--   loyalty_signups       link cleared, row kept (converted_customer_id := NULL)
--   website_live_claims   held -> released, then customer_id := NULL
--
-- Both are cleanup entries, not defensive and not pre-check protected: the
-- edge function clears the link explicitly.
--
-- This is the live function body as of 2026-09-17 with two lines added and
-- nothing else changed. Paste the whole thing.

CREATE OR REPLACE FUNCTION public.audit_delete_cleanup_invariants()
 RETURNS TABLE(delete_function text, parent_table text, child_table text, fk_name text, on_delete text, in_allowlist boolean, finding_type text, severity text, message text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH allowlist (delete_function, parent_table, child_table, defensive, pre_check_protected) AS (
    VALUES
      ('delete-account', 'layaway_accounts', 'payment_submission_allocations', false, false),
      ('delete-account', 'layaway_accounts', 'payment_submissions', false, false),
      ('delete-account', 'layaway_accounts', 'penalty_waiver_requests', true, false),
      ('delete-account', 'layaway_accounts', 'penalty_fees', true, false),
      ('delete-account', 'layaway_accounts', 'csr_notifications', true, false),
      ('delete-account', 'layaway_accounts', 'extension_requests', false, false),
      ('delete-account', 'layaway_accounts', 'reminder_logs', true, false),
      ('delete-account', 'layaway_accounts', 'reconciliation_log', false, false),
      ('delete-account', 'layaway_accounts', 'account_services', true, false),
      ('delete-account', 'layaway_accounts', 'final_settlement_records', false, false),
      ('delete-account', 'layaway_accounts', 'penalty_cap_overrides', true, false),
      ('delete-account', 'layaway_accounts', 'payments', false, false),
      ('delete-account', 'layaway_accounts', 'layaway_schedule', true, false),
      ('delete-account', 'layaway_accounts', 'generated_invoices', true, false),
      ('delete-customer', 'customers', 'customer_analytics', true, false),
      ('delete-customer', 'customers', 'layaway_accounts', false, true),
      ('delete-customer', 'customers', 'cash_orders', false, true),
      ('delete-customer', 'customers', 'extension_requests', false, false),
      ('delete-customer', 'customers', 'payment_submissions', false, false),
      ('delete-customer', 'customers', 'service_jobs', false, false),
      ('delete-customer', 'customers', 'trade_ins', false, false),
      ('delete-customer', 'customers', 'loyalty_signups', false, false),
      ('delete-customer', 'customers', 'website_live_claims', false, false),
      ('(none - soft-cancel only)', 'cash_orders', 'cash_payments', false, false),
      ('(none - soft-cancel only)', 'cash_orders', 'generated_invoices', false, false),
      ('(none - soft-cancel only)', 'cash_orders', 'payment_proofs', false, false)
  ),
  parents (parent_table, delete_function) AS (
    VALUES
      ('layaway_accounts', 'delete-account'),
      ('customers', 'delete-customer'),
      ('cash_orders', '(none - soft-cancel only)')
  ),
  fks AS (
    SELECT p.parent_table, p.delete_function,
      regexp_replace(c.conrelid::regclass::text, '^public\.', '') AS child_table,
      c.conname AS fk_name,
      CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' END AS on_delete
    FROM pg_constraint c
    JOIN parents p ON c.confrelid = ('public.' || p.parent_table)::regclass
    WHERE c.contype = 'f' AND c.confdeltype IN ('a','r')
  ),
  missing AS (
    SELECT f.delete_function, f.parent_table, f.child_table, f.fk_name, f.on_delete,
      false AS in_allowlist,
      CASE WHEN f.parent_table = 'cash_orders' THEN 'preventive_no_delete_fn' ELSE 'missing_cleanup' END AS finding_type,
      CASE WHEN f.parent_table = 'cash_orders' THEN 'info' ELSE 'critical' END AS severity,
      format('%s blocks DELETE on %s but is not in the %s cleanup list. Add an explicit DELETE in the edge function.',
        f.fk_name, f.parent_table, f.delete_function) AS message
    FROM fks f
    WHERE NOT EXISTS (
      SELECT 1 FROM allowlist a
      WHERE a.parent_table = f.parent_table AND a.child_table = f.child_table
    )
  ),
  stale AS (
    SELECT a.delete_function, a.parent_table, a.child_table,
      NULL::text AS fk_name, NULL::text AS on_delete,
      true AS in_allowlist,
      'stale_allowlist_entry' AS finding_type,
      'warning' AS severity,
      format('Allowlist tracks %s.%s for %s but no NO ACTION/RESTRICT FK to %s exists. The FK may have been changed to CASCADE/SET NULL, or the table was dropped.',
        a.parent_table, a.child_table, a.delete_function, a.parent_table) AS message
    FROM allowlist a
    WHERE a.defensive = false AND a.pre_check_protected = false
      AND NOT EXISTS (
        SELECT 1 FROM fks f
        WHERE f.parent_table = a.parent_table AND f.child_table = a.child_table
      )
  )
  SELECT * FROM missing
  UNION ALL
  SELECT * FROM stale
  ORDER BY severity DESC, parent_table, child_table;
$function$;

-- Then confirm:

SELECT * FROM public.audit_delete_cleanup_invariants();

-- EXPECTED AFTERWARDS
--   The two 'missing_cleanup' criticals are gone:
--     loyalty_signups_converted_customer_id_fkey
--     website_live_claims_customer_id_fkey
--   No new 'stale_allowlist_entry' warning appears for either table — both FKs
--   exist and are NO ACTION, which is what the new rows describe.
--   Any other row is a separate finding and should be read on its own terms.
--
-- ROLLBACK
--   Re-run this same statement with the two added lines deleted:
--     ('delete-customer', 'customers', 'loyalty_signups', false, false),
--     ('delete-customer', 'customers', 'website_live_claims', false, false),
--   The function is STABLE and reads only the catalogs — replacing it changes
--   no data, so there is nothing else to undo.
