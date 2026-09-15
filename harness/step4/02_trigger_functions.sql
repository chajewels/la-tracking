-- ===========================================================================
-- Trigger + helper functions — bodies copied VERBATIM from the live database
-- (pg_get_functiondef, 2026-09-15). Not rewritten, not simplified.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_cash_orders_updated_at()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE OR REPLACE FUNCTION public.staff_display_name(p_user_id uuid)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT full_name FROM public.profiles WHERE user_id = p_user_id), 'Unknown')
$function$;

CREATE OR REPLACE FUNCTION public.staff_notify(p_type text, p_title text, p_body text, p_account_id uuid, p_customer_id uuid, p_invoice text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
  VALUES (p_type, p_title, p_body, p_account_id, p_customer_id, p_invoice, p_meta)
$function$;

CREATE OR REPLACE FUNCTION public.notify_deadline_label(p_at timestamp with time zone)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_at IS NULL THEN 'no deposit deadline set'
    ELSE 'deposit by ' || to_char(p_at AT TIME ZONE 'Asia/Manila', 'Mon FMDD HH24:MI') || ' PHT'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_money_label(p_amount numeric, p_currency text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN upper(coalesce(p_currency,'JPY')) = 'PHP' THEN '₱' ELSE '¥' END
      || to_char(round(coalesce(p_amount,0)), 'FM999,999,999,999');
$function$;

CREATE OR REPLACE FUNCTION public.is_paid_or_completed_order(p_status text, p_total_paid numeric, p_customer_id uuid, p_has_live_payment boolean)
 RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  SELECT NOT COALESCE((SELECT c.is_test FROM public.customers c WHERE c.id = p_customer_id), false)
     AND (p_status = 'completed' OR COALESCE(p_total_paid, 0) > 0 OR COALESCE(p_has_live_payment, false));
$function$;

CREATE OR REPLACE FUNCTION public.autofill_sales_log_support_verifier()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.sales_log sl
  SET
    support  = COALESCE(sl.support,  ca.name),
    verifier = COALESCE(sl.verifier, ca.name)
  FROM public.commission_agents ca
  WHERE sl.invoice_number = NEW.invoice_number
    AND ca.user_id        = NEW.created_by_user_id
    AND ca.active         = true;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_plan_minimum_amount()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE
  v_min_jpy     numeric;
  v_min_php     numeric;
  v_label       text;
BEGIN
  IF NEW.payment_plan_months IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT min_amount_jpy, min_amount_php, display_label
  INTO v_min_jpy, v_min_php, v_label
  FROM plan_configurations
  WHERE plan_months = NEW.payment_plan_months;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Plan duration % months is not configured. Add it to plan_configurations first.',
      NEW.payment_plan_months;
  END IF;

  IF NEW.currency = 'JPY' AND v_min_jpy > 0 THEN
    IF NEW.total_amount < v_min_jpy THEN
      RAISE EXCEPTION
        '% plan requires a minimum order of ¥%. Submitted amount is ¥%.',
        v_label,
        TO_CHAR(v_min_jpy,     'FM999,999,999'),
        TO_CHAR(NEW.total_amount, 'FM999,999,999');
    END IF;
  END IF;

  IF NEW.currency = 'PHP' AND v_min_php > 0 THEN
    IF NEW.total_amount < v_min_php THEN
      RAISE EXCEPTION
        '% plan requires a minimum order of ₱%. Submitted amount is ₱%.',
        v_label,
        TO_CHAR(v_min_php,      'FM999,999,999'),
        TO_CHAR(NEW.total_amount, 'FM999,999,999');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_test_invoice_prefix()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
DECLARE
  v_customer_is_test boolean;
BEGIN
  SELECT c.is_test INTO v_customer_is_test
  FROM customers c WHERE c.id = NEW.customer_id;

  IF v_customer_is_test THEN
    NEW.is_test := true;
    IF NEW.invoice_number ~ '^[0-9]+$' THEN
      NEW.invoice_number := 'TEST-' || NEW.invoice_number;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_admin_table_change()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO audit_logs (
    entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id
  ) VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    TG_OP,
    CASE WHEN TG_OP = 'DELETE' OR TG_OP = 'UPDATE'
         THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP = 'INSERT' OR TG_OP = 'UPDATE'
         THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.note_account_status_change()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_note text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  v_note := CASE NEW.status::text
    WHEN 'forfeited'        THEN 'Account forfeited (was ' || OLD.status::text || ')'
    WHEN 'final_forfeited'  THEN 'Account FINAL FORFEITED — permanent, no reactivation (was ' || OLD.status::text || ')'
    WHEN 'extension_active' THEN 'Account reactivated to extension'
                                 || COALESCE(' — extension ends ' || NEW.extension_end_date::text, '')
    WHEN 'completed'        THEN 'Account completed — fully paid'
    WHEN 'overdue'          THEN 'Account moved to overdue (was ' || OLD.status::text || ')'
    WHEN 'active'           THEN 'Account status active (was ' || OLD.status::text || ')'
    ELSE 'Account status ' || OLD.status::text || ' → ' || NEW.status::text
  END;

  INSERT INTO public.account_notes (account_id, note_text, created_by_user_id, created_by_name)
  VALUES (NEW.id, v_note, NULL, 'System');
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.notify_account_created()
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
        'account_created', 'Website layaway placed',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' over ' || COALESCE(NEW.payment_plan_months::text, '?') || ' months · '
          || public.notify_deadline_label(NEW.transfer_due_at),
        NEW.id, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'layaway_account_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'downpayment_amount', NEW.downpayment_amount,
          'transfer_due_at', NEW.transfer_due_at)
      );
    ELSE
      PERFORM public.staff_notify(
        'account_created', 'Account created',
        'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
        NEW.id, NEW.customer_id, NEW.invoice_number, '{}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.prevent_base_amount_change()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.bypass_immutable_schedule_cols', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.base_installment_amount IS DISTINCT FROM OLD.base_installment_amount THEN
    RAISE EXCEPTION
      'base_installment_amount is immutable after creation. Attempted change from % to % on schedule %',
      OLD.base_installment_amount, NEW.base_installment_amount, OLD.id;
  END IF;
  IF NEW.installment_number IS DISTINCT FROM OLD.installment_number THEN
    RAISE EXCEPTION
      'installment_number is immutable after creation on schedule %', OLD.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_paid_order_delete()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE
  v_live_payment boolean;
BEGIN
  IF TG_TABLE_NAME = 'layaway_accounts' THEN
    SELECT EXISTS (SELECT 1 FROM public.payments p WHERE p.account_id = OLD.id AND p.voided_at IS NULL) INTO v_live_payment;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.cash_payments p WHERE p.cash_order_id = OLD.id AND p.voided_at IS NULL) INTO v_live_payment;
  END IF;
  IF public.is_paid_or_completed_order(OLD.status::text, OLD.total_paid, OLD.customer_id, v_live_payment) THEN
    RAISE EXCEPTION 'paid_order_delete_forbidden: % is % with % received — cancel it with a reason or void the payment; completed or paid orders are never deleted',
      OLD.invoice_number, OLD.status, OLD.total_paid
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_paid_row_modification()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = 'paid' THEN
    IF current_setting('app.allow_paid_row_edit', true) = 'true' THEN
      RETURN NEW;
    END IF;
    IF NEW.paid_amount <= OLD.paid_amount THEN
      RETURN NEW;
    END IF;
    IF NEW.paid_amount > OLD.paid_amount
      AND NEW.paid_amount <=
        OLD.base_installment_amount
        + COALESCE(OLD.penalty_amount, 0)
        + COALESCE(OLD.carried_amount, 0) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Schedule row % is paid and frozen. '
      'Cannot increase paid_amount beyond ceiling on a paid row.',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_total_amount_change()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
BEGIN
  IF NEW.total_amount = OLD.total_amount THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.allow_total_amount_edit', true) = 'true' THEN
    RETURN NEW;
  END IF;
  SELECT has_role(auth.uid(), 'admin') INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION
      'total_amount can only be modified by admin. Use add-installment or add-service edge functions.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_web_layaway_delete()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.source_channel = 'web' THEN
    RAISE EXCEPTION 'web_layaway_delete_forbidden: % is a web layaway — it expires or runs its lifecycle, it is never deleted',
      COALESCE(OLD.web_reference, OLD.invoice_number)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION public.set_completed_at()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    NEW.completed_at = now();
  END IF;
  IF NEW.status != 'completed' AND OLD.status = 'completed' THEN
    NEW.completed_at = NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_schedule_chronology()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE
  prev_due date;
BEGIN
  IF NEW.installment_number > 1 THEN
    SELECT due_date INTO prev_due
    FROM public.layaway_schedule
    WHERE account_id = NEW.account_id
      AND installment_number = NEW.installment_number - 1
      AND status != 'cancelled';

    IF prev_due IS NOT NULL AND NEW.due_date <= prev_due THEN
      RAISE EXCEPTION 'Schedule chronology violation: installment % due_date (%) must be after installment % due_date (%)',
        NEW.installment_number, NEW.due_date, NEW.installment_number - 1, prev_due;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_schedule_deletion()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.allow_schedule_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Direct deletion of layaway_schedule rows blocked. Bug #6 Stage 2 enforcement (2026-05-17). Use delete-installment edge function or delete_account_atomic RPC.'
    USING HINT = 'If a legitimate operation requires direct deletion, prefix with: SET LOCAL app.allow_schedule_delete = ''on'';',
          ERRCODE = '42501';
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_backup_payment()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_number text;
  v_customer_name  text;
BEGIN
  SELECT la.invoice_number, c.full_name
  INTO v_invoice_number, v_customer_name
  FROM layaway_accounts la
  LEFT JOIN customers c ON c.id = la.customer_id
  WHERE la.id = NEW.account_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO payment_history_backup (
      payment_id, account_id, invoice_number, customer_name,
      amount, currency, payment_date, payment_method,
      submission_type, notes, status, approved_by,
      approved_at, event_type
    ) VALUES (
      NEW.id, NEW.account_id, v_invoice_number, v_customer_name,
      NEW.amount_paid, NEW.currency::text, NEW.date_paid, NEW.payment_method,
      NEW.submitted_by_type, NEW.remarks, 'confirmed', NEW.entered_by_user_id,
      NEW.created_at, 'approved'
    );
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
    INSERT INTO payment_history_backup (
      payment_id, account_id, invoice_number, customer_name,
      amount, currency, payment_date, payment_method,
      submission_type, notes, status, voided_by,
      voided_at, void_reason, event_type
    ) VALUES (
      NEW.id, NEW.account_id, v_invoice_number, v_customer_name,
      NEW.amount_paid, NEW.currency::text, NEW.date_paid, NEW.payment_method,
      NEW.submitted_by_type, NEW.remarks, 'voided', NEW.voided_by_user_id,
      NEW.voided_at, NEW.void_reason, 'voided'
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_submission_created()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice text;
  v_label   text;
BEGIN
  BEGIN
    SELECT invoice_number INTO v_invoice
      FROM public.layaway_accounts WHERE id = NEW.account_id;
    v_label := v_invoice;
    IF v_invoice IS NULL AND NEW.cash_order_id IS NOT NULL THEN
      SELECT invoice_number,
             CASE WHEN source_channel = 'web' AND web_reference IS NOT NULL THEN web_reference ELSE invoice_number END
        INTO v_invoice, v_label
        FROM public.cash_orders WHERE id = NEW.cash_order_id;
    END IF;
    PERFORM public.staff_notify(
      'submission_created',
      'New payment submission',
      COALESCE(
        NEW.sender_name,
        (SELECT full_name FROM public.customers WHERE id = NEW.customer_id),
        'Unknown sender'
      )
      || ' submitted ' || COALESCE(NEW.submitted_amount::text, '?')
      || COALESCE(' · ' || CASE WHEN v_label LIKE 'CJ-W-%' THEN 'Order ' ELSE 'Inv #' END || v_label, ''),
      NEW.account_id,
      NEW.customer_id,
      v_invoice,
      jsonb_build_object('submission_id', NEW.id, 'method', NEW.payment_method)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.auto_waive_same_day_penalties()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_date date; v_pen RECORD; v_sched numeric; v_base numeric;
        v_carried numeric; v_pen_acct numeric; v_svc numeric; v_paid numeric;
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;
  BEGIN
    v_date := (NEW.created_at AT TIME ZONE 'Asia/Tokyo')::date;
    FOR v_pen IN
      SELECT * FROM penalty_fees
      WHERE account_id = NEW.account_id AND status = 'unpaid' AND penalty_date = v_date
    LOOP
      INSERT INTO penalty_waiver_requests (
        account_id, schedule_id, penalty_fee_id, penalty_amount,
        requested_by_user_id, reason, status, approved_at, is_auto, source_submission_id)
      VALUES (v_pen.account_id, v_pen.schedule_id, v_pen.id, v_pen.penalty_amount,
        NULL, 'Auto-waived: payment submitted on the same date the penalty was applied.',
        'approved', now(), true, NEW.id);
      UPDATE penalty_fees SET status = 'waived', waived_at = now() WHERE id = v_pen.id;
      SELECT COALESCE(SUM(penalty_amount),0) INTO v_sched FROM penalty_fees
        WHERE schedule_id = v_pen.schedule_id AND status::text <> 'waived';
      SELECT base_installment_amount, COALESCE(carried_amount,0) INTO v_base, v_carried
        FROM layaway_schedule WHERE id = v_pen.schedule_id;
      UPDATE layaway_schedule
        SET penalty_amount = v_sched, total_due_amount = v_base + v_sched + v_carried
        WHERE id = v_pen.schedule_id;
      SELECT COALESCE(SUM(penalty_amount),0) INTO v_pen_acct FROM penalty_fees
        WHERE account_id = v_pen.account_id AND status::text <> 'waived';
      SELECT COALESCE(SUM(amount),0) INTO v_svc FROM account_services
        WHERE account_id = v_pen.account_id;
      SELECT COALESCE(SUM(amount_paid),0) INTO v_paid FROM payments
        WHERE account_id = v_pen.account_id AND voided_at IS NULL;
      UPDATE layaway_accounts
        SET remaining_balance = GREATEST(0, total_amount + v_pen_acct + v_svc - v_paid)
        WHERE id = v_pen.account_id;
      INSERT INTO audit_logs (entity_type, entity_id, action, new_value_json)
      VALUES ('penalty_waiver', v_pen.account_id, 'auto_waiver_approved',
        jsonb_build_object('penalty_fee_id', v_pen.id, 'schedule_id', v_pen.schedule_id,
          'penalty_amount', v_pen.penalty_amount, 'penalty_date', v_pen.penalty_date,
          'submission_id', NEW.id, 'submission_date_jst', v_date));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.notify_website_revalidate()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ DECLARE v_product_id uuid; v_collection_id uuid; v_product_slug text; v_collection_slug text; v_key text; BEGIN IF TG_TABLE_NAME = 'website_products' THEN v_product_id := COALESCE(NEW.id, OLD.id); v_product_slug := COALESCE(NEW.slug, OLD.slug); ELSIF TG_TABLE_NAME = 'website_collections' THEN v_collection_id := COALESCE(NEW.id, OLD.id); v_collection_slug := COALESCE(NEW.slug, OLD.slug); ELSIF TG_TABLE_NAME = 'website_product_variants' THEN v_product_id := COALESCE(NEW.product_id, OLD.product_id); ELSIF TG_TABLE_NAME = 'website_product_media' THEN SELECT product_id INTO v_product_id FROM website_product_variants WHERE id = COALESCE(NEW.variant_id, OLD.variant_id); ELSIF TG_TABLE_NAME = 'website_collection_products' THEN v_product_id := COALESCE(NEW.product_id, OLD.product_id); v_collection_id := COALESCE(NEW.collection_id, OLD.collection_id); END IF; IF v_product_id IS NOT NULL AND v_product_slug IS NULL THEN SELECT slug INTO v_product_slug FROM website_products WHERE id = v_product_id; END IF; IF v_collection_id IS NOT NULL AND v_collection_slug IS NULL THEN SELECT slug INTO v_collection_slug FROM website_collections WHERE id = v_collection_id; END IF; SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'; IF v_key IS NOT NULL AND (v_product_slug IS NOT NULL OR v_collection_slug IS NOT NULL) THEN PERFORM net.http_post(url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key), body := jsonb_strip_nulls(jsonb_build_object('productSlug', v_product_slug, 'collectionSlug', v_collection_slug))); END IF; RETURN COALESCE(NEW, OLD); END $function$;

CREATE OR REPLACE FUNCTION public.log_schedule_deletion()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_admin_id uuid; v_jwt jsonb; v_old_row_json text;
BEGIN
  BEGIN
    v_jwt := current_setting('request.jwt.claims', true)::jsonb;
    v_admin_id := (v_jwt->>'sub')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_admin_id := NULL;
  END;
  v_old_row_json := json_build_object(
    'installment_number', OLD.installment_number, 'due_date', OLD.due_date,
    'base_installment_amount', OLD.base_installment_amount, 'penalty_amount', OLD.penalty_amount,
    'total_due_amount', OLD.total_due_amount, 'paid_amount', OLD.paid_amount,
    'currency', OLD.currency, 'status', OLD.status, 'carried_amount', OLD.carried_amount,
    'carried_from_schedule_id', OLD.carried_from_schedule_id,
    'carried_by_payment_id', OLD.carried_by_payment_id, 'generated_at', OLD.generated_at,
    'updated_at', OLD.updated_at, 'session_user', session_user, 'current_user', current_user
  )::text;
  INSERT INTO public.schedule_audit_log (
    account_id, schedule_id, admin_user_id, action, field_changed, old_value, new_value, reason
  ) VALUES (
    OLD.account_id, OLD.id, v_admin_id, 'forensic_delete', 'row_deleted', v_old_row_json, NULL,
    CASE WHEN v_admin_id IS NULL THEN 'Cascade or direct SQL delete (no JWT context)'
         ELSE 'Delete via authenticated context' END
  );
  RETURN OLD;
END;
$function$;
