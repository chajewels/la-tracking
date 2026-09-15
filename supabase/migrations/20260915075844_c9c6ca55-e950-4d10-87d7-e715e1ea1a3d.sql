-- Staff bell: a web order's arrival says what arrived.
--
-- FOUND during the 2026-09-15 acceptance run: web layaway CJ-W-900012 was
-- created from the storefront and staff got nothing useful. The customer's
-- confirmation email goes out at once; a one-of-a-kind piece is held and a
-- 72-hour deposit clock starts, and the Hub says almost nothing about it.
--
-- WHAT WAS ACTUALLY WRONG (the premise needed correcting):
-- a notification DID fire. Both order types already notify on INSERT. The
-- difference is that only the CASH trigger learned about the web channel:
--
--   notify_cash_order_created  -- amended by Phase 2 step 2
--     web  -> 'Website order placed' · 'Order CJ-W-900011 — awaiting bank transfer'
--     hub  -> 'Cash order created'   · 'Inv #… created by <staff name>'
--
--   notify_account_created     -- untouched since the baseline, no web branch
--     always -> 'Account created' · 'Inv #TEST-900012 created by Unknown'
--
-- "created by Unknown" is staff_display_name(NULL): nobody in the Hub made it,
-- because the storefront did. So the row a CSR saw named no reference, no
-- amount, no currency and no deadline, and read like a Hub account somebody
-- forgot to attribute. That is the defect.
--
-- THIS MIGRATION gives the layaway notifier the web branch its cash sibling
-- already has, and puts the same five facts in BOTH web bodies — reference,
-- customer, amount, currency, deposit deadline — so the two order types read
-- alike in one bell. Every non-web channel is byte-for-byte unchanged.
--
-- IT CANNOT COST A SALE. Both bodies stay inside the existing
-- BEGIN … EXCEPTION WHEN OTHERS THEN NULL; END wrapper, so a failure in the
-- notification (a null, a bad cast, a missing customer row) is swallowed and
-- the INSERT still commits. This is the established pattern in both functions,
-- not something added here; the new customer-name subselect is the one thing
-- that could newly raise, and it is inside that wrapper.

-- ======================================================= shared body pieces
-- Money the way the Hub displays it (CLAUDE.md DISPLAY RULES): the currency
-- symbol, comma separators, and no trailing .00 on a whole number.
CREATE OR REPLACE FUNCTION public.notify_money_label(p_amount numeric, p_currency text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE WHEN upper(coalesce(p_currency,'JPY')) = 'PHP' THEN '₱' ELSE '¥' END
      || to_char(round(coalesce(p_amount,0)), 'FM999,999,999,999');
$$;

COMMENT ON FUNCTION public.notify_money_label(numeric, text) IS
  'Money for a staff_notifications body: symbol + comma separators, no decimals. Display only — never use it to compute.';

-- The deposit deadline in PHT, because that is the clock staff work to
-- (CLAUDE.md TIMEZONE STANDARD). NULL deadline reads as "no deadline set"
-- rather than an empty gap.
CREATE OR REPLACE FUNCTION public.notify_deadline_label(p_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN p_at IS NULL THEN 'no deposit deadline set'
    ELSE 'deposit by ' || to_char(p_at AT TIME ZONE 'Asia/Manila', 'Mon FMDD HH24:MI') || ' PHT'
  END;
$$;

COMMENT ON FUNCTION public.notify_deadline_label(timestamptz) IS
  'Deposit deadline for a staff_notifications body, rendered in PHT with the suffix shown.';

-- ================================================== 1. web layaway (the gap)
-- account_id IS POPULATED here, deliberately — see the PR for the full
-- reasoning. Two facts drive it:
--   1. The bell's click handler routes on account_id FIRST
--      (StaffNotificationBell handleItemClick: account_id -> /accounts/<id>,
--      else metadata.cash_order_id -> /cash-orders/<id>). It has no branch for
--      a layaway id in metadata, so writing NULL would make this row
--      UNCLICKABLE — a notification a CSR cannot act on from the bell.
--   2. The delete concern does not apply. Every
--      DELETE FROM staff_notifications WHERE account_id = … lives in
--      delete_account_atomic / delete_cash_order_atomic — the HARD-delete
--      paths. No cancel path (terminate_web_order_atomic,
--      expire_web_layaway_atomic, cancel-cash-order) touches notifications, and
--      a web layaway can never be hard-deleted anyway
--      (trg_prevent_web_layaway_delete).
-- The cash branch keeps NULL because account_id means a LAYAWAY id by
-- convention and its click path already goes through metadata.
CREATE OR REPLACE FUNCTION public.notify_account_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
      -- Unchanged from the baseline.
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

-- ============================ 2. web cash order (same five facts, same voice)
-- The web branch already existed and already carried the reference; it said
-- nothing about who, how much, or by when. A CSR reading "Order CJ-W-900011 —
-- awaiting bank transfer" at 2am cannot tell a ¥72,980 order from a ¥628,980
-- one holding a unique piece. Non-web branch unchanged.
CREATE OR REPLACE FUNCTION public.notify_cash_order_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
          'cash_order_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'transfer_due_at', NEW.transfer_due_at)
      );
    ELSE
      -- Unchanged.
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

-- Triggers are unchanged (both already AFTER INSERT and already attached);
-- re-asserted so a fresh rebuild from migrations wires them either way.
DROP TRIGGER IF EXISTS trg_notify_account_created ON public.layaway_accounts;
CREATE TRIGGER trg_notify_account_created
  AFTER INSERT ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.notify_account_created();

DROP TRIGGER IF EXISTS trg_notify_cash_order_created ON public.cash_orders;
CREATE TRIGGER trg_notify_cash_order_created
  AFTER INSERT ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.notify_cash_order_created();