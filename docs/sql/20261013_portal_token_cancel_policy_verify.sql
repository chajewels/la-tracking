-- READ-ONLY. Verify 20261013200000_portal_token_cancel_policy_min_length.sql.
-- Every anon/token policy on payment_submissions must now carry the 16-char
-- minimum. Expect: every row has_min_length = true.
SELECT policyname AS policy,
       cmd,
       roles::text AS roles,
       (coalesce(qual, '') || coalesce(with_check, '')) ILIKE '%length(portal_token) >= 16%' AS has_min_length
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'payment_submissions'
   AND (coalesce(qual, '') || coalesce(with_check, '')) ILIKE '%portal_token%'
 ORDER BY policyname;
