-- Add auth_user_id FK column linking customers to auth.users.
-- ON DELETE SET NULL — if auth account is deleted, customer
-- record survives, just unlinked.
-- APPLIED TO PRODUCTION: 2026-05-04 via SQL Editor (ahead of plan).

ALTER TABLE public.customers
  ADD COLUMN auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX idx_customers_auth_user_id
  ON public.customers(auth_user_id)
  WHERE auth_user_id IS NOT NULL;
