-- Run in the Supabase SQL Editor. audit_delete_cleanup_invariants() lives there,
-- not in repo migrations (docs/AUDIT-RPCS.md).
--
-- Adds the two allowlist rows for the FK gaps fixed in delete-customer on
-- 2026-09-17. Both are cleanup entries, not defensive and not pre-check
-- protected: the edge function clears the link explicitly.
--
--   loyalty_signups       link cleared, row kept (converted_customer_id := NULL)
--   website_live_claims   held -> released, then customer_id := NULL
--
-- Paste these two lines into the allowlist VALUES block, after the existing
-- ('delete-customer', 'customers', ...) rows:
--
--       ('delete-customer', 'customers', 'loyalty_signups',     false, false),
--       ('delete-customer', 'customers', 'website_live_claims', false, false),
--
-- Then confirm the audit is clean:

SELECT * FROM public.audit_delete_cleanup_invariants();

-- Expected afterwards: the two 'missing_cleanup' criticals for
-- loyalty_signups_converted_customer_id_fkey and
-- website_live_claims_customer_id_fkey are gone. Any remaining row is a
-- separate finding and should be read on its own terms.
