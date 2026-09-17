-- Reactivate an expired web layaway: one action, a required reason, and the
-- stock taken back off the shelf. Owner decision 2026-09-15, built 2026-09-16.
--
-- WHAT EXPIRY WROTE, which is exactly what this undoes. From
-- expire_web_layaway_atomic, read live before writing this:
--   1. layaway_accounts   status -> 'cancelled', expired_at = now(), a note appended
--   2. layaway_schedule   rows in ('pending','overdue') -> 'cancelled'
--   3. website_product_variants  stock_qty + quantity, per layaway_account_items line
--   4. audit_logs         action 'web_layaway_expired'
-- Reactivation reverses 1-3 and writes its own audit row. Nothing else moved,
-- so nothing else is restored.
--
-- THE STOCK IS THE HARD PART, AND IT IS THE POINT. Expiry put the piece back on
-- sale, so between then and now somebody may have bought it. Reactivating
-- without re-taking the stock would hold a piece the shelf says is available and
-- sell it twice. So this takes the stock back in the same transaction and
-- REFUSES THE WHOLE ACTION if any line cannot be covered — the plan stays
-- expired and staff are told which piece is gone.
--
-- WHY NOT THE CASH "REVIVE ORDER" PATH (Bug #217). That one lives in
-- CashOrderDetail.tsx as a direct PostgREST UPDATE from the browser: it flips
-- status and clears expired_at, takes no reason, is audited best-effort, and
-- takes no stock back — even though a WEB cash order's expiry returns stock.
-- Its vocabulary is reused here (expired -> live, a new deadline, an audit row
-- naming the old status) but not its shape. Filed separately: the cash path has
-- the same stock hole this one is built to close.
--
-- WHAT IS NOT GUARDED, DELIBERATELY. INVARIANT 12 freezes an account carrying an
-- unconfirmed submission, and expire_web_layaway_atomic honours it. This does
-- not, because INVARIANT 12 is a freeze on AUTOMATION, not on people: a
-- submission arriving after the plan lapsed is the exact case where staff need
-- to reactivate so the reviewer can confirm it. A staff member acting
-- deliberately is never blocked by that invariant.

CREATE OR REPLACE FUNCTION public.reactivate_web_layaway_atomic(
  p_account_id       uuid,
  p_transfer_due_at  timestamptz,
  p_reason           text,
  p_user_id          uuid DEFAULT NULL,
  p_source           text DEFAULT 'staff'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status    text;
  v_expired   timestamptz;
  v_invoice   text;
  v_web_ref   text;
  v_paid      numeric;
  v_old_due   timestamptz;
  v_short     jsonb;
  v_taken     integer := 0;
  v_restored  integer := 0;
  v_reason    text := btrim(coalesce(p_reason, ''));
  v_now       timestamptz := now();
BEGIN
  IF v_reason = '' THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
  -- A BACKDATED DEADLINE IS LEGAL ON A LIVE PLAN AND NONSENSE HERE. On a running
  -- order set_account_deadlines allows the past, because that is how staff
  -- release a hold deliberately. Reactivating to a past deadline would re-hold
  -- the piece and hand it straight back to the next hourly sweep — an action
  -- that undoes itself. Refuse instead of doing it.
  IF p_transfer_due_at <= v_now THEN
    RETURN jsonb_build_object('error', 'deadline_in_past', 'transfer_due_at', p_transfer_due_at);
  END IF;

  SELECT status::text, expired_at, invoice_number, web_reference, total_paid, transfer_due_at
    INTO v_status, v_expired, v_invoice, v_web_ref, v_paid, v_old_due
    FROM public.layaway_accounts
   WHERE id = p_account_id AND source_channel = 'web'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_web_layaway');
  END IF;

  -- EXPIRED MEANS EXPIRED, NOT MERELY CANCELLED. expire_web_layaway_atomic is
  -- the only writer of expired_at, so status='cancelled' AND expired_at IS NOT
  -- NULL is the signature of a lapsed deposit. A plan cancelled by a human has
  -- expired_at NULL and is NOT reactivated here — that was somebody's decision,
  -- and undoing it is not this action's business.
  IF v_status <> 'cancelled' OR v_expired IS NULL THEN
    RETURN jsonb_build_object('error', 'not_expired', 'status', v_status,
                              'expired_at', v_expired);
  END IF;

  -- Money received, in both the places it can show, in the same order and with
  -- the same two names expiry and set_account_deadlines use. INVARIANT 1 makes
  -- the ledger authoritative, so the cache alone is not trusted.
  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'already_paid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_account_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'payment_exists');
  END IF;

  -- CAN THE PIECE STILL BE HELD? Asked for every line before ANY line is taken,
  -- so a two-line plan with one sold piece refuses whole rather than half.
  SELECT jsonb_agg(jsonb_build_object(
           'variant_id', i.variant_id, 'title', i.title, 'sku', i.sku,
           'wanted', i.quantity, 'available', coalesce(v.stock_qty, 0)))
    INTO v_short
    FROM public.layaway_account_items i
    LEFT JOIN public.website_product_variants v ON v.id = i.variant_id
   WHERE i.account_id = p_account_id
     AND (v.id IS NULL OR v.stock_qty < i.quantity);
  IF v_short IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'out_of_stock', 'lines', v_short);
  END IF;

  -- Take the stock back. The WHERE re-checks the quantity so a concurrent
  -- checkout between the look and the take cannot drive stock negative; if it
  -- does happen, fewer rows update than there are lines and the count check
  -- below raises, rolling the whole thing back.
  WITH taken AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty - i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND v.id = i.variant_id
       AND v.stock_qty >= i.quantity
     RETURNING v.id
  )
  SELECT count(*) INTO v_taken FROM taken;

  SELECT count(*) INTO v_restored
    FROM public.layaway_account_items WHERE account_id = p_account_id;

  IF v_taken <> v_restored THEN
    RAISE EXCEPTION 'reactivate_web_layaway: took % of % lines — a piece sold during the reactivation; nothing applied', v_taken, v_restored;
  END IF;

  -- The plan comes back live with the NEW deadline, and expired_at is cleared so
  -- the hourly sweep can act on it again. The note is appended, never replaced:
  -- the expiry line stays in the history above it.
  UPDATE public.layaway_accounts
     SET status          = 'active',
         expired_at      = NULL,
         transfer_due_at = p_transfer_due_at,
         updated_at      = v_now,
         notes           = COALESCE(notes || E'\n', '')
                           || 'Reactivated ' || to_char(v_now AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                           || ' PHT — new deposit deadline '
                           || to_char(p_transfer_due_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                           || ' PHT — ' || v_reason
   WHERE id = p_account_id;

  -- Only the rows expiry cancelled come back, and they come back 'pending'.
  -- There is no money on this plan (refused above), so no row can be paid or
  -- partially_paid, and 'pending' is the honest state for every one of them. A
  -- due date already in the past will be re-marked overdue by the penalty
  -- engine on its own next run — that is the engine's job, not this one's.
  UPDATE public.layaway_schedule
     SET status = 'pending', updated_at = v_now
   WHERE account_id = p_account_id AND status = 'cancelled';
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action,
                                 old_value_json, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_account_id, 'web_layaway_reactivated',
          jsonb_build_object('status', 'cancelled', 'expired_at', v_expired,
                             'transfer_due_at', v_old_due),
          jsonb_build_object('status', 'active', 'expired_at', NULL,
                             'transfer_due_at', p_transfer_due_at,
                             'invoice_number', v_invoice, 'web_reference', v_web_ref,
                             'schedule_rows_restored', v_restored,
                             'stock_lines_taken', v_taken,
                             'reason', v_reason, 'source', p_source),
          coalesce(p_user_id, auth.uid()));

  RETURN jsonb_build_object('ok', true,
                            'web_reference', v_web_ref,
                            'invoice_number', v_invoice,
                            'transfer_due_at', p_transfer_due_at,
                            'schedule_rows_restored', v_restored,
                            'stock_lines_taken', v_taken);
END $$;

COMMENT ON FUNCTION public.reactivate_web_layaway_atomic(uuid, timestamptz, text, uuid, text) IS
  'Brings an EXPIRED web layaway (status cancelled + expired_at set) back to active with a new deposit deadline, re-taking the stock its expiry released. Refuses out_of_stock, not_expired, already_paid, payment_exists, reason_required, deadline_required, deadline_in_past. One transaction: either the plan is live and the pieces are held, or nothing changed.';

REVOKE EXECUTE ON FUNCTION public.reactivate_web_layaway_atomic(uuid, timestamptz, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reactivate_web_layaway_atomic(uuid, timestamptz, text, uuid, text) TO service_role;
