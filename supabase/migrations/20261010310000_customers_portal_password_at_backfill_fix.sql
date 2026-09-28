-- customers.portal_password_at — CORRECTED backfill (fixes 20261010300000).
--
-- ALREADY APPLIED ON LIVE 2026-09-28 by the owner in the SQL Editor
-- (UPDATE 49; verify: with_password 138, migrated_without_password 0,
-- unmigrated_with_password 0). This file is the record. It is idempotent: it
-- only fills empty values, so re-running it is a no-op.
--
-- WHY 20261010300000 WAS INCOMPLETE. It read user_metadata ? 'full_name' as
-- the "chose a portal password" marker and found 89 of 138. But PortalSetup
-- only started writing full_name to user_metadata on 2026-05-16 (06923f5d).
-- /portal/setup went live 2026-05-05 (2368fa66); the bulk setup invites of
-- 2026-05-07 (7471edb6) only email a /portal/setup link and create no login;
-- the storefront magic-link sign-in first appeared 2026-09-10 (cha-jewels-web
-- fa67875). So every linked login created before 2026-09-10 came from
-- /portal/setup and has a password. The other 49 were created 2026-05-05..14.
-- All 138 migrated customers hold a password; no website-only customer exists
-- as of 2026-09-28.
--
-- From here on the column is written by setup-customer-account (link and new
-- customer) and by resolvePortalAuth Path 0 on any password sign-in
-- (_shared/portal-auth.ts, isPasswordSession) — which covers a password set
-- through Forgot password.

UPDATE public.customers c
   SET portal_password_at = u.created_at
  FROM auth.users u
 WHERE u.id = c.auth_user_id
   AND c.portal_password_at IS NULL
   AND u.created_at < timestamptz '2026-09-10 00:00:00+00';

COMMENT ON COLUMN public.customers.portal_password_at IS 'When this customer chose a portal password at /portal/setup. NULL = no portal password (token-only, or storefront magic-link sign-in only). auth_user_id alone does NOT mean a password: storefront magic-link sign-ins (live since 2026-09-10) set it too. Backfilled 2026-09-28 for every linked login created before 2026-09-10 (only /portal/setup could create one then) or carrying user_metadata.full_name (PortalSetup signUp since 2026-05-16); stamped by setup-customer-account and by resolvePortalAuth Path 0 on any password sign-in from then on. Drives the portal link: set -> sign-in link, otherwise a live token wins.';
