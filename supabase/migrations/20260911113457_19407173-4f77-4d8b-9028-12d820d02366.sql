-- Transfer payment methods: a LIST per region, replacing the one-row-per-country
-- payment_instructions design.
--
-- WHY A LIST
-- payment_instructions held exactly one row per country, with one bank block and
-- one GCash block welded into it. That shape cannot express what actually
-- happens: two banks for Japan, GCash and Maya and a bank for overseas, a method
-- switched off for a week while an account is re-verified, or a preferred method
-- that should appear first. Every one of those needed a schema change under the
-- old design. Here they are rows.
--
-- WHY REGION, NOT COUNTRY
-- The business has two transfer setups, not one per country: yen accounts for
-- customers shipping inside Japan, and the wallets/accounts used for everyone
-- else. Keying by country meant a customer in Singapore matched no row and was
-- offered nothing, and adding a country meant re-entering the same account
-- details. Region is derived from the shipping country at request time:
-- Japan -> 'JP', every other country -> 'OVERSEAS'.
--
-- NO PLACEHOLDERS. Nothing in this migration invents an account number, a
-- wallet number, or a holder name. Rows arrive only by copying details an admin
-- already saved, or from the Hub editor. A region with no complete active method
-- does not offer transfer at checkout at all — that is the intended behaviour,
-- not a gap to paper over with example values.

CREATE TABLE IF NOT EXISTS public.transfer_payment_methods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region         text NOT NULL CHECK (region IN ('JP', 'OVERSEAS')),
  method_type    text NOT NULL CHECK (method_type IN ('bank', 'gcash', 'maya', 'other')),

  -- What the customer sees as the heading of the card, per language.
  label_ja       text,
  label_en       text,

  -- Bank fields. Used when method_type = 'bank' (and permitted, but not
  -- expected, on 'other' — some overseas methods are a bank under another name).
  bank_name      text,
  bank_branch    text,
  account_type   text,
  account_number text,
  account_holder text,

  -- Wallet fields. Used when method_type is 'gcash' or 'maya'.
  wallet_number  text,
  wallet_name    text,

  -- Free-form extra line shown under the fields (e.g. "fees paid by sender").
  note_ja        text,
  note_en        text,

  sort_order     integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.transfer_payment_methods IS
  'Bank / wallet methods offered for bank-transfer checkout, one row per method, grouped by region (JP = ships inside Japan, OVERSEAS = everywhere else). Read live by the website edge function; edited in the Hub at Settings -> Payment Details. Never seed account numbers here.';
COMMENT ON COLUMN public.transfer_payment_methods.region IS
  'JP or OVERSEAS. Derived from the shipping address country at request time: Japan -> JP, any other country -> OVERSEAS. A customer is never shown the other region''s methods.';
COMMENT ON COLUMN public.transfer_payment_methods.account_number IS
  'Entered by an admin in the Hub, never seeded. Masked in the Hub list and revealed on click; returned by the website function only to the customer who owns the pending-transfer order.';
COMMENT ON COLUMN public.transfer_payment_methods.sort_order IS
  'Display order within a region, ascending. Ties break on created_at so the order is always total and stable.';
COMMENT ON COLUMN public.transfer_payment_methods.is_active IS
  'Switched off methods stay for their history but are never returned to the storefront. A region whose active methods are all incomplete offers no transfer at all.';

-- The storefront read is always "active methods for one region, in order".
CREATE INDEX IF NOT EXISTS idx_transfer_methods_region_order
  ON public.transfer_payment_methods (region, sort_order, created_at)
  WHERE is_active;

DROP TRIGGER IF EXISTS trg_transfer_payment_methods_updated_at ON public.transfer_payment_methods;
CREATE TRIGGER trg_transfer_payment_methods_updated_at
  BEFORE UPDATE ON public.transfer_payment_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ==================================================================== RLS
-- Same split payment_instructions used and for the same reason: any signed-in
-- staff member may read (support needs to answer "which account did we send
-- them?"), only an admin may write. has_role() is SECURITY DEFINER, so this
-- policy does not read another RLS-protected table — Bug #165's fail-closed
-- trap does not apply.
ALTER TABLE public.transfer_payment_methods ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.transfer_payment_methods TO service_role;

DO $$ BEGIN
  CREATE POLICY transfer_payment_methods_staff_read ON public.transfer_payment_methods
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY transfer_payment_methods_admin_write ON public.transfer_payment_methods
    FOR ALL TO authenticated
    USING (public.has_role(auth.uid(), 'admin'::app_role))
    WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================== carry over anything saved
-- payment_instructions may or may not have the structured columns, depending on
-- whether the (now superseded) structured-columns migration was ever applied.
-- Both cases are real, so the copy checks before it reads: with the columns, any
-- saved bank/wallet details become rows here; without them, there is nothing
-- structured to copy and the block is a no-op. The prose body_ja/body_en are NOT
-- copied — they are placeholder text by construction and a blob cannot become a
-- labelled field.
--
-- Guarded by NOT EXISTS on the whole table so re-running the migration cannot
-- duplicate methods.
DO $$
DECLARE
  v_structured boolean;
  v_existing   integer;
BEGIN
  SELECT count(*) INTO v_existing FROM public.transfer_payment_methods;
  IF v_existing > 0 THEN
    RAISE NOTICE 'transfer_payment_methods already populated (% rows) — copy skipped.', v_existing;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'payment_instructions'
       AND column_name  = 'account_number'
  ) INTO v_structured;

  IF NOT v_structured THEN
    RAISE NOTICE 'payment_instructions has no structured columns — nothing to copy.';
    RETURN;
  END IF;

  -- Bank details, one row per country that has any of them.
  EXECUTE $q$
    INSERT INTO public.transfer_payment_methods
      (region, method_type, label_ja, label_en,
       bank_name, bank_branch, account_type, account_number, account_holder,
       note_ja, note_en, sort_order, is_active)
    SELECT
      CASE WHEN upper(btrim(pi.country)) = 'JP' THEN 'JP' ELSE 'OVERSEAS' END,
      'bank',
      NULLIF(btrim(coalesce(pi.method_label_ja, '')), ''),
      NULLIF(btrim(coalesce(pi.method_label_en, '')), ''),
      NULLIF(btrim(coalesce(pi.bank_name, '')), ''),
      NULLIF(btrim(coalesce(pi.bank_branch, '')), ''),
      NULLIF(btrim(coalesce(pi.account_type, '')), ''),
      NULLIF(btrim(coalesce(pi.account_number, '')), ''),
      NULLIF(btrim(coalesce(pi.account_holder, '')), ''),
      NULLIF(btrim(coalesce(pi.note_ja, '')), ''),
      NULLIF(btrim(coalesce(pi.note_en, '')), ''),
      10,
      coalesce(pi.is_active, true)
    FROM public.payment_instructions pi
    WHERE coalesce(NULLIF(btrim(coalesce(pi.bank_name, '')), ''),
                   NULLIF(btrim(coalesce(pi.account_number, '')), ''),
                   NULLIF(btrim(coalesce(pi.account_holder, '')), '')) IS NOT NULL
  $q$;

  -- GCash details, likewise.
  EXECUTE $q$
    INSERT INTO public.transfer_payment_methods
      (region, method_type, label_ja, label_en,
       wallet_number, wallet_name, sort_order, is_active)
    SELECT
      CASE WHEN upper(btrim(pi.country)) = 'JP' THEN 'JP' ELSE 'OVERSEAS' END,
      'gcash', 'GCash', 'GCash',
      NULLIF(btrim(coalesce(pi.gcash_number, '')), ''),
      NULLIF(btrim(coalesce(pi.gcash_name, '')), ''),
      20,
      coalesce(pi.is_active, true)
    FROM public.payment_instructions pi
    WHERE coalesce(NULLIF(btrim(coalesce(pi.gcash_number, '')), ''),
                   NULLIF(btrim(coalesce(pi.gcash_name, '')), '')) IS NOT NULL
  $q$;

  RAISE NOTICE 'Copied % method(s) from payment_instructions.',
    (SELECT count(*) FROM public.transfer_payment_methods);
END $$;

-- payment_instructions is now unused by all code. Left in place with its data
-- so this migration is reversible; a later cleanup drops it.
COMMENT ON TABLE public.payment_instructions IS
  'SUPERSEDED 2026-09-11 by transfer_payment_methods. No code reads this table. Kept only so the switch to the per-method list is reversible; drop it in a later cleanup migration.';