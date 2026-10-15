-- Square operations panel — environment-true counters, the card mark records
-- the refund decision (2026-10-15, owner "go" on the QA rev. 2 dispositions
-- A and B; claude/qa-brief-live-production-2026-10-11.md §7).
--
-- A. square_ops_health() counted sandbox and production rows together (105 of
--    the 121 inbox rows were sandbox-era; 16 sandbox + 2 production payments;
--    9 sandbox + 1 production refunds). Every counter is now for the LIVE
--    environment (square_live_environment(): mode 'test' → sandbox, else
--    production), with the other environment's residue on its own key so
--    nothing is hidden. The inbox table gets an `environment` column, written
--    by square-webhook (the key that verified the signature) and by
--    square-reconcile (the environment it read from); rows that cannot be
--    attributed (none today after the backfill except Square's sample events)
--    count under the live environment — never silently dropped.
-- B. mark_web_order_refund_issued_atomic: a card mark on a cancelled order IS
--    the staff decision on its COMPLETED Square refunds, so it writes
--    decision = 'order_cancelled_refunded' on the ones still undecided, by the
--    same person, in the same transaction; rows a staff member already decided
--    are left alone (decide_square_case stays the manual path). The six
--    undecided test-order refunds already on live are the owner's to decide in
--    the panel; this migration does not touch them. (No comment lines inside
--    the patch block itself — Lovable drops them on apply, DOC-4 rule.)
--
-- FUNCTION CHANGES START FROM LIVE (Bug #280): drift audit on 2026-10-15
-- 11:40 JST = 421/421 functions identical (one-hash compare, all three buckets
-- 0). square_ops_health() is replaced whole under an md5 guard (live md5
-- 92fb88df6f0e3286cd426870bfa346c0); mark_web_order_refund_issued_atomic is
-- patched in place from live (md5 0637d241d65fa7c04312b147d1c9601b) with ONE
-- block added before its audit INSERT. Both STOP on any other live body.

-- ---------------------------------------------------------------------------
-- 0. The patch helper (session-only; same as 20261118100000).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.cj_patch(p_sig text, p_before text, p_edits jsonb)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn   regprocedure;
  v_def  text;
  v_new  text;
  e      jsonb;
  v_n    integer;
  v_done boolean := true;
BEGIN
  v_fn := to_regprocedure(p_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', p_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    IF position(e ->> 'new' IN v_def) = 0 THEN v_done := false; END IF;
  END LOOP;
  IF v_done THEN
    RAISE NOTICE '% already patched — no change', p_sig;
    RETURN;
  END IF;
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', p_sig, md5(v_def);
  END IF;
  v_new := v_def;
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    v_n := (length(v_new) - length(replace(v_new, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'STOP — % anchor found % times, expected 1: %', p_sig, v_n, left(e ->> 'old', 120);
    END IF;
    v_new := replace(v_new, e ->> 'old', e ->> 'new');
  END LOOP;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
    RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', p_sig;
  END IF;
END
$p$;

-- ---------------------------------------------------------------------------
-- 1. The inbox carries its environment.
-- ---------------------------------------------------------------------------
ALTER TABLE public.square_webhook_events ADD COLUMN IF NOT EXISTS environment text;
DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'square_webhook_events_environment_check'
                   AND conrelid = 'public.square_webhook_events'::regclass) THEN
    ALTER TABLE public.square_webhook_events
      ADD CONSTRAINT square_webhook_events_environment_check
      CHECK (environment IS NULL OR environment IN ('sandbox', 'production'));
  END IF;
END
$c$;
COMMENT ON COLUMN public.square_webhook_events.environment IS
  'sandbox | production — the Square environment the event came from (webhook: the signature key that verified; reconcile: the environment read). NULL = could not be attributed; counted under the live environment by square_ops_health().';

-- Backfill from the rows the events belong to (payments → their refunds →
-- disputes). Square's dashboard sample events (made-up 2020 USD dispute) match
-- nothing and stay NULL on purpose.
UPDATE public.square_webhook_events e SET environment = p.environment
  FROM public.square_payments p
 WHERE e.environment IS NULL AND e.payment_id IS NOT NULL AND e.payment_id = p.square_payment_id
   AND p.environment IN ('sandbox', 'production');
UPDATE public.square_webhook_events e SET environment = p.environment
  FROM public.square_refunds r JOIN public.square_payments p ON p.id = r.square_payment_row
  WHERE e.environment IS NULL AND e.object_id IS NOT NULL AND e.object_id = r.square_refund_id
   AND p.environment IN ('sandbox', 'production');
UPDATE public.square_webhook_events e SET environment = p.environment
  FROM public.square_disputes d JOIN public.square_payments p ON p.id = d.square_payment_row
 WHERE e.environment IS NULL AND e.object_id IS NOT NULL AND e.object_id = d.square_dispute_id
   AND p.environment IN ('sandbox', 'production');
-- A Square refund id is "<payment id>_<suffix>": attribute by the parent id too.
UPDATE public.square_webhook_events e SET environment = p.environment
  FROM public.square_payments p
 WHERE e.environment IS NULL AND e.object_id IS NOT NULL AND e.object_id LIKE p.square_payment_id || '\_%'
    AND p.environment IN ('sandbox', 'production');

-- ---------------------------------------------------------------------------
-- 2. The live environment, one reading, from the one switch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_live_environment()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  -- test → sandbox; on → production; off → production (the environment real
  -- money lives in, and the one the panel should keep watching while Off).
  SELECT CASE public.square_mode() WHEN 'test' THEN 'sandbox' ELSE 'production' END
$fn$;
REVOKE ALL ON FUNCTION public.square_live_environment() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.square_live_environment() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The counters for ONE environment (service/definer only — the panel reads
--    them through square_ops_health()).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_ops_counts(p_env text, p_unknown_here boolean)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  -- p_unknown_here: rows with no environment (inbox rows that could not be
  -- attributed, disputes with no parent payment row) are counted here — the
  -- live environment takes them, so nothing disappears between the two keys.
  SELECT jsonb_build_object(
    'environment',         p_env,
    'events_backlog',      (SELECT count(*) FROM public.square_webhook_events
                             WHERE status IN ('received','processing','failed','quarantined')
                               AND (environment = p_env OR (p_unknown_here AND environment IS NULL))),
    'events_dead',         (SELECT count(*) FROM public.square_webhook_events
                             WHERE status = 'dead'
                               AND (environment = p_env OR (p_unknown_here AND environment IS NULL))),
    'holds_live',          (SELECT count(*) FROM public.square_payments WHERE status = 'authorized' AND environment = p_env),
    'attempts_open',       (SELECT count(*) FROM public.square_card_attempts
                             WHERE status IN ('reserved','unknown','cancelling') AND environment = p_env),
    'captured_unrecorded', (SELECT count(*) FROM public.square_payments
                             WHERE status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL AND environment = p_env),
    'exceptions_open',     (SELECT count(*) FROM public.square_payments
                             WHERE exception IS NOT NULL AND exception_resolved_at IS NULL AND environment = p_env),
    'refunds_open',        (SELECT count(*) FROM public.square_refunds r LEFT JOIN public.square_payments p ON p.id = r.square_payment_row
                             WHERE r.status NOT IN ('COMPLETED','FAILED','REJECTED')
                               AND (p.environment = p_env OR (p_unknown_here AND p.environment IS NULL))),
    'refund_oldest_pending_at', (SELECT min(coalesce(r.provider_created_at, r.created_at))
                                   FROM public.square_refunds r LEFT JOIN public.square_payments p ON p.id = r.square_payment_row
                                  WHERE r.status NOT IN ('COMPLETED','FAILED','REJECTED')
                                     AND (p.environment = p_env OR (p_unknown_here AND p.environment IS NULL))),
    'attempts_stuck',      (SELECT count(*) FROM public.square_card_attempts
                             WHERE status IN ('reserved','unknown','cancelling') AND stuck_warned_at IS NOT NULL AND environment = p_env),
    'disputes_open',       (SELECT count(*) FROM public.square_disputes d LEFT JOIN public.square_payments p ON p.id = d.square_payment_row
                             WHERE d.state NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')
                               AND (p.environment = p_env OR (p_unknown_here AND p.environment IS NULL))),
    'refunds_undecided',   (SELECT count(*) FROM public.square_refunds r LEFT JOIN public.square_payments p ON p.id = r.square_payment_row
                             WHERE r.decided_at IS NULL
                               AND (p.environment = p_env OR (p_unknown_here AND p.environment IS NULL)))
  )
$fn$;
REVOKE ALL ON FUNCTION public.square_ops_counts(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.square_ops_counts(text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. square_ops_health(): the live environment's counters + the other one's
--    residue. Same keys as before at the top level (the panel keeps working),
--    plus 'environment', 'refunds_undecided' and 'other_environment'.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE v_def text; v_md5 text;
BEGIN
  v_def := pg_get_functiondef('public.square_ops_health()'::regprocedure);
  IF position('ENVIRONMENT-TRUE (2026-10-15)' IN v_def) > 0 THEN
    RAISE NOTICE 'square_ops_health already environment-true - no change';
    RETURN;
  END IF;
  v_md5 := md5(v_def);
  IF v_md5 <> '92fb88df6f0e3286cd426870bfa346c0' THEN
    RAISE EXCEPTION 'STOP - square_ops_health has moved on live (md5 %); re-read it before replacing. Nothing changed.', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.square_ops_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v jsonb; v_env text; v_other text;
BEGIN
  -- Staff only (review #2: current_user is the owner inside SECURITY
  -- DEFINER, so it can never identify the caller).
  IF v_uid IS NULL OR NOT public.is_staff(v_uid) THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  -- ENVIRONMENT-TRUE (2026-10-15): every counter is for the live environment
  -- (sandbox while the mode is Test, production otherwise); the other
  -- environment's rows are reported under other_environment, never mixed in.
  v_env   := public.square_live_environment();
  v_other := CASE v_env WHEN 'sandbox' THEN 'production' ELSE 'sandbox' END;
  v := public.square_ops_counts(v_env, true)
       || jsonb_build_object(
    'last_run',            (SELECT value FROM public.square_sync_state WHERE key = 'reconcile_last_run'),
    'last_ok_at',          (SELECT value->>'at' FROM public.square_sync_state WHERE key = 'reconcile_last_ok'),
    'checkpoints',         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM public.square_sync_state
                             WHERE key NOT IN ('reconcile_last_run','reconcile_last_ok')),
    'other_environment',   public.square_ops_counts(v_other, false)
  );
  RETURN v;
END
$function$;
REVOKE ALL ON FUNCTION public.square_ops_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.square_ops_health() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. A card mark records the refund decision (patched in place from live).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', '0637d241d65fa7c04312b147d1c9601b', jsonb_build_array(
  jsonb_build_object('old', $o$  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'refund_marked_issued',$o$, 'new', $n$  IF v_method = 'card' THEN
    UPDATE public.square_refunds
       SET decision = 'order_cancelled_refunded', decided_at = now(), decided_by = p_user_id,
           decision_note = COALESCE(decision_note, 'Recorded by "Mark refund issued — card"'), updated_at = now()
     WHERE cash_order_id = p_order_id AND status = 'COMPLETED' AND decision IS NULL;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'refund_marked_issued',$n$)
));