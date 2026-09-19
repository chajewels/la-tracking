-- Page365 order link -> Hub order: draft staging, provenance columns, and
-- cross-table invoice-number uniqueness. 2026-09-19.
--
-- WHY EACH PIECE EXISTS
--
-- 1. page365_drafts. A CSR pastes a Page365 capability URL; the fetch function
--    parses it once and parks the result here for the confirmation screen to
--    read. It is staging, not a record: it expires, and it is consumed when an
--    order is created from it. The ?sig= is NEVER stored -- it is a bearer
--    credential for that invoice, and a row holding one would hand every future
--    reader the ability to re-fetch a customer's order from an external system.
--    Only the slug and the invoice number are kept.
--
-- 2. page365_no / page365_slug on both order tables. Provenance, so an imported
--    order can be traced back to the Page365 invoice it came from and a second
--    paste can be recognised as a duplicate instead of becoming a second order.
--    Both tables, per the ACCOUNT-SCOPE COVERAGE rule -- cash orders are
--    first-class accounts.
--
-- 3. invoice_numbers. `invoice_number` is UNIQUE within cash_orders and UNIQUE
--    within layaway_accounts, and there is NO constraint between them. Measured
--    live before writing this (2026-09-19):
--        cash_orders .................... 160 rows (156 numeric)
--        layaway_accounts .............. 1538 rows (1528 numeric)
--        combined ...................... 1698 rows
--        distinct invoice_number ....... 1698
--        cross-table duplicates ........... 0
--    So nothing is broken today and the backfill is exact: 1698 in, 1698 rows.
--    APPLIED 2026-09-19: 160 + 1543 = 1703 — five layaway plans were created
--    between this measurement and the run. The post-check below asserts
--    registry = cash + layaway, not the literal 1698, which is why that was fine.
--    But the same Page365 invoice could legally be imported once as a cash
--    order and once as a layaway plan, and today create-layaway-account does
--    not even pre-check its own table -- it relies on the index and surfaces a
--    raw Postgres error. This table makes the guarantee structural for both.
--
-- TRIGGER NAMING IS LOAD-BEARING. Postgres fires BEFORE triggers in NAME order.
-- `enforce_test_invoice_prefix` runs as trg_test_invoice_prefix_{cash,layaway}
-- BEFORE INSERT and rewrites invoice_number to TEST-<n> for is_test customers.
-- The registry trigger must therefore sort AFTER it, or it records the
-- un-prefixed number and the registry disagrees with the row. On layaway it
-- must also sort after trg_enforce_plan_minimum. The `trg_zz_` prefix does
-- both, and is not cosmetic.
--
-- THE BRIEF SAID "BEFORE INSERT" ONLY; THAT WOULD GO STALE. invoice_number is
-- mutable (the prefix trigger itself fires on UPDATE OF invoice_number), and
-- unpaid, never-completed orders can still be deleted by admin. An
-- insert-only registry would permanently burn the number of a deleted typo and
-- would miss renames entirely. INSERT, UPDATE and DELETE are all handled.

BEGIN;

-- ===========================================================================
-- 1. Provenance columns on both order tables.
-- ===========================================================================
ALTER TABLE public.cash_orders
  ADD COLUMN IF NOT EXISTS page365_no   bigint,
  ADD COLUMN IF NOT EXISTS page365_slug text;

ALTER TABLE public.layaway_accounts
  ADD COLUMN IF NOT EXISTS page365_no   bigint,
  ADD COLUMN IF NOT EXISTS page365_slug text;

COMMENT ON COLUMN public.cash_orders.page365_no IS
  'Page365 invoice number (the JSON''s `no`) this order was imported from. NULL for orders not imported from Page365.';
COMMENT ON COLUMN public.cash_orders.page365_slug IS
  'Page365 invoice slug. The ?sig= capability token is never stored -- see page365_drafts.';
COMMENT ON COLUMN public.layaway_accounts.page365_no IS
  'Page365 invoice number (the JSON''s `no`) this plan was imported from. NULL for plans not imported from Page365.';
COMMENT ON COLUMN public.layaway_accounts.page365_slug IS
  'Page365 invoice slug. The ?sig= capability token is never stored -- see page365_drafts.';

-- One imported order per Page365 invoice, per table. Partial so the ~1698
-- existing rows (all NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_orders_page365_no
  ON public.cash_orders (page365_no) WHERE page365_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_layaway_accounts_page365_no
  ON public.layaway_accounts (page365_no) WHERE page365_no IS NOT NULL;

-- ===========================================================================
-- 2. invoice_numbers -- the cross-table registry.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.invoice_numbers (
  invoice_number text PRIMARY KEY,
  source         text NOT NULL CHECK (source IN ('cash_order', 'layaway_account')),
  order_id       uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoice_numbers IS
  'One row per invoice_number in use across cash_orders AND layaway_accounts. Maintained entirely by triggers -- never written by application code. Its primary key is the cross-table uniqueness that neither per-table UNIQUE index can provide.';
COMMENT ON COLUMN public.invoice_numbers.invoice_number IS
  'The invoice number as stored on the order, AFTER enforce_test_invoice_prefix has applied any TEST- prefix.';
COMMENT ON COLUMN public.invoice_numbers.source IS
  'Which table holds the order: cash_order | layaway_account. Named in the error message a collision raises.';
COMMENT ON COLUMN public.invoice_numbers.order_id IS
  'The owning row''s id. Not an FK -- one column cannot reference two tables -- so the triggers keep it true.';

CREATE INDEX IF NOT EXISTS idx_invoice_numbers_order ON public.invoice_numbers (source, order_id);

ALTER TABLE public.invoice_numbers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.invoice_numbers TO authenticated;
GRANT ALL    ON public.invoice_numbers TO service_role;

-- Staff may read it (the Hub checks a number before offering to import).
-- NOBODY may write it directly, including service_role through PostgREST:
-- there is no INSERT/UPDATE/DELETE policy at all. The triggers below run as
-- the table owner and are unaffected by RLS.
DROP POLICY IF EXISTS "Staff can read invoice numbers" ON public.invoice_numbers;
CREATE POLICY "Staff can read invoice numbers" ON public.invoice_numbers
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- ---------------------------------------------------------------------------
-- 2a. Backfill. Same expression the trigger uses: the invoice_number exactly
--     as the row holds it, no filtering, no normalisation. (The 20260910140000
--     address backfill counted different columns from its INSERT and
--     manufactured 871 junk rows; that is the precedent this avoids.)
--
--     EVERY row is registered, including TEST- prefixed ones. A test invoice is
--     still a number in use, and leaving it out would let a real order claim it.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE
  v_cash      bigint;
  v_layaway   bigint;
  v_dupes     bigint;
  v_inserted  bigint;
  v_dupe_list text;
BEGIN
  SELECT count(*) INTO v_cash    FROM public.cash_orders;
  SELECT count(*) INTO v_layaway FROM public.layaway_accounts;

  -- Pre-check: report collisions rather than skipping them. If two rows share a
  -- number across the tables, the registry cannot represent both and the humans
  -- must decide which is real -- so fail the migration and name them.
  SELECT count(*), string_agg(invoice_number, ', ' ORDER BY invoice_number)
    INTO v_dupes, v_dupe_list
  FROM (
    SELECT invoice_number FROM public.cash_orders
    UNION ALL
    SELECT invoice_number FROM public.layaway_accounts
  ) a
  GROUP BY invoice_number HAVING count(*) > 1;

  v_dupes := COALESCE(v_dupes, 0);
  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'invoice_numbers backfill aborted: % invoice_number(s) exist in BOTH cash_orders and layaway_accounts and must be resolved by hand first: %',
      v_dupes, v_dupe_list;
  END IF;

  INSERT INTO public.invoice_numbers (invoice_number, source, order_id, created_at)
  SELECT invoice_number, 'cash_order', id, COALESCE(created_at, now()) FROM public.cash_orders
  UNION ALL
  SELECT invoice_number, 'layaway_account', id, COALESCE(created_at, now()) FROM public.layaway_accounts
  ON CONFLICT (invoice_number) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RAISE NOTICE 'invoice_numbers backfill: cash_orders=%, layaway_accounts=%, expected=%, inserted=%, cross-table duplicates=%',
    v_cash, v_layaway, v_cash + v_layaway, v_inserted, v_dupes;

  -- Post-check: the registry must hold exactly one row per order row.
  IF (SELECT count(*) FROM public.invoice_numbers) <> v_cash + v_layaway THEN
    RAISE EXCEPTION
      'invoice_numbers backfill post-check failed: registry holds % rows, orders total %',
      (SELECT count(*) FROM public.invoice_numbers), v_cash + v_layaway;
  END IF;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- 2b. The triggers that keep it true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_invoice_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_source text;
  v_holder text;
BEGIN
  -- Which table are we defending? Derived from TG_TABLE_NAME so one function
  -- serves both and the two can never drift apart.
  v_source := CASE TG_TABLE_NAME
                WHEN 'cash_orders'      THEN 'cash_order'
                WHEN 'layaway_accounts' THEN 'layaway_account'
              END;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'register_invoice_number() attached to unexpected table %', TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Release the number so a deleted typo does not burn it forever. Scoped by
    -- order_id as well as the number, so a row whose registry entry has already
    -- been claimed by something else is left alone.
    DELETE FROM public.invoice_numbers
     WHERE invoice_number = OLD.invoice_number
       AND source = v_source
       AND order_id = OLD.id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number THEN
    RETURN NEW;  -- nothing to do; the number did not move
  END IF;

  IF TG_OP = 'UPDATE' THEN
    DELETE FROM public.invoice_numbers
     WHERE invoice_number = OLD.invoice_number
       AND source = v_source
       AND order_id = OLD.id;
  END IF;

  -- Claim the new number. A collision names WHERE the number already lives,
  -- because "already exists" without that is the message a CSR cannot act on.
  SELECT source INTO v_holder
    FROM public.invoice_numbers WHERE invoice_number = NEW.invoice_number;

  IF v_holder IS NOT NULL THEN
    RAISE EXCEPTION 'invoice_number % already exists on %', NEW.invoice_number, v_holder
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.invoice_numbers (invoice_number, source, order_id)
  VALUES (NEW.invoice_number, v_source, NEW.id);

  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION public.register_invoice_number() IS
  'Maintains public.invoice_numbers for cash_orders and layaway_accounts. Must run AFTER enforce_test_invoice_prefix on INSERT/UPDATE (hence the trg_zz_ trigger names) so it records the final, possibly TEST- prefixed, value.';

REVOKE ALL ON FUNCTION public.register_invoice_number() FROM PUBLIC, anon, authenticated;

-- INSERT/UPDATE: BEFORE, so a collision aborts the write before the order row
-- exists. Named trg_zz_* to sort after trg_test_invoice_prefix_* and
-- trg_enforce_plan_minimum -- see the header note on BEFORE-trigger ordering.
DROP TRIGGER IF EXISTS trg_zz_invoice_registry_cash ON public.cash_orders;
CREATE TRIGGER trg_zz_invoice_registry_cash
  BEFORE INSERT OR UPDATE OF invoice_number ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.register_invoice_number();

DROP TRIGGER IF EXISTS trg_zz_invoice_registry_layaway ON public.layaway_accounts;
CREATE TRIGGER trg_zz_invoice_registry_layaway
  BEFORE INSERT OR UPDATE OF invoice_number ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.register_invoice_number();

-- DELETE: AFTER, so the number is released only once the delete has actually
-- survived trg_prevent_paid_order_delete and trg_prevent_web_*_delete.
DROP TRIGGER IF EXISTS trg_zz_invoice_registry_cash_del ON public.cash_orders;
CREATE TRIGGER trg_zz_invoice_registry_cash_del
  AFTER DELETE ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.register_invoice_number();

DROP TRIGGER IF EXISTS trg_zz_invoice_registry_layaway_del ON public.layaway_accounts;
CREATE TRIGGER trg_zz_invoice_registry_layaway_del
  AFTER DELETE ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.register_invoice_number();

-- ===========================================================================
-- 3. page365_drafts -- staging for a parsed Page365 invoice.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.page365_drafts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
  page365_no   bigint NOT NULL,
  page365_slug text NOT NULL,
  payload      jsonb NOT NULL,
  consumed_at  timestamptz
);

COMMENT ON TABLE public.page365_drafts IS
  'Parsed Page365 invoices awaiting CSR confirmation. Staging, not a record: rows expire after 2 hours and are stamped consumed_at when an order is created from them. NEVER holds the ?sig= capability token -- only the slug and invoice number.';
COMMENT ON COLUMN public.page365_drafts.created_by IS
  'The CSR who pasted the link. Also the only non-service caller who can read the row.';
COMMENT ON COLUMN public.page365_drafts.expires_at IS
  'A draft is a two-hour working copy. Past this it is neither readable by its author nor usable for creation -- re-paste the link instead of trusting stale prices.';
COMMENT ON COLUMN public.page365_drafts.page365_no IS
  'The Page365 invoice number (`no`). Checked against invoice_numbers before a draft is created, so a second paste of an imported invoice never produces one.';
COMMENT ON COLUMN public.page365_drafts.page365_slug IS
  'The invoice slug from the pasted URL path. The ?sig= query parameter is discarded after the single outbound fetch and is never persisted or logged.';
COMMENT ON COLUMN public.page365_drafts.payload IS
  'The parsed draft: customer, items (with Hub-hosted photo URLs), shipping_jpy, subtotal_jpy, total_jpy, fx. This is the evidence of what Page365 actually returned if a price is later disputed.';
COMMENT ON COLUMN public.page365_drafts.consumed_at IS
  'Stamped when an order is created from this draft. A consumed draft cannot be used again.';

CREATE INDEX IF NOT EXISTS idx_page365_drafts_creator ON public.page365_drafts (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page365_drafts_no      ON public.page365_drafts (page365_no);

ALTER TABLE public.page365_drafts ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.page365_drafts TO authenticated;
GRANT ALL    ON public.page365_drafts TO service_role;

-- Staff read their OWN unexpired drafts. No INSERT/UPDATE/DELETE policy:
-- drafts are created only by page365-fetch-order under the service role, which
-- bypasses RLS. A CSR cannot forge a draft with prices the external system
-- never returned.
DROP POLICY IF EXISTS "Staff read own page365 drafts" ON public.page365_drafts;
CREATE POLICY "Staff read own page365 drafts" ON public.page365_drafts
  FOR SELECT TO authenticated
  USING (created_by = auth.uid() AND public.is_staff(auth.uid()) AND expires_at > now());

COMMIT;
