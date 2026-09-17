-- 2026-09-17: edit_loyalty_amount permission + trg_guard_loyalty_jpy_amount. Applied live via SQL Editor.

INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
  ('admin'::app_role,      'edit_loyalty_amount', true),
  ('staff'::app_role,      'edit_loyalty_amount', false),
  ('finance'::app_role,    'edit_loyalty_amount', false),
  ('csr'::app_role,        'edit_loyalty_amount', false),
  ('live_agent'::app_role, 'edit_loyalty_amount', false)
ON CONFLICT (role, permission_key) DO UPDATE SET is_allowed = EXCLUDED.is_allowed;

INSERT INTO public.user_permission_overrides (user_id, permission_key, granted)
SELECT p.user_id, 'edit_loyalty_amount', true FROM public.profiles p
 WHERE p.user_id = '69095b5d-3a96-4b67-adad-7cbf9d6c2aff'
ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = true;

CREATE OR REPLACE FUNCTION public.guard_loyalty_jpy_amount_edit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NEW.loyalty_jpy_amount IS NOT DISTINCT FROM OLD.loyalty_jpy_amount THEN
    RETURN NEW;
  END IF;
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.has_permission(v_uid, 'edit_loyalty_amount') THEN
    RAISE EXCEPTION 'You do not have permission to change the loyalty amount.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.loyalty_jpy_amount IS NOT NULL AND NEW.loyalty_jpy_amount < 0 THEN
    RAISE EXCEPTION 'The loyalty amount cannot be negative.' USING ERRCODE = '22023';
  END IF;
  IF TG_TABLE_NAME = 'layaway_accounts' THEN
    IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
               WHERE t.account_id = NEW.id AND t.transaction_type = 'earned') THEN
      RAISE EXCEPTION 'Loyalty points were already awarded on this order, so its loyalty amount can no longer be changed here.'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
               WHERE t.cash_order_id = NEW.id AND t.transaction_type = 'earned') THEN
      RAISE EXCEPTION 'Loyalty points were already awarded on this order, so its loyalty amount can no longer be changed here.'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_loyalty_jpy_amount_edit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_loyalty_jpy_amount ON public.layaway_accounts;
CREATE TRIGGER trg_guard_loyalty_jpy_amount
  BEFORE UPDATE OF loyalty_jpy_amount ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_loyalty_jpy_amount_edit();

DROP TRIGGER IF EXISTS trg_guard_loyalty_jpy_amount ON public.cash_orders;
CREATE TRIGGER trg_guard_loyalty_jpy_amount
  BEFORE UPDATE OF loyalty_jpy_amount ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_loyalty_jpy_amount_edit();
