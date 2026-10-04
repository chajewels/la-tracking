-- Paidy owner answers (2026-10-04 19:29 JST) — two database rules.
--
-- 1. REASSIGN OWNER REFUSES A PAIDY ORDER (owner: "It's not allowed — the order
--    is from the website and needs a signed-in account, so the account can't be
--    wrong"). Before: reassign_order_owner_atomic's preview said nothing about
--    Paidy and the apply crashed on trg_guard_payment_submission_paidy with the
--    raw "paidy_submission_locked" exception (Paidy rows keep their customer —
--    20261103100000). After: a plain refusal, code paidy_order, in the preview
--    and on apply, for a cash order with ANY Paidy history (a paidy_payments
--    row, a Paidy checkout attempt, or a submission labelled paidy).
--    FUNCTION RULES (CLAUDE.md, Bug #280): md5-guarded IN-PLACE patch of the
--    LIVE body (pg_get_functiondef read 2026-10-04, md5 31956f1e…). Exactly one
--    insertion, after the store_credit refusal, nothing else changes. If live
--    has moved the migration stops and writes nothing; replaying is a no-op
--    (the patched body minus the insertion is the live body). CREATE OR REPLACE
--    keeps the function's ACL.
--
-- 2. NO OTHER MONEY WHILE PAIDY HOLDS THE ORDER (owner rule 2026-10-04: while
--    Paidy is in acceptance the customer can pay no other way; another method
--    only after staff Reject the Paidy payment). Before: the payment lock
--    guarded payment_submissions only, so three staff routes that write
--    cash_payments directly could still pay an order Paidy was processing —
--    redeem_store_credit_atomic (store credit), approve_redemption_atomic (a
--    loyalty-points discount the customer asked for in the portal) and
--    restore-cash-payment (un-voiding a payment). Paidy's later capture then no
--    longer matched the balance, the Hub refused to record it and the customer
--    had been charged in full (docs/OPEN-BUGS.md 2026-10-04). After: a BEFORE
--    trigger on cash_payments refuses a new live non-Paidy payment, or the
--    un-voiding of one, while cash_order_payment_lock says paidy_*. Paidy's own
--    recording (finalize_cash_submission_atomic, payment_method 'paidy') is
--    never refused. A new trigger, so none of the three live bodies changes.

-- ---------------------------------------------------------------------------
-- 1. reassign_order_owner_atomic — the paidy_order refusal.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  c_sig    CONSTANT text := 'public.reassign_order_owner_atomic(text,uuid,uuid,numeric,text,uuid,boolean,boolean)';
  c_before CONSTANT text := '31956f1eea17e17c742d367bb8ef04f0';
  c_anchor CONSTANT text :=
       E'      ''message'', ''Store credit was applied to or issued from this order. Store credit belongs to one customer and cannot move with the order.'');\n'
    || E'  END IF;\n';
  c_insert CONSTANT text :=
       E'\n'
    || E'  -- Paidy (owner 2026-10-04): a Paidy order is a website order paid from the\n'
    || E'  -- customer''s own signed-in account, so it never changes owner. Any Paidy\n'
    || E'  -- history counts (a payment record, a checkout window, a Paidy submission).\n'
    || E'  IF p_kind = ''cash'' AND (\n'
    || E'       EXISTS (SELECT 1 FROM public.paidy_payments pp WHERE pp.cash_order_id = p_order_id)\n'
    || E'    OR EXISTS (SELECT 1 FROM public.paidy_checkout_attempts pa WHERE pa.cash_order_id = p_order_id)\n'
    || E'    OR EXISTS (SELECT 1 FROM public.payment_submissions ps\n'
    || E'                WHERE ps.cash_order_id = p_order_id\n'
    || E'                  AND (ps.payment_method = ''paidy'' OR ps.paidy_payment_id IS NOT NULL))) THEN\n'
    || E'    v_refusals := v_refusals || jsonb_build_object(''code'', ''paidy_order'',\n'
    || E'      ''message'', ''This order was paid, or started to be paid, with Paidy. A Paidy order belongs to the customer who signed in and paid, and cannot change owner.'');\n'
    || E'  END IF;\n';
  v_fn  regprocedure;
  v_def text;
  v_new text;
BEGIN
  v_fn := to_regprocedure(c_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', c_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  -- Already patched: the body minus the insertion is the expected live body.
  IF position(c_anchor || c_insert IN v_def) > 0
     AND md5(replace(v_def, c_anchor || c_insert, c_anchor)) = c_before THEN
    RAISE NOTICE '% already carries the paidy_order refusal — no change', c_sig;
  ELSE
    IF md5(v_def) <> c_before THEN
      RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', c_sig, md5(v_def);
    END IF;
    IF (length(v_def) - length(replace(v_def, c_anchor, ''))) / length(c_anchor) <> 1 THEN
      RAISE EXCEPTION 'STOP — % does not contain the patch anchor exactly once; nothing changed', c_sig;
    END IF;
    v_new := replace(v_def, c_anchor, c_anchor || c_insert);
    EXECUTE v_new;
    IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
      RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', c_sig;
    END IF;
  END IF;
END
$patch$;

-- ---------------------------------------------------------------------------
-- 2. cash_payments guard — nothing else while Paidy holds the order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_cash_payment_paidy()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_lock text;
BEGIN
  -- Only money that would newly count on a cash order: a live (not voided)
  -- insert, an un-void, a live row moved onto another order, or a relabel.
  -- Paidy's own recording is the one allowed writer; a row only counts as
  -- Paidy's if it was inserted as 'paidy' (never relabelled into it).
  IF NEW.cash_order_id IS NULL OR NEW.voided_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.payment_method IS NOT DISTINCT FROM 'paidy' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NULL
     AND OLD.cash_order_id IS NOT DISTINCT FROM NEW.cash_order_id
     AND OLD.payment_method IS NOT DISTINCT FROM NEW.payment_method THEN
    RETURN NEW;
  END IF;
  -- Serialise with the Paidy writers, which lock the order row too.
  PERFORM 1 FROM public.cash_orders WHERE id = NEW.cash_order_id FOR UPDATE;
  v_lock := public.cash_order_payment_lock(NEW.cash_order_id);
  IF v_lock LIKE 'paidy%' THEN
    RAISE EXCEPTION 'paidy_in_progress: % — this order is being paid with Paidy. No other payment, store credit or loyalty discount can be added until staff Reject the Paidy payment.', v_lock
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_cash_payment_paidy() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_cash_payment_paidy() IS
  'Owner rule 2026-10-04: while Paidy holds a cash order (cash_order_payment_lock paidy_*), no other money is added to it — no store credit, loyalty discount, restored payment or manual payment. Paidy''s own recording (payment_method paidy) passes.';
DROP TRIGGER IF EXISTS trg_guard_cash_payment_paidy ON public.cash_payments;
CREATE TRIGGER trg_guard_cash_payment_paidy
  BEFORE INSERT OR UPDATE OF voided_at, cash_order_id, payment_method ON public.cash_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_payment_paidy();

-- ---------------------------------------------------------------------------
-- Self-checks: everything above is in place, or the whole migration rolls back.
-- ---------------------------------------------------------------------------
DO $check$
BEGIN
  IF position('''paidy_order''' IN pg_get_functiondef(
       'public.reassign_order_owner_atomic(text,uuid,uuid,numeric,text,uuid,boolean,boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — reassign_order_owner_atomic has no paidy_order refusal; rolled back';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_cash_payment_paidy'
                  AND tgrelid = 'public.cash_payments'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'STOP — trg_guard_cash_payment_paidy is missing; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.guard_cash_payment_paidy()', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — guard_cash_payment_paidy is executable by authenticated; rolled back';
  END IF;
END
$check$;
