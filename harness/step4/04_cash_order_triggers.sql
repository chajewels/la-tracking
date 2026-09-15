DROP TRIGGER IF EXISTS auto_generate_customer_code ON public.customers;  -- not modelled; fixtures set customer_code directly

CREATE OR REPLACE FUNCTION public.clear_cash_order_expiry_on_complete()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_cash_order_created()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_who text;
BEGIN
  BEGIN
    IF NEW.source_channel = 'web' THEN
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'Website order placed',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' paid in full · ' || public.notify_deadline_label(NEW.transfer_due_at),
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'cash_order_id', NEW.id, 'source_channel', 'web',
          'web_reference', NEW.web_reference, 'currency', NEW.currency::text,
          'total_amount', NEW.total_amount, 'transfer_due_at', NEW.transfer_due_at)
      );
    ELSE
      PERFORM public.staff_notify(
        'account_created', 'Cash order created',
        'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object('cash_order_id', NEW.id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.prevent_web_order_delete()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.source_channel = 'web' THEN
    RAISE EXCEPTION 'web_order_delete_forbidden: % is a web order — cancel it, never delete it (order history, stock hold and points reversal depend on the row)',
      COALESCE(OLD.web_reference, OLD.invoice_number)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_web_order_payment_status()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.source_channel IS DISTINCT FROM 'web' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'completed' THEN
    NEW.payment_status := 'paid';
    NEW.transfer_due_at := NULL;
  ELSIF NEW.status IN ('cancelled', 'expired') THEN
    NEW.payment_status := 'cancelled';
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER trg_clear_cash_order_expiry BEFORE UPDATE ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION clear_cash_order_expiry_on_complete();
CREATE TRIGGER trg_notify_cash_order_created AFTER INSERT ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION notify_cash_order_created();
CREATE TRIGGER trg_prevent_web_order_delete BEFORE DELETE ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION prevent_web_order_delete();
CREATE TRIGGER trg_sync_web_order_payment_status BEFORE UPDATE ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION sync_web_order_payment_status();
CREATE TRIGGER trg_test_invoice_prefix_cash BEFORE INSERT OR UPDATE OF invoice_number, customer_id ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION enforce_test_invoice_prefix();
