-- Drop the Layer-2 loyalty safety-net triggers + function.
--
-- These were created via the Supabase SQL Editor (never in repo
-- migrations) as a fallback that fired on cash_orders /
-- layaway_accounts status -> 'completed'. The function only
-- INSERTed loyalty_transactions rows without updating
-- loyalty_members scalar counters or creating loyalty_point_lots,
-- producing ghost audit rows that diverge from the canonical
-- balances.
--
-- review-payment-submission -> award-loyalty-points is the sole
-- canonical award path (DP for layaway, isFullyPaid for cash,
-- never on installments). This migration removes the divergent
-- Layer-2 path entirely. IF EXISTS guards keep it idempotent
-- and safe even though the objects are not defined in repo SQL.

DROP TRIGGER IF EXISTS trg_loyalty_on_cash_order_complete ON public.cash_orders;
DROP TRIGGER IF EXISTS trg_loyalty_on_layaway_complete ON public.layaway_accounts;
DROP FUNCTION IF EXISTS public.award_loyalty_points_on_complete();
