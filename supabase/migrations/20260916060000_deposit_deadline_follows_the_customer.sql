-- The web deposit deadline follows the customer: 24 hours for a first order,
-- 72 for a returning customer. Owner decision 2026-09-16.
--
-- WHY. Checkout told everyone "within 72 hours" while the FAQ published 24 for a
-- new customer and 72 for a returning one, and both order RPCs hard-coded 72. So
-- either the storefront lied about the deadline it would apply, or it applied a
-- deadline the published rule contradicts. One number, in one place, decided by
-- the customer's own history, is the fix.
--
-- ONE RULE, ONE HOME. web_deposit_deadline_hours() below is that home. Both
-- creation RPCs call it, the `website` edge function calls it so the checkout
-- copy can state the number BEFORE the order exists, and nothing re-derives it.
-- A CSR can still override afterwards through set_account_deadlines — this sets
-- the default, it does not take the decision away from staff.

CREATE OR REPLACE FUNCTION public.web_deposit_deadline_hours(p_customer_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  -- RETURNING = has transacted with us before. A cancelled or expired order is
  -- not a transaction: the one customer in live data whose only orders are
  -- cancelled (measured 2026-09-16: 198 customers are new by this test, 197 by
  -- "any order at all") is the person this distinction is FOR — they have
  -- already let a deadline lapse once.
  --
  -- Web expiry writes status 'cancelled' on both tables, so a lapsed web order
  -- correctly leaves the customer on 24 hours next time.
  --
  -- Forfeited and final_forfeited layaways COUNT as returning: money changed
  -- hands, the relationship is real, and only the plan ended badly.
  --
  -- A brand-new customer row (no id, or no orders) is new. That covers the
  -- customer the FAQ calls a guest: /checkout is behind sign-in, so by the time
  -- an order can be created the row exists — either freshly created, which is
  -- new, or matched by email to a CSR- or live-selling-created row, which
  -- correctly reads as returning.
  SELECT CASE
    WHEN p_customer_id IS NULL THEN 24
    WHEN EXISTS (
      SELECT 1 FROM public.cash_orders o
       WHERE o.customer_id = p_customer_id
         AND o.status::text NOT IN ('cancelled', 'expired')
    ) OR EXISTS (
      SELECT 1 FROM public.layaway_accounts a
       WHERE a.customer_id = p_customer_id
         AND a.status::text <> 'cancelled'
    ) THEN 72
    ELSE 24
  END;
$$;

COMMENT ON FUNCTION public.web_deposit_deadline_hours(uuid) IS
  'Hours a web customer has to send the deposit: 24 on a first order, 72 when they have a prior non-cancelled order of either kind. The single source for this rule — the creation RPCs and the website edge function all read it.';

GRANT EXECUTE ON FUNCTION public.web_deposit_deadline_hours(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Swap the hard-coded 72 wherever it is stated. Three lines in the whole
-- database mention it (checked 2026-09-16) and all three are listed below.
--
-- DONE AS A GUARDED IN-PLACE LINE REPLACEMENT, NOT A REHAND-WRITTEN FUNCTION.
-- Both bodies are long (5.3 KB and 7.1 KB) and neither needs any other change;
-- re-transcribing them to alter one line each is the larger risk, and it would
-- also silently revert anything Lovable has changed in them since. This block
-- reads each live definition, requires the target line to appear EXACTLY ONCE,
-- and rewrites only that line. If a function has moved on, the count is not 1,
-- the block RAISEs, and NOTHING is applied — which is the answer we want, not a
-- failure to work around.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_fn     text;
  v_args   text;
  v_def    text;
  v_new    text;
  v_old_ln text;
  v_new_ln text;
  v_hits   integer;
  v_pairs  text[][] := ARRAY[
    ARRAY[
      'create_web_order_atomic',
      '  v_due          timestamptz := now() + interval ''72 hours'';',
      '  v_due          timestamptz := now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id));'
    ],
    ARRAY[
      'create_web_layaway_atomic',
      '  v_due := coalesce(p_transfer_due_at, now() + interval ''72 hours'');',
      '  v_due := coalesce(p_transfer_due_at, now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)));'
    ],
    -- THE THIRD PUBLISHER, and the one nobody was looking at. This default
    -- cancellation_reason is rendered to the customer on /account/orders and
    -- /account/orders/:id, so a customer who was given 24 hours could be told
    -- their transfer had not arrived "within 72 hours". The deadline is already
    -- stored and already shown beside it; the sentence does not need to repeat
    -- a number, and repeating the wrong one is worse than saying none.
    --
    -- NOT FIXED HERE, and flagged in the PR: this string is English only, in a
    -- bilingual storefront. That is a separate decision about where a
    -- customer-visible reason should be translated, not a number to correct.
    ARRAY[
      'terminate_web_order_atomic',
      '    v_reason := COALESCE(NULLIF(btrim(p_reason), ''''), ''Bank transfer not received within 72 hours (auto-expired)'');',
      '    v_reason := COALESCE(NULLIF(btrim(p_reason), ''''), ''Bank transfer not received by the deadline (auto-expired)'');'
    ]
  ];
  i integer;
BEGIN
  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_fn     := v_pairs[i][1];
    v_old_ln := v_pairs[i][2];
    v_new_ln := v_pairs[i][3];

    SELECT pg_get_functiondef(p.oid), pg_get_function_identity_arguments(p.oid)
      INTO v_def, v_args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'deposit_deadline: public.% does not exist', v_fn;
    END IF;

    v_hits := (length(v_def) - length(replace(v_def, v_old_ln, ''))) / length(v_old_ln);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION
        'deposit_deadline: expected exactly 1 occurrence of the 72-hour line in public.%(%), found % — the function has changed; nothing applied',
        v_fn, v_args, v_hits;
    END IF;

    v_new := replace(v_def, v_old_ln, v_new_ln);
    EXECUTE v_new;
    RAISE NOTICE 'deposit_deadline: public.%(%) now defaults to web_deposit_deadline_hours()', v_fn, v_args;
  END LOOP;
END $$;

-- Prove it, without writing anything: a customer with no orders gets 24, one
-- with a live order gets 72.
DO $$
DECLARE v_new integer; v_ret integer;
BEGIN
  SELECT public.web_deposit_deadline_hours(gen_random_uuid()) INTO v_new;
  SELECT public.web_deposit_deadline_hours(
           (SELECT customer_id FROM public.layaway_accounts
             WHERE status::text <> 'cancelled' AND customer_id IS NOT NULL LIMIT 1)
         ) INTO v_ret;
  RAISE NOTICE 'deposit_deadline: unknown customer => % hours; customer with a live plan => % hours', v_new, v_ret;
  IF v_new <> 24 OR v_ret <> 72 THEN
    RAISE EXCEPTION 'deposit_deadline: self-check failed (% / %)', v_new, v_ret;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- WHAT THE DATABASE NOW HOLDS — the RESULT, not just the patch.
--
-- This migration rewrites three lines in place rather than replacing three
-- function bodies, which keeps the change minimal and safe but leaves the repo
-- describing an EDIT instead of a STATE. That is the divergence the search_path
-- incident was made of: the repo and the database both looked authoritative and
-- only one of them was. So the resulting lines are recorded here verbatim. If
-- you ever need to know what these functions say without a database in front of
-- you, this is the answer, and `pg_get_functiondef` is how you check it has not
-- drifted.
--
-- public.create_web_order_atomic — DECLARE block:
--
--   v_due          timestamptz := now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id));
--
-- public.create_web_layaway_atomic — body, first statement after the quote lock:
--
--   v_due := coalesce(p_transfer_due_at, now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)));
--
-- public.terminate_web_order_atomic — default cancellation reason:
--
--   v_reason := COALESCE(NULLIF(btrim(p_reason), ''), 'Bank transfer not received by the deadline (auto-expired)');
--
-- Everything else in all three functions is byte-identical to what was there
-- before. To confirm that at any time — this must return no rows:
--
--   SELECT p.proname, t.l
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--     CROSS JOIN LATERAL regexp_split_to_table(pg_get_functiondef(p.oid), E'\n') AS t(l)
--    WHERE n.nspname = 'public' AND t.l LIKE '%72 hours%';
--
-- and this must return three rows, one per function above:
--
--   SELECT p.proname, t.l
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--     CROSS JOIN LATERAL regexp_split_to_table(pg_get_functiondef(p.oid), E'\n') AS t(l)
--    WHERE n.nspname = 'public' AND t.l LIKE '%web_deposit_deadline_hours%'
--      AND p.proname <> 'web_deposit_deadline_hours';
-- ---------------------------------------------------------------------------
