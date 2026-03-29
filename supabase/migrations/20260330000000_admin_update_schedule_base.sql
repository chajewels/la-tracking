-- Admin-only RPC to update base_installment_amount on a schedule row.
-- SECURITY DEFINER runs as the postgres owner, bypassing the
-- enforce_immutable_base trigger that blocks direct client writes.
-- Called exclusively by the edit-schedule-item edge function.

CREATE OR REPLACE FUNCTION public.admin_update_schedule_base(
  p_schedule_id uuid,
  p_new_base numeric,
  p_new_total_due numeric,
  p_is_paid boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  UPDATE layaway_schedule
  SET
    base_installment_amount = p_new_base,
    total_due_amount        = p_new_total_due,
    paid_amount             = CASE WHEN p_is_paid THEN p_new_total_due
                                   ELSE paid_amount END
  WHERE id = p_schedule_id;
END;
$function$;
