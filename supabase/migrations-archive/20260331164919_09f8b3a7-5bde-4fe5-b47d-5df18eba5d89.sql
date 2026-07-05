
-- Step 1: Replace check_allocation_ceiling to respect bypass flag
CREATE OR REPLACE FUNCTION public.check_allocation_ceiling()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_base numeric;
  v_penalty numeric;
  v_carried numeric;
  v_ceiling numeric;
  v_total numeric;
BEGIN
  -- Allow authorized admin overrides (e.g. Keep as Partial surplus)
  IF current_setting('app.bypass_allocation_ceiling', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT 
    COALESCE(base_installment_amount, 0),
    COALESCE(penalty_amount, 0),
    COALESCE(carried_amount, 0)
  INTO v_base, v_penalty, v_carried
  FROM layaway_schedule
  WHERE id = NEW.schedule_id;

  v_ceiling := v_base + v_penalty + v_carried;

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_total
  FROM payment_allocations
  WHERE schedule_id = NEW.schedule_id
    AND id != NEW.id;

  v_total := v_total + NEW.allocated_amount;

  IF v_total > v_ceiling THEN
    RAISE EXCEPTION 'Allocation of % exceeds row ceiling of % for schedule %',
      v_total, v_ceiling, NEW.schedule_id;
  END IF;

  RETURN NEW;
END;
$function$;

-- Step 2: Create the admin override RPC
CREATE OR REPLACE FUNCTION public.admin_keep_allocation_override(p_allocation_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM set_config('app.bypass_allocation_ceiling', 'on', true);
  UPDATE payment_allocations
  SET allocated_amount = p_amount
  WHERE id = p_allocation_id;
END;
$$;
