DROP TRIGGER IF EXISTS trg_loyalty_on_cash_order_complete ON cash_orders;
DROP TRIGGER IF EXISTS trg_loyalty_on_layaway_complete ON layaway_accounts;
DROP FUNCTION IF EXISTS public.award_loyalty_points_on_complete();