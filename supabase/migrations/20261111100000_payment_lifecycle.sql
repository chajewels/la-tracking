-- Website payment lifecycle, Hub task H1 (plan claude/payment-lifecycle-plan-2026-10-05).
--
-- WHAT CHANGES
--   1. payment_submissions.customer_message — the reviewer's text the CUSTOMER
--      sees, written only on a staff reject or needs-clarification. Nullable,
--      no default; no existing row changes.
--   2. switch_web_payment_method_by_customer_atomic — the customer's own
--      payment-method switch on a website cash order. Owner rule C1 stays: the
--      checkout method is locked for her, EXCEPT after her latest decided
--      payment was REJECTED and nothing is in progress. needs_clarification is
--      not a rejection (INVARIANT 12 unchanged; it does not freeze automation).
--      Mirrors the staff switch change_web_payment_method_atomic (live
--      pg_get_functiondef md5 c53a73f430cc8f2f0b66253a570bea92, body md5
--      4a0d04ebeb0bc387d7dbccc54b70ca65, read 2026-10-05): same method set,
--      same payable test, same lock (public.cash_order_payment_lock), same
--      yen rule, same audit_logs shape — but the actor is the customer
--      (performed_by_user_id NULL, new_value_json.actor = 'customer'), and an
--      order that is not hers answers not_found (never reveals existence).
--      TS mirror of the refusal order: supabase/functions/_shared/method-switch-rules.ts
--      (canCustomerSwitch) — change one, change the other.
--      ONE SWITCH PER REJECTION (controller ruling, H6 fix round 1): after a
--      rejection she may switch once; a second switch before another decision
--      answers already_switched. Refusal order:
--        not_found, not_web_order, not_payable, payment_in_progress,
--        not_rejected, already_switched, bad_method, unchanged,
--        method_requires_yen
--   3. cash_order_payment_locks(uuid[]) — the batched read of
--      cash_order_payment_lock for the website's order list (one call per page,
--      never a per-row fan-out). It calls the existing function per id, so the
--      answer is identical by construction. At most 100 ids.
--
--   4. QC money/safety fixes (H10, qc-audit P2-2 / P2-3), md5-guarded
--      in-place patches of LIVE bodies (pg_temp.cj_patch, Bug #280):
--      a. web_payment_reminder_eligible — the cash branch skips an order
--         whose public.cash_order_payment_lock(o.id) IS NOT NULL (a Paidy
--         authorisation / capture / open window, an unresolved card attempt
--         or a pending submission): never "please pay" while money may
--         already be held. claim_web_payment_reminder re-applies the rule by
--         CALLING this function under its row lock (live body md5
--         3a9669eaadaecf1e8f9576e567a8c96d, read 2026-10-06), so it needs no
--         patch of its own. The layaway branch is unchanged (no lock there).
--         The R1 ruling (method-specific wording) is unaffected: this adds
--         only the lock condition.
--      b. terminate_web_order_atomic — refuses EVERY caller, staff included,
--         with reason 'paidy_payment_unresolved' while
--         cash_order_payment_lock(p_order_id) LIKE 'paidy%', mirroring the
--         Square guard (card_payment_unresolved). cancel-cash-order turns it
--         into "Reject or record the Paidy payment first".
--
--   5. Proof safety (H11 fix round 1, qc-audit P1-1, controller ruling R15):
--      a. payment_submissions is written only through the Hub. Live policies
--         read 2026-10-06: the INSERT policy "Authenticated users can insert
--         submissions" also let a signed-in CUSTOMER insert her own rows, and
--         "Session customers can cancel own cash order submissions" let her
--         update them. No client writes either way (portal and storefront go
--         through service-role edge functions), so the INSERT policy is
--         recreated with its staff condition only and the customer UPDATE
--         policy is dropped. Staff SELECT/INSERT/UPDATE and the customer
--         SELECT policy are unchanged.
--      b. guard_payment_submission_proof_url + trg_guard_payment_submission_proof_url:
--         BEFORE INSERT OR UPDATE OF proof_url — a new or changed proof_url
--         must be a link into THIS project's payment-proofs bucket (host
--         pfoicalpzdcmyxzvwyhz.supabase.co = the project ref, as in
--         supabase/config.toml; not a secret), with no "..", whitespace,
--         control characters, backslash or encoded dot/slash/backslash/NUL.
--         Raises invalid_proof_url (check_violation). Existing rows are not
--         touched. Covers insert_payment_submissions_batch and the staff
--         attach-proof update too. Edge twin: _shared/proof-url-rules.ts.
--         If the project ever moves host, this regex moves with it.
--
-- FUNCTION RULES (CLAUDE.md, Bug #280): the two new functions are created
-- fresh; the two patched bodies are changed in place from the live text
-- (md5-guarded, anchors must match exactly once). REVOKE/GRANT asserted below.

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Preconditions: the lock helper the switch relies on is the live one.
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.cash_order_payment_lock(uuid,uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'STOP — public.cash_order_payment_lock(uuid,uuid,boolean) is missing; nothing written';
  END IF;
  IF to_regprocedure('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'STOP — the staff switch this mirrors is missing; nothing written';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Column.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_submissions
  ADD COLUMN IF NOT EXISTS customer_message text NULL;
COMMENT ON COLUMN public.payment_submissions.customer_message IS
  'Reviewer text shown to the customer. Written only on a staff reject or needs-clarification (payment lifecycle, 2026-10-05); never internal notes.';

-- ---------------------------------------------------------------------------
-- 2. The customer's own method switch (after a rejection only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.switch_web_payment_method_by_customer_atomic(
  p_order_id uuid, p_customer_id uuid, p_method text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_owner    uuid;
  v_old      text;
  v_cur      text;
  v_status   text;
  v_pay      text;
  v_chan     text;
  v_lock     text;
  v_ref      text;
  v_decision text;
  v_decision_id uuid;
  v_decided_at timestamptz;
BEGIN
  IF p_order_id IS NULL OR p_customer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT customer_id, coalesce(payment_method, 'transfer'), currency::text, status::text, payment_status,
         source_channel, coalesce(web_reference, invoice_number)
    INTO v_owner, v_old, v_cur, v_status, v_pay, v_chan, v_ref
    FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  -- Another customer's order answers exactly like a missing one.
  IF NOT FOUND OR v_owner IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_chan IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('error', 'not_web_order');
  END IF;
  IF v_status <> 'pending' OR coalesce(v_pay, '') <> 'pending_transfer' THEN
    RETURN jsonb_build_object('error', 'not_payable');
  END IF;
  -- Owner rule 2026-10-04: while Paidy, a card hold or any other payment is in
  -- progress, nothing about how the order is paid changes.
  v_lock := public.cash_order_payment_lock(p_order_id);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_in_progress');
  END IF;
  -- C1: only after her latest DECIDED payment was rejected. Latest decision =
  -- newest by updated_at (decision time) among rejected / needs_clarification /
  -- confirmed.
  SELECT s.status::text, s.id, coalesce(s.updated_at, s.created_at)
    INTO v_decision, v_decision_id, v_decided_at
    FROM public.payment_submissions s
   WHERE s.cash_order_id = p_order_id
     AND s.status IN ('rejected', 'needs_clarification', 'confirmed')
   ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC, s.id DESC
   LIMIT 1;
  IF v_decision IS DISTINCT FROM 'rejected' THEN
    RETURN jsonb_build_object('error', 'not_rejected');
  END IF;
  -- One customer switch per rejection: a customer switch audited AFTER the
  -- deciding rejection (its updated_at, else created_at) spends it. Staff
  -- switches never count against her.
  IF EXISTS (
    SELECT 1 FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id
       AND a.action = 'payment_method_changed'
       AND a.new_value_json->>'actor' = 'customer'
       AND a.created_at > v_decided_at
  ) THEN
    RETURN jsonb_build_object('error', 'already_switched');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
  IF v_old = p_method THEN
    RETURN jsonb_build_object('error', 'unchanged', 'payment_method', v_old);
  END IF;
  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;

  UPDATE public.cash_orders SET payment_method = p_method, updated_at = now() WHERE id = p_order_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'payment_method_changed',
          jsonb_build_object('payment_method', v_old),
          jsonb_build_object('payment_method', p_method, 'actor', 'customer',
                             'customer_id', p_customer_id, 'reference', v_ref),
          NULL);

  RETURN jsonb_build_object('ok', true, 'old_method', v_old, 'payment_method', p_method, 'reference', v_ref,
                            'decision_id', v_decision_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.switch_web_payment_method_by_customer_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.switch_web_payment_method_by_customer_atomic(uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION public.switch_web_payment_method_by_customer_atomic(uuid, uuid, text) IS
  'Payment lifecycle (2026-10-05): the customer changes how she pays a website cash order, ONLY after her latest decided payment was rejected and with no payment in progress (C1 otherwise holds). Audited with actor customer. Service role only (the website edge function passes the signed-in customer). TS mirror: _shared/method-switch-rules.ts.';

-- ---------------------------------------------------------------------------
-- 3. Batched payment-lock read for the website's order list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_order_payment_locks(p_ids uuid[])
RETURNS TABLE(id uuid, lock text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF coalesce(cardinality(p_ids), 0) > 100 THEN
    RAISE EXCEPTION 'cash_order_payment_locks: at most 100 ids (got %)', cardinality(p_ids);
  END IF;
  RETURN QUERY
    SELECT x.order_id, public.cash_order_payment_lock(x.order_id)
      FROM unnest(coalesce(p_ids, ARRAY[]::uuid[])) AS x(order_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.cash_order_payment_locks(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_order_payment_locks(uuid[]) TO service_role;
COMMENT ON FUNCTION public.cash_order_payment_locks(uuid[]) IS
  'Payment lifecycle (2026-10-05): cash_order_payment_lock for up to 100 orders in one call (the website order list). Same answer per id by construction. Service role only.';

-- ---------------------------------------------------------------------------
-- 4. QC money/safety fixes (H10): in-place patches of live bodies.
--    Live pg_get_functiondef md5s read 2026-10-06:
--      web_payment_reminder_eligible(text,uuid)            a6283f61ccdb12cdf4b3522e87e10fb7
--      terminate_web_order_atomic(uuid,text,...,boolean)   7ca713d878fd2b115d10ba7560eeb0d9
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

-- 4a. web_payment_reminder_eligible — no reminder under a payment lock (P2-2).
SELECT pg_temp.cj_patch('public.web_payment_reminder_eligible(text,uuid)', 'a6283f61ccdb12cdf4b3522e87e10fb7', jsonb_build_array(
  jsonb_build_object('old', $o$       AND o.web_released_at IS NULL   -- W2-7: a part-paid web order is not chased
$o$, 'new', $n$       AND o.web_released_at IS NULL   -- W2-7: a part-paid web order is not chased
       AND public.cash_order_payment_lock(o.id) IS NULL   -- H10: Paidy/card money may already be held
$n$)));

-- 4b. terminate_web_order_atomic — Paidy money stops every cancel (P2-3).
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '7ca713d878fd2b115d10ba7560eeb0d9', jsonb_build_array(
  jsonb_build_object('old', $o$  IF public.square_order_unresolved(p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_payment_unresolved',
      'status', v_status);
  END IF;
$o$, 'new', $n$  IF public.square_order_unresolved(p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_payment_unresolved',
      'status', v_status);
  END IF;
  -- Paidy (H10, qc-audit P2-3): a Paidy authorisation, a capture not yet
  -- recorded, a Paidy submission awaiting Confirm or an open Paidy window stops
  -- EVERY termination, staff included — Reject or record the Paidy payment
  -- first, so a cancelled order never leaves Paidy money behind.
  IF coalesce(public.cash_order_payment_lock(p_order_id), '') LIKE 'paidy%' THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_payment_unresolved',
      'status', v_status);
  END IF;
$n$)));

-- Grants unchanged by CREATE OR REPLACE; re-asserted to the live ACL
-- (service_role only, read 2026-10-06).
REVOKE ALL ON FUNCTION public.web_payment_reminder_eligible(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_payment_reminder_eligible(text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 4c. Proof safety (H11): payment_submissions written only through the Hub.
--     The staff condition is kept exactly as live has it (scalar sub-select).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated users can insert submissions" ON public.payment_submissions;
CREATE POLICY "Authenticated users can insert submissions" ON public.payment_submissions
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_staff((SELECT auth.uid()))));
DROP POLICY IF EXISTS "Session customers can cancel own cash order submissions" ON public.payment_submissions;

-- 4d. Database guard on proof links (new and changed values only).
CREATE OR REPLACE FUNCTION public.guard_payment_submission_proof_url()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF NEW.proof_url IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.proof_url IS DISTINCT FROM OLD.proof_url) THEN
    IF NEW.proof_url !~ '^https://pfoicalpzdcmyxzvwyhz\.supabase\.co/storage/v1/object/(public|sign)/payment-proofs/[^/?#]'
       OR position('..' IN NEW.proof_url) > 0
       OR NEW.proof_url ~ '[[:space:][:cntrl:]\\]'
       OR NEW.proof_url ~* '%(2e|2f|5c|00)' THEN
      RAISE EXCEPTION 'invalid_proof_url'
        USING ERRCODE = 'check_violation',
              DETAIL = 'Proof of payment must be a file in the Cha Jewels payment-proofs bucket.';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_payment_submission_proof_url() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_payment_submission_proof_url ON public.payment_submissions;
CREATE TRIGGER trg_guard_payment_submission_proof_url
  BEFORE INSERT OR UPDATE OF proof_url ON public.payment_submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_submission_proof_url();

-- ---------------------------------------------------------------------------
-- 5. Post-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.web_payment_reminder_eligible(text,uuid)', 'cash_order_payment_lock(o.id) IS NULL'),
      ('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', 'paidy_payment_unresolved')
    ) AS t(sig, marker)
  LOOP
    IF position(r.marker IN pg_get_functiondef(to_regprocedure(r.sig))) = 0 THEN
      RAISE EXCEPTION 'STOP — % is missing its patch (%); rolled back', r.sig, r.marker;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.web_payment_reminder_eligible(text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.web_payment_reminder_eligible(text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — a patched function is executable by a signed-in or anonymous caller; rolled back';
  END IF;
END
$check$;

-- ---------------------------------------------------------------------------
-- 6. Post-checks (H1). Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'payment_submissions'
                    AND column_name = 'customer_message' AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'STOP — payment_submissions.customer_message is not a nullable column without default; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — the customer switch is executable by a signed-in or anonymous caller; rolled back';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — service_role cannot execute the customer switch; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.cash_order_payment_locks(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cash_order_payment_locks(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — the batched lock read is executable by a signed-in or anonymous caller; rolled back';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.cash_order_payment_locks(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — service_role cannot execute the batched lock read; rolled back';
  END IF;
  -- H11: no policy lets a customer insert or update a submission.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'payment_submissions'
                AND cmd IN ('INSERT', 'UPDATE', 'ALL')
                AND (coalesce(qual, '') ILIKE '%auth_user_id%' OR coalesce(with_check, '') ILIKE '%auth_user_id%')) THEN
    RAISE EXCEPTION 'STOP — a customer branch still allows writes to payment_submissions; rolled back';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'payment_submissions'
                    AND policyname = 'Authenticated users can insert submissions' AND cmd = 'INSERT'
                    AND with_check ILIKE '%is_staff%') THEN
    RAISE EXCEPTION 'STOP — the staff INSERT policy is missing; rolled back';
  END IF;
  -- H11: the proof-link guard is installed, enabled, pinned and not callable.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.payment_submissions'::regclass
                    AND tgname = 'trg_guard_payment_submission_proof_url'
                    AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'STOP — trg_guard_payment_submission_proof_url is missing or disabled; rolled back';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.guard_payment_submission_proof_url()'::regprocedure
                    AND proconfig @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'STOP — guard_payment_submission_proof_url has no pinned search_path; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.guard_payment_submission_proof_url()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_payment_submission_proof_url()', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — the proof-link guard function is executable by a signed-in or anonymous caller; rolled back';
  END IF;
  IF position('payment-proofs/' IN pg_get_functiondef('public.guard_payment_submission_proof_url()'::regprocedure)) = 0
     OR position('invalid_proof_url' IN pg_get_functiondef('public.guard_payment_submission_proof_url()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — guard_payment_submission_proof_url body is not the expected one; rolled back';
  END IF;
END
$check$;
