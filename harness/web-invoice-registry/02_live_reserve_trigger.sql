CREATE OR REPLACE FUNCTION public.checkout_quotes_reserve_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.mode = 'layaway' AND NEW.reserved_invoice_seq IS NULL THEN
    NEW.reserved_invoice_seq := nextval('public.web_order_number_seq');
  END IF;
  RETURN NEW;
END
$function$;
