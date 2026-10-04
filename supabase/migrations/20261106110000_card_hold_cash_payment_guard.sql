-- Card hold guard on cash_payments (2026-10-04, owner "complete all these
-- remaining items", item 8 of the Square close-out list).
--
-- Before: while a card hold was live on a cash order (cash_order_payment_lock
-- = 'card_payment_unresolved'), the payment_submissions routes were already
-- refused, but three staff routes that write cash_payments directly were not:
-- redeem_store_credit_atomic (store credit), approve_redemption_atomic (a
-- loyalty-points discount) and restore-cash-payment (un-voiding a payment).
-- Any of them lowered the balance under the hold; the later Confirm captured
-- the full held amount, finalize_cash_submission_atomic refused to record a
-- capture larger than the balance, and the money landed as a
-- captured_unallocated exception (caught, bell to staff, but not prevented).
-- The Paidy lock had exactly this gap and was closed by the same trigger in
-- 20261104110000.
--
-- After: the same BEFORE trigger also refuses a new live payment, an un-void,
-- a move onto the order or a relabel while the lock says
-- 'card_payment_unresolved' — except Square's own recording, a row INSERTED
-- with payment_method 'square' (finalize_cash_submission_atomic, which itself
-- checks the captured square_payments row, order, customer and exact amount).
-- The error text starts with 'card_payment_unresolved' so the edge functions
-- can show a plain sentence.
--
-- FUNCTION RULES (CLAUDE.md, Bug #280): the body below is the LIVE body
-- (pg_get_functiondef read 2026-10-04 23:2x JST, md5(prosrc)
-- 4e270015c808542b52dfff9b4b908e70) with one block added after the Paidy
-- check and the comment extended. The guard stops the migration if live has
-- moved; replaying it is a no-op (it accepts the already-patched md5).
-- CREATE OR REPLACE keeps the ACL; the REVOKE is re-asserted anyway.
-- The trigger itself (trg_guard_cash_payment_paidy) is unchanged.

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.guard_cash_payment_paidy()'::regprocedure;
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'STOP — guard_cash_payment_paidy is not on live; nothing changed';
  END IF;
  IF v_md5 NOT IN ('4e270015c808542b52dfff9b4b908e70', '5e1c032aef7ca34e24161f47a0fb0b3f') THEN
    RAISE EXCEPTION 'STOP — guard_cash_payment_paidy has moved on live (md5 %); re-read it before patching. Nothing changed.', v_md5;
  END IF;
END
$guard$;

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
  -- A card hold is live or uncertain (2026-10-04): only Square's own recording
  -- (a row inserted as 'square' by finalize_cash_submission_atomic) passes.
  IF v_lock = 'card_payment_unresolved'
     AND NOT (TG_OP = 'INSERT' AND NEW.payment_method IS NOT DISTINCT FROM 'square') THEN
    RAISE EXCEPTION 'card_payment_unresolved — this order has a card payment waiting for Confirm or Reject. No other payment, store credit or loyalty discount can be added until staff Confirm or Reject the card payment.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_cash_payment_paidy() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_cash_payment_paidy() IS
  'Owner rule 2026-10-04: while Paidy holds a cash order (cash_order_payment_lock paidy_*), or a card hold is live or uncertain (card_payment_unresolved), no other money is added to it — no store credit, loyalty discount, restored payment or manual payment. Paidy''s own recording (payment_method paidy) and Square''s own recording (a row inserted as square) pass.';

-- ---------------------------------------------------------------------------
-- Self-checks: everything above is in place, or the whole migration rolls back.
-- ---------------------------------------------------------------------------
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_cash_payment_paidy()'::regprocedure)
     <> '5e1c032aef7ca34e24161f47a0fb0b3f' THEN
    RAISE EXCEPTION 'STOP — guard_cash_payment_paidy did not store the patched body exactly; rolled back';
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
