CREATE OR REPLACE FUNCTION public.register_invoice_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source text;
  v_holder text;
BEGIN
  -- Which table are we defending? Derived from TG_TABLE_NAME so one function
  -- serves both and the two can never drift apart.
  v_source := CASE TG_TABLE_NAME
                WHEN 'cash_orders'      THEN 'cash_order'
                WHEN 'layaway_accounts' THEN 'layaway_account'
              END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'register_invoice_number() attached to unexpected table %', TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Release the number so a deleted typo does not burn it forever. Scoped by
    -- order_id as well as the number, so a row whose registry entry has already
    -- been claimed by something else is left alone.
    DELETE FROM public.invoice_numbers
     WHERE invoice_number = OLD.invoice_number
       AND source = v_source
       AND order_id = OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number THEN
    RETURN NEW;  -- nothing to do; the number did not move
  END IF;

  IF TG_OP = 'UPDATE' THEN
    DELETE FROM public.invoice_numbers
     WHERE invoice_number = OLD.invoice_number
       AND source = v_source
       AND order_id = OLD.id;
  END IF;

  -- Claim the new number. A collision names WHERE the number already lives,
  -- because "already exists" without that is the message a CSR cannot act on.
  SELECT source INTO v_holder
    FROM public.invoice_numbers WHERE invoice_number = NEW.invoice_number;

  IF v_holder IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_number % already exists on %', NEW.invoice_number, v_holder
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.invoice_numbers (invoice_number, source, order_id)
  VALUES (NEW.invoice_number, v_source, NEW.id);

  RETURN NEW;
END
$function$;
