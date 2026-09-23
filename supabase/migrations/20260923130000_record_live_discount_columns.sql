-- ============================================================================
-- RECORD-ONLY: the live discount columns and their discount_type CHECKs
--
-- These exist live and in no migration (docs/OPEN-BUGS.md, found 2026-09-23 by
-- the preflight of docs/sql/20260923_web_order_gaps_assertions.sql). They were
-- added on 2026-07-09 for the Account Financial Breakdown (docs/SCHEMA-FACTS.md
-- "AFB — discount + shipping columns"), directly on live. A rebuild from
-- supabase/migrations/ therefore lacked all six columns and both CHECKs, and
-- every writer — EditAccountDialog, CashOrderDetail Manage Invoice,
-- _shared/order-extras.ts — would fail on a fresh environment.
--
-- ON LIVE THIS IS A NO-OP. Section 1 runs FIRST and writes nothing: for every
-- column and constraint that already exists it PROVES live carries exactly
-- what this file records — type, nullability, default, constraint text — and
-- RAISEs before any write if not, so the record can never silently disagree
-- with live, whether or not the file is applied as a single transaction.
-- Section 2 then adds only what is absent (ADD COLUMN IF NOT EXISTS; each
-- constraint only when missing), which on live is nothing.
--
-- Sources of the definitions:
--   columns      docs/SCHEMA-FACTS.md:594 — discount_amount numeric (layaway
--                15,2 / cash 12,2) NOT NULL default 0; discount_type text
--                nullable; discount_value numeric nullable
--   constraints  pg_constraint on live, supplied by the owner 2026-09-23:
--                CHECK (((discount_type IS NULL) OR (discount_type = ANY
--                (ARRAY['amount'::text, 'percent'::text]))))
--
-- NOT recorded here, and filed in docs/OPEN-BUGS.md: shipping_fee on both
-- tables belongs to the same 2026-07-09 change and is equally absent from the
-- migrations, but it is outside the owner-approved scope of this pass.
-- ============================================================================

-- ------------------------------ 1. prove what exists matches (writes nothing)
DO $proof$
DECLARE
  v_row    record;
  v_bad    text := '';
  v_check  CONSTANT text :=
    'CHECK (((discount_type IS NULL) OR (discount_type = ANY (ARRAY[''amount''::text, ''percent''::text]))))';
BEGIN
  FOR v_row IN
    SELECT w.tbl, w.col, w.want_type, w.want_notnull, w.want_default,
           format_type(a.atttypid, a.atttypmod)            AS got_type,
           a.attnotnull                                    AS got_notnull,
           pg_get_expr(d.adbin, d.adrelid)                 AS got_default
      FROM (VALUES
        ('layaway_accounts', 'discount_amount', 'numeric(15,2)', true,  '0'),
        ('layaway_accounts', 'discount_type',   'text',          false, NULL),
        ('layaway_accounts', 'discount_value',  'numeric',       false, NULL),
        ('cash_orders',      'discount_amount', 'numeric(12,2)', true,  '0'),
        ('cash_orders',      'discount_type',   'text',          false, NULL),
        ('cash_orders',      'discount_value',  'numeric',       false, NULL)
      ) AS w(tbl, col, want_type, want_notnull, want_default)
      JOIN pg_attribute a
        ON a.attrelid = ('public.' || w.tbl)::regclass AND a.attname = w.col AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  LOOP
    -- A numeric default of zero is spelled '0' or '0.00' depending on how it
    -- was typed; both mean the same default and both are accepted.
    IF v_row.got_type <> v_row.want_type
       OR v_row.got_notnull <> v_row.want_notnull
       OR (v_row.want_default IS NULL AND v_row.got_default IS NOT NULL)
       OR (v_row.want_default IS NOT NULL AND coalesce(v_row.got_default, '<none>') NOT IN ('0', '0.00', '0.0'))
    THEN
      v_bad := v_bad || format(E'\n  %s.%s: live %s notnull=%s default=%s — recorded %s notnull=%s default=%s',
        v_row.tbl, v_row.col, v_row.got_type, v_row.got_notnull, coalesce(v_row.got_default, 'none'),
        v_row.want_type, v_row.want_notnull, coalesce(v_row.want_default, 'none'));
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS got
      FROM pg_constraint c
     WHERE (c.conrelid, c.conname) IN (('public.layaway_accounts'::regclass, 'layaway_accounts_discount_type_check'),
                                       ('public.cash_orders'::regclass,      'cash_orders_discount_type_check'))
  LOOP
    IF v_row.got <> v_check THEN
      v_bad := v_bad || format(E'\n  %s.%s: live %s', v_row.tbl, v_row.conname, v_row.got);
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — live differs from this record; nothing was written. Correct the record to match live:%', v_bad;
  END IF;
END
$proof$;

-- ------------------------------------------ 2. add only what is absent
ALTER TABLE public.layaway_accounts
  ADD COLUMN IF NOT EXISTS discount_amount numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_type   text,
  ADD COLUMN IF NOT EXISTS discount_value  numeric;

ALTER TABLE public.cash_orders
  ADD COLUMN IF NOT EXISTS discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_type   text,
  ADD COLUMN IF NOT EXISTS discount_value  numeric;

DO $record$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.layaway_accounts'::regclass
                    AND conname = 'layaway_accounts_discount_type_check') THEN
    ALTER TABLE public.layaway_accounts
      ADD CONSTRAINT layaway_accounts_discount_type_check
      CHECK (discount_type IS NULL OR discount_type = ANY (ARRAY['amount'::text, 'percent'::text]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.cash_orders'::regclass
                    AND conname = 'cash_orders_discount_type_check') THEN
    ALTER TABLE public.cash_orders
      ADD CONSTRAINT cash_orders_discount_type_check
      CHECK (discount_type IS NULL OR discount_type = ANY (ARRAY['amount'::text, 'percent'::text]));
  END IF;
END
$record$;
