-- customers.portal_password_at — who actually chose a portal password.
--
-- INCOMPLETE — CORRECTED BY 20261010310000: the full_name marker below only
-- exists for sign-ups from 2026-05-16, so it missed 49 May password holders.
--
-- ALREADY APPLIED ON LIVE 2026-09-28 by the owner in the SQL Editor
-- (UPDATE 89; verify: with_password 89, migrated_without_password 49,
-- unmigrated_with_password 0). This file is the record. It is idempotent, so
-- re-running it is a no-op.
--
-- Why: auth_user_id does not mean "has a password". The storefront signs in
-- by magic link and website POST /auth/customer sets auth_user_id, and
-- Supabase stores a random encrypted_password for OTP-created users. Only
-- PortalSetup's signUp writes user_metadata.full_name, so that is the marker
-- the backfill reads. setup-customer-account stamps the column from now on.
-- It drives the portal link (_shared/portal-link.ts, src/lib/portal-link.ts).

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS portal_password_at timestamptz;

COMMENT ON COLUMN public.customers.portal_password_at IS 'When this customer chose a portal password at /portal/setup. NULL = no portal password (token-only, or storefront magic-link sign-in only). auth_user_id alone does NOT mean a password: storefront magic-link sign-ins set it too. Backfilled 2026-09-28 from auth.users.raw_user_meta_data ? ''full_name'' (only PortalSetup signUp writes it); stamped by setup-customer-account from then on. Drives the portal link: set -> sign-in link, otherwise a live token wins.';

UPDATE public.customers c
   SET portal_password_at = u.created_at
  FROM auth.users u
 WHERE u.id = c.auth_user_id
   AND u.raw_user_meta_data ? 'full_name'
   AND c.portal_password_at IS NULL;
