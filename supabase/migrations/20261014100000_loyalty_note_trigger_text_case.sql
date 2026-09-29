-- Lovable scan 2026-09-29, finding L1: loyalty revokes are refused.
--
-- note_loyalty_transaction() (AFTER INSERT trigger trg_note_loyalty_transaction
-- on loyalty_transactions) writes a line into account_notes for every loyalty
-- row tied to an order. Its CASE compares NEW.transaction_type (enum
-- loyalty_transaction_type) with the literal 'restored', which is NOT a value
-- of that enum. Postgres casts every WHEN literal to the enum, so any row that
-- reaches the CASE fails with
--   22P02 invalid input value for enum loyalty_transaction_type: "restored"
-- and the whole INSERT is rolled back. Rows that reach the CASE: every type
-- except earned/redeemed, with an account_id or cash_order_id — i.e. revoked,
-- adjusted, refunded, birthday_bonus on an order.
--
-- Effect on live (verified 2026-09-29 against the live DB):
--   - revoke_loyalty_points raises, so manual-forfeit / auto-forfeit-settlement
--     log the failure and leave the points (TEST-900013, forfeited 2026-09-26).
--   - cancel_cash_order_atomic and terminate_web_order_atomic call
--     revoke_loyalty_points with no exception handler, so a cancel of an order
--     whose points/spend must be reversed is refused as a whole.
--   - No real customer affected yet (last successful 'revoked' row 2026-08-25).
--
-- Fix: compare as text — CASE NEW.transaction_type::text. Nothing else
-- changes. Body taken from LIVE pg_get_functiondef (md5
-- 2dc3585289f475f4af5bcf987687238e, 1841 bytes, identical to the copy recorded
-- in 20260917070100); the only edit is the "::text" on the CASE subject. The
-- 'restored' branch is kept: as text it is harmless and matches if the enum
-- ever gains that value. Grants unchanged (CREATE OR REPLACE keeps the ACL).
-- Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.note_loyalty_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_note text;
BEGIN
  IF NEW.transaction_type IN ('earned','redeemed') THEN RETURN NEW; END IF;
  IF NEW.account_id IS NULL AND NEW.cash_order_id IS NULL THEN RETURN NEW; END IF;

  v_note := CASE NEW.transaction_type::text
    WHEN 'revoked'        THEN 'Loyalty: ' || abs(NEW.points_amount)::text || ' pts revoked'
                               || COALESCE(', ' || NEW.spend_amount_jpy::text || ' JPY spend deducted', '')
    WHEN 'restored'       THEN 'Loyalty: ' || NEW.points_amount::text || ' pts restored'
                               || COALESCE(', ' || NEW.spend_amount_jpy::text || ' JPY spend restored', '')
    WHEN 'expired'        THEN 'Loyalty: ' || abs(NEW.points_amount)::text || ' pts expired'
    WHEN 'adjusted'       THEN 'Loyalty: manual adjustment ' || NEW.points_amount::text || ' pts'
                               || COALESCE(', ' || NEW.spend_amount_jpy::text || ' JPY spend', '')
    WHEN 'refunded'       THEN 'Loyalty: ' || NEW.points_amount::text || ' pts refunded'
    WHEN 'birthday_bonus' THEN 'Loyalty: birthday bonus ' || NEW.points_amount::text || ' pts'
    WHEN 'tier_changed'   THEN 'Loyalty: tier changed'
    WHEN 'enrolled'       THEN 'Loyalty: enrolled in Cha Jewels Circle'
    ELSE 'Loyalty: ' || NEW.transaction_type::text || ' ' || NEW.points_amount::text || ' pts'
  END;

  IF NEW.notes IS NOT NULL AND NEW.notes <> '' THEN
    v_note := v_note || ' — ' || left(NEW.notes, 200);
  END IF;

  INSERT INTO public.account_notes (account_id, cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (NEW.account_id, NEW.cash_order_id, v_note, NEW.created_by_user_id, 'System (Loyalty)');
  RETURN NEW;
END; $function$;

-- Proof: the new body compares as text, and the trigger is still attached.
DO $proof$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'note_loyalty_transaction';
  IF position('CASE NEW.transaction_type::text' IN v_src) = 0 THEN
    RAISE EXCEPTION 'note_loyalty_transaction: CASE is not comparing as text';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_note_loyalty_transaction'
                    AND tgrelid = 'public.loyalty_transactions'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'trg_note_loyalty_transaction is missing';
  END IF;
END $proof$;

COMMIT;
