-- SQF02 + SQF06 §8 (independent go-live counter-check 2026-10-08; owner "go" 2026-10-09).
-- Project doc: claude/square-go-live-countercheck-response-2026-10-08.md
--
--   SQF02 — the refund ledger refuses what cannot be true. record_square_refund
--   recorded whatever the edge handed it: an amount of 0 when Square's answer had
--   no amount (the edge wrote 0), a refund in any currency, a refund larger than
--   the money captured, and a refund id already recorded on ANOTHER payment
--   (ON CONFLICT re-bound it). Now, before anything is written:
--     bad_amount       p_amount_jpy <= 0 (or null)
--     bad_currency     the payload's amount_money.currency is not JPY (or absent)
--     parent_mismatch  the refund id is already recorded on a different payment
--     over_ceiling     a non-FAILED/REJECTED refund that, with the other
--                      non-FAILED/REJECTED refunds on the payment, exceeds the
--                      amount captured
--   A refusal returns ok:false with the reason and rings ONE staff bell per
--   (refund id, reason) — type card_refund_unrecorded — so a refund Square
--   reports but the Hub will not record is never silent. The edge side
--   (square.ts paymentOf / refundOf / moneyOf, square-sync.ts refundMoneyJpy)
--   validates the Square answer first and quarantines a refund it cannot read
--   as positive whole yen instead of writing 0.
--
--   SQF06 §8 (owner 2026-10-08 23:38 JST) — "or reverse the Square refund" is
--   not an operation Square offers; the card_refund_after_credit bell now says
--   what to do: void the UNSPENT store-credit lot the same day; a spent part is
--   a receivable handled under the card refund exception procedure.
--   SQF06 §7 — a Square refund that COMPLETES on an order already refunded
--   outside Square (method bank_transfer_exception / store_credit_exception,
--   migration 20261129110000) rings card_refund_after_exception once per
--   refund: a staff case, never both settled.
--
--   record_square_refund is patched IN PLACE from the live text behind an md5
--   guard (Bug #280; live md5 2e55df41443e7dcbc267b68aeac5e7cf). No `--` line
--   appears inside any patch anchor (Lovable's runner drops such lines —
--   docs/MIGRATIONS.md "Lovable strips in-body comments on apply").

-- ---------------------------------------------------------------------------
-- 1. The patch helper (session-only; identical to 20261129090000).
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
-- 2. record_square_refund (live md5 2e55df41443e7dcbc267b68aeac5e7cf):
--    the four refusals + their bell (SQF02), the bell wording (SQF06 §8).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.record_square_refund(text,text,text,bigint,text,timestamptz,timestamptz,jsonb)', '2e55df41443e7dcbc267b68aeac5e7cf', jsonb_build_array(
  jsonb_build_object('old', $o$  v_st    text := upper(coalesce(p_status, 'PENDING'));$o$,
                     'new', $n$  v_st    text := upper(coalesce(p_status, 'PENDING'));
  v_other bigint := 0;
  v_refuse text := NULL;$n$),
  jsonb_build_object('old', $o$  SELECT * INTO v_old FROM public.square_refunds WHERE square_refund_id = p_refund_id FOR UPDATE;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL$o$,
                     'new', $n$  SELECT * INTO v_old FROM public.square_refunds WHERE square_refund_id = p_refund_id FOR UPDATE;
  IF coalesce(p_amount_jpy, 0) <= 0 THEN v_refuse := 'bad_amount';
  ELSIF upper(coalesce(p_payload -> 'amount_money' ->> 'currency', '')) <> 'JPY' THEN v_refuse := 'bad_currency';
  ELSIF v_old.id IS NOT NULL AND v_old.square_payment_id <> p_square_payment_id THEN v_refuse := 'parent_mismatch';
  ELSIF v_st NOT IN ('FAILED','REJECTED') THEN
    SELECT coalesce(sum(r.amount_jpy), 0) INTO v_other FROM public.square_refunds r
     WHERE r.square_payment_row = v_sq.id AND r.square_refund_id <> p_refund_id AND r.status NOT IN ('FAILED','REJECTED');
    IF v_other + p_amount_jpy > round(v_sq.amount_jpy)::bigint THEN v_refuse := 'over_ceiling'; END IF;
  END IF;
  IF v_refuse IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                    WHERE n.type = 'card_refund_unrecorded' AND n.metadata ->> 'refund_id' = p_refund_id AND n.metadata ->> 'error' = v_refuse) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_refund_unrecorded', 'Square refund NOT recorded — needs a look',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · Square refund ' || p_refund_id || ' (' || lower(v_st) || ', '
                || coalesce(p_payload -> 'amount_money' ->> 'amount', coalesce(p_amount_jpy, 0)::text) || ' ' || coalesce(p_payload -> 'amount_money' ->> 'currency', '?')
                || ') was refused: ' || v_refuse
                || CASE v_refuse
                     WHEN 'over_ceiling' THEN ' — with the other refunds on this payment (¥' || to_char(v_other, 'FM999,999,999') || ') it exceeds the ¥' || to_char(round(v_sq.amount_jpy), 'FM999,999,999') || ' captured.'
                     WHEN 'parent_mismatch' THEN ' — this refund id is already recorded on payment ' || v_old.square_payment_id || '.'
                     WHEN 'bad_currency' THEN ' — not a yen refund.'
                     ELSE ' — no positive amount.' END
                || ' The Hub ledger was not changed; check the refund in the Square Dashboard.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id, 'refund_id', p_refund_id,
                                 'status', v_st, 'error', v_refuse, 'amount_jpy', p_amount_jpy, 'captured_jpy', v_sq.amount_jpy,
                                 'other_refunds_jpy', v_other, 'test', v_sq.test));
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', v_refuse, 'captured_jpy', v_sq.amount_jpy, 'other_refunds_jpy', v_other);
  END IF;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL$n$),
  jsonb_build_object('old', $o$The customer is being paid back twice: void the store-credit lot (Settings → Store Credit) or reverse the Square refund.'$o$,
                     'new', $n$The customer is being paid back twice: void the UNSPENT store-credit lot the same day (Settings → Store Credit); a part already spent is a receivable — follow the card refund exception procedure (docs/SQUARE.md).'$n$),
  jsonb_build_object('old', $o$  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status,$o$,
                     'new', $n$  IF v_st = 'COMPLETED' AND (v_old.id IS NULL OR v_old.status IS DISTINCT FROM 'COMPLETED')
     AND EXISTS (SELECT 1 FROM public.audit_logs a
                  WHERE a.entity_type = 'cash_order' AND a.entity_id = v_sq.cash_order_id AND a.action = 'refund_marked_issued'
                    AND a.new_value_json ->> 'method' IN ('bank_transfer_exception', 'store_credit_exception'))
     AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                      WHERE n.type = 'card_refund_after_exception' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_refund_after_exception', 'Square refund completed AFTER a refund exception',
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
              || ' refund ' || p_refund_id || ' COMPLETED in Square, but this order was already refunded outside Square (bank transfer / store credit exception). The customer may now be paid back twice: a staff case — never settle both.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status,$n$)
));

-- ---------------------------------------------------------------------------
-- 3. Self-check (structure; behaviour is development/sql/sqf02-square-refund-ledger-acceptance.sql).
-- ---------------------------------------------------------------------------
DO $self$
DECLARE d text := pg_get_functiondef('public.record_square_refund(text,text,text,bigint,text,timestamptz,timestamptz,jsonb)'::regprocedure);
BEGIN
  IF position('over_ceiling' IN d) = 0 OR position('parent_mismatch' IN d) = 0 OR position('bad_currency' IN d) = 0
     OR position('bad_amount' IN d) = 0 OR position('card_refund_unrecorded' IN d) = 0 THEN
    RAISE EXCEPTION 'STOP — record_square_refund lacks the SQF02 refusals';
  END IF;
  IF position('card_refund_after_exception' IN d) = 0 THEN
    RAISE EXCEPTION 'STOP — record_square_refund lacks the SQF06 §7 bell';
  END IF;
  IF position('reverse the Square refund' IN d) > 0 THEN
    RAISE EXCEPTION 'STOP — record_square_refund still says "reverse the Square refund" (SQF06 §8)';
  END IF;
END
$self$;
