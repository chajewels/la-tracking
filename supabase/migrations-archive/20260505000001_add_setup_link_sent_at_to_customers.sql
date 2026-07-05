-- Phase B Step 5-1: Add setup_link_sent_at to customers
--
-- Tracks the last time an admin sent a portal setup invitation email
-- to this customer. NULL means no invite has been sent yet. Updated
-- by the frontend via direct PostgREST UPDATE after a successful
-- send-transactional-email call (see Step 5-2).
--
-- This column is informational only — admin UI displays "Last sent:
-- X ago" and uses it to detect duplicate sends. It does NOT gate any
-- backend behavior.

ALTER TABLE public.customers
  ADD COLUMN setup_link_sent_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.customers.setup_link_sent_at IS
  'Timestamp of last admin-initiated portal setup invitation email. NULL = never sent.';
