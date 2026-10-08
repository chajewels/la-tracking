-- 20261130100000_paidy_pr5_billing_choice.sql
-- Paidy reassessment PR 5 (PA15B), owner go 2026-10-09 00:59 JST
-- (plan: claude/paidy-pr5-truthfulness-plan-2026-10-09.md).
--
-- The customer CHOOSES where Paidy bills her, separately from the delivery
-- address (owner 2026-10-08 17:17 JST). The website's POST
-- /orders/:id/paidy/start validates her choice (one of HER complete Japanese
-- address-book entries) and records here which entry that Paidy window sent,
-- so a later question "which billing address did Paidy get?" has an answer.
--
-- ON DELETE SET NULL, like every customer_addresses FK (CLAUDE.md "CUSTOMER
-- ADDRESSES"): the attempt keeps existing if she later removes the entry.
-- No function body changes; no grants change (the table's RLS / grants stand).
-- Re-running is a no-op.

ALTER TABLE public.paidy_checkout_attempts
  ADD COLUMN IF NOT EXISTS billing_address_id uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.paidy_checkout_attempts.billing_address_id IS
  'PA15B (2026-10-09): the customer_addresses entry this Paidy window sent as buyer_data.billing_address — her own choice on the order page, or the preselected default. NULL = her customer record was used, or the entry was later removed.';

DO $$
BEGIN
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'paidy_checkout_attempts' AND column_name = 'billing_address_id';
  IF NOT FOUND THEN RAISE EXCEPTION 'self-check paidy_checkout_attempts.billing_address_id missing'; END IF;
END $$;
