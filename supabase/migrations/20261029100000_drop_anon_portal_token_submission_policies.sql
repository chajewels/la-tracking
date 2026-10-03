-- Drop the three anon RLS policies on payment_submissions that matched the
-- x-portal-token request header / portal_token column.
--
-- WHY (2026-10-03, Lovable scan follow-up). The portal PIN moved to the server
-- the same day: every portal edge function refuses a bare link token with
-- pin_required. These three policies were the one path left that a bare link
-- could still reach — the browser read and cancelled the customer's own
-- pending cash submissions straight through PostgREST. CashOrdersSection now
-- gets pending submissions from customer-portal (cash_pending_submissions)
-- and cancels through edit-payment-submission, both behind the PIN session.
-- The INSERT policy had no caller: submit-cash-payment / submit-payment write
-- with the service role and the storefront writes through `website`.
--
-- After this, the anon role has NO policy on payment_submissions. Staff
-- (authenticated) policies are untouched.

DROP POLICY IF EXISTS "Anon can view own submissions by token" ON public.payment_submissions;
DROP POLICY IF EXISTS "Anon can cancel cash order submissions" ON public.payment_submissions;
DROP POLICY IF EXISTS "Anon can insert submissions with token" ON public.payment_submissions;
