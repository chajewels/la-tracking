-- Loyalty enrollment source (2026-09-17). Applied live via SQL Editor.
ALTER TABLE public.loyalty_members
  ADD COLUMN IF NOT EXISTS enrollment_source text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.loyalty_members
  ADD CONSTRAINT loyalty_members_enrollment_source_check CHECK (enrollment_source IN
  ('portal_signup','portal_join','shopify_checkout','storefront_checkout',
   'storefront_join','legacy_import','unknown'));
