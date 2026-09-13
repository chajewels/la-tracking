-- Loyalty level step-down notifications (owner decision 2026-09-13).
-- The RULE is unchanged: lifetime spend sets the level; 180 days without a
-- purchase steps it down one level; loyalty_tiers.requalify_spend_jpy of the
-- EARNED level is the new spend needed to regain it. Only the communication
-- changes: a warning at 150 days, a notice on the day, a restoration email
-- when the member requalifies, and the state shown plainly in the portal and
-- on the storefront account page.

-- A. Dedup marker for the 150-day warning. loyalty-inactivity-check sends the
--    warning once per inactivity period: it fires when this is NULL or older
--    than the member's latest purchase, then stamps now(). A new purchase
--    therefore re-arms the warning without any other write.
ALTER TABLE public.loyalty_members
  ADD COLUMN IF NOT EXISTS stepdown_warned_at timestamptz;
COMMENT ON COLUMN public.loyalty_members.stepdown_warned_at IS
  'When the 150-day level step-down warning was last sent. NULL or older than last_purchase_at = not yet warned for the current inactivity period.';

-- B. Email gate for the new warning (same fail-open pattern as the other
--    loyalty_email_* toggles; Loyalty → Settings shows it).
INSERT INTO public.system_settings (key, value, description)
VALUES ('loyalty_email_stepdown_warning', 'true'::jsonb,
        'Send the level step-down warning 30 days before 180 days of inactivity')
ON CONFLICT (key) DO NOTHING;