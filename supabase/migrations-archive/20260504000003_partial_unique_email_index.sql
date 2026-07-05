-- Enforce email uniqueness only on customers with auth accounts.
-- Customers without auth (legacy token auth, including Cabalza
-- family with shared email) keep their duplicates.
-- LOWER() for case-insensitive uniqueness.
-- APPLIED TO PRODUCTION: 2026-05-04 via SQL Editor (ahead of plan).

CREATE UNIQUE INDEX customers_email_unique_when_authed
  ON public.customers(LOWER(email))
  WHERE auth_user_id IS NOT NULL;
