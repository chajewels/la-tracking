-- 20261128100000_paidy_pr4_concurrency.sql
-- Paidy reassessment PR 4 — money concurrency (PA06 / PA14 / PA07), owner go
-- 2026-10-08 23:16 JST (plan: claude/paidy-pr4-concurrency-plan-2026-10-08.md).
-- Owner correction 3: PA06 and PA14 touch financial locks, not only emails.
--
--   PA06  reject_paidy_submission_atomic (NEW, service role): the Paidy
--         Reject's ONE Hub write — under the ORDER lock (the same lock the
--         auto-recorder's finalize_cash_submission_atomic and the filing
--         writer take, so a racing capture recording queues behind it):
--         paidy_payments → closed/rejected/expired (compare-and-set from
--         authorized), the submission → rejected, the audit row and ONE
--         follow-up intent for the customer email — all or nothing. Before
--         this the four writes were separate and two of them unchecked.
--   PA14  cash_order_cancel_intents (NEW): a staff cancellation is recorded
--         BEFORE its Paidy release and advanced per stage, so an interrupted
--         cancel is visible and the sweep can finish the stages whose money
--         side is already done (owner decision 2026-10-08 23:16 JST: finish
--         from paidy_released onward; a cancel interrupted before the
--         release only rings a bell).
--         payment_submission_followups (NEW): a customer email the Hub owes
--         after a Paidy reject / a cancellation, processed by the function
--         itself and, if it never reached the send, by the sweep (no
--         email_send_log row for the key — never a replay of a failed send,
--         owner rule).
--   PA07  paidy_cases.bell_rung_at: the first staff bell of a case is
--         recorded; the sweep rings every open case whose bell never rang.
--
-- No existing function is redefined here (no cj_patch). Grants: every new
-- function is service_role only; new tables are RLS on, staff SELECT,
-- service_role ALL. Re-running is a no-op.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Follow-up intents (PA06 / PA14): the customer emails the Hub owes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_submission_followups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('paidy_rejected_email', 'web_cancellation_email')),
  submission_id    uuid,
  cash_order_id    uuid,
  idempotency_key  text NOT NULL UNIQUE,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  done_at          timestamptz
);
CREATE INDEX IF NOT EXISTS idx_payment_submission_followups_pending
  ON public.payment_submission_followups (created_at) WHERE status = 'pending';
COMMENT ON TABLE public.payment_submission_followups IS
  'PA06/PA14 (2026-10-08): a customer email the Hub owes after a Paidy reject or a web cancellation, written in the same transaction as the decision. The function sends it at once; the sweep sends it only when the Hub never reached the send (no email_send_log row for idempotency_key) — a failed send is never replayed (owner rule). Service role writes; staff read.';
ALTER TABLE public.payment_submission_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_submission_followups_staff_select ON public.payment_submission_followups;
CREATE POLICY payment_submission_followups_staff_select ON public.payment_submission_followups
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.payment_submission_followups FROM anon;
GRANT SELECT ON public.payment_submission_followups TO authenticated;
GRANT ALL ON public.payment_submission_followups TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Cancellation intents (PA14).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cash_order_cancel_intents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id  uuid NOT NULL,
  user_id        uuid,
  user_email     text,
  reason         text,
  refund_status  text,
  refund_note    text,
  stage          text NOT NULL DEFAULT 'started'
                 CHECK (stage IN ('started', 'paidy_released', 'terminated', 'notified', 'done', 'abandoned')),
  last_error     text,
  bell_rung_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_order_cancel_intents_open
  ON public.cash_order_cancel_intents (updated_at) WHERE stage NOT IN ('done', 'abandoned');
CREATE INDEX IF NOT EXISTS idx_cash_order_cancel_intents_order
  ON public.cash_order_cancel_intents (cash_order_id);
COMMENT ON TABLE public.cash_order_cancel_intents IS
  'PA14 (2026-10-08): a staff cancellation of a web order, recorded BEFORE its Paidy release and advanced per stage (started → paidy_released → terminated → notified → done). The sweep finishes an intent stuck at paidy_released or later (the money side is done); one stuck at started only rings a bell (owner decision). Service role writes; staff read.';
ALTER TABLE public.cash_order_cancel_intents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cash_order_cancel_intents_staff_select ON public.cash_order_cancel_intents;
CREATE POLICY cash_order_cancel_intents_staff_select ON public.cash_order_cancel_intents
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.cash_order_cancel_intents FROM anon;
GRANT SELECT ON public.cash_order_cancel_intents TO authenticated;
GRANT ALL ON public.cash_order_cancel_intents TO service_role;

-- ---------------------------------------------------------------------------
-- 3. PA07: the first bell of a case is recorded.
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_cases ADD COLUMN IF NOT EXISTS bell_rung_at timestamptz;
COMMENT ON COLUMN public.paidy_cases.bell_rung_at IS
  'PA07 (2026-10-08): when the staff bell for this case was written. NULL on an open case = the bell never rang (the insert failed); the sweep rings it once and stamps this.';

-- ---------------------------------------------------------------------------
-- 4. PA06: the Paidy Reject's single Hub write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_paidy_submission_atomic(
  p_submission_id uuid, p_user_id uuid, p_notes text,
  p_paidy_row uuid, p_end_status text, p_end_reason text, p_payload jsonb DEFAULT NULL::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_sub      public.payment_submissions%ROWTYPE;
  v_order_id uuid;
  v_row      public.paidy_payments%ROWTYPE;
  v_n        integer := 0;
  v_key      text;
  v_followup uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required'); END IF;
  IF p_end_status IS NOT NULL AND p_end_status NOT IN ('closed', 'rejected', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_end_status');
  END IF;

  -- The ORDER lock first: finalize_cash_submission_atomic (the auto-recorder)
  -- and file_paidy_submission_atomic take the same lock, so a capture being
  -- recorded and this Reject queue instead of interleaving.
  SELECT s.cash_order_id INTO v_order_id FROM public.payment_submissions s WHERE s.id = p_submission_id;
  IF v_order_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  PERFORM 1 FROM public.cash_orders o WHERE o.id = v_order_id FOR UPDATE;

  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;
  IF v_sub.paidy_payment_id IS NULL OR v_sub.paidy_payment_id <> p_paidy_row THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_this_paidy_submission');
  END IF;
  IF v_sub.status = 'rejected' THEN
    RETURN jsonb_build_object('ok', true, 'already_rejected', true, 'submission_id', v_sub.id);
  END IF;
  -- R04: a Paidy Reject claims only a still-queued submission; a Confirm that
  -- claimed it (status confirmed) wins.
  IF v_sub.status NOT IN ('submitted', 'under_review') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'status', v_sub.status);
  END IF;

  SELECT * INTO v_row FROM public.paidy_payments WHERE id = p_paidy_row FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'paidy_row_missing'); END IF;
  -- A capture is terminal: never rejected here (the edge function refuses
  -- before calling; this is the database saying the same).
  IF v_row.status = 'captured' THEN RETURN jsonb_build_object('ok', false, 'error', 'paidy_captured'); END IF;

  IF p_end_status IS NOT NULL THEN
    UPDATE public.paidy_payments
       SET status = p_end_status, closed_at = COALESCE(closed_at, now()),
           closed_reason = left(COALESCE(p_end_reason, 'rejected by reviewer'), 200),
           last_payload = COALESCE(p_payload, last_payload), updated_at = now()
     WHERE id = p_paidy_row AND status = 'authorized';
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;

  UPDATE public.payment_submissions
     SET status = 'rejected', reviewer_user_id = p_user_id, reviewer_notes = p_notes,
         customer_message = p_notes, processing_started_at = NULL, updated_at = now()
   WHERE id = p_submission_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, old_value_json, new_value_json)
  VALUES ('payment_submission', p_submission_id, 'submission_rejected', p_user_id,
          jsonb_build_object('status', v_sub.status),
          jsonb_build_object('status', 'rejected', 'reviewer_notes', p_notes, 'confirmed_payment_ids', '[]'::jsonb,
                             'allocation_count', 0, 'paidy_payment_id', v_row.paidy_payment_id,
                             'paidy_end_status', p_end_status, 'paidy_row_updated', v_n = 1, 'atomic', true));

  -- The customer email the Hub now owes (same key the sender uses).
  v_key := 'payment-rejected-' || p_submission_id::text;
  INSERT INTO public.payment_submission_followups (kind, submission_id, cash_order_id, idempotency_key, payload)
  VALUES ('paidy_rejected_email', p_submission_id, v_order_id, v_key,
          jsonb_build_object('kind', 'staff', 'reason', p_notes))
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_followup;
  IF v_followup IS NULL THEN
    SELECT id INTO v_followup FROM public.payment_submission_followups WHERE idempotency_key = v_key;
  END IF;

  RETURN jsonb_build_object('ok', true, 'submission_id', p_submission_id, 'cash_order_id', v_order_id,
                            'paidy_row_updated', v_n = 1, 'followup_id', v_followup, 'followup_key', v_key);
END
$function$;
REVOKE ALL ON FUNCTION public.reject_paidy_submission_atomic(uuid, uuid, text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_paidy_submission_atomic(uuid, uuid, text, uuid, text, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Self-checks: STOP loudly if anything above did not land.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.reject_paidy_submission_atomic(uuid,uuid,text,uuid,text,text,jsonb)') IS NULL THEN RAISE EXCEPTION 'self-check reject_paidy_submission_atomic missing'; END IF;
  IF to_regclass('public.payment_submission_followups') IS NULL THEN RAISE EXCEPTION 'self-check payment_submission_followups missing'; END IF;
  IF to_regclass('public.cash_order_cancel_intents') IS NULL THEN RAISE EXCEPTION 'self-check cash_order_cancel_intents missing'; END IF;
  PERFORM 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'paidy_cases' AND column_name = 'bell_rung_at';
  IF NOT FOUND THEN RAISE EXCEPTION 'self-check paidy_cases.bell_rung_at missing'; END IF;
  PERFORM 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payment_submission_followups' AND policyname = 'payment_submission_followups_staff_select';
  IF NOT FOUND THEN RAISE EXCEPTION 'self-check followups policy missing'; END IF;
  PERFORM 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cash_order_cancel_intents' AND policyname = 'cash_order_cancel_intents_staff_select';
  IF NOT FOUND THEN RAISE EXCEPTION 'self-check cancel intents policy missing'; END IF;
END $$;
