-- Transfer payment details: structured columns + an audited admin editor.
--
-- WHY THIS REPLACES FREE TEXT
-- payment_instructions currently holds body_ja / body_en — two prose blobs
-- seeded with placeholders ("details are being finalised"). Two problems:
--   1. The storefront renders a blob, so a bank name and an account number are
--      indistinguishable to the page. It cannot label them, order them, or
--      decide whether the details are usable.
--   2. Nothing can tell "filled in" from "placeholder". A blob is always
--      non-empty, so checkout would happily offer bank transfer and show a
--      customer a paragraph saying the account is not ready yet.
-- Structured columns fix both: the API can tell complete details from absent
-- ones, and the storefront renders a labelled list.
--
-- body_ja / body_en are KEPT for now (nothing reads them after this step) so
-- the change is reversible; a later migration drops them.

ALTER TABLE public.payment_instructions
  ADD COLUMN IF NOT EXISTS bank_name      text,
  ADD COLUMN IF NOT EXISTS bank_branch    text,
  ADD COLUMN IF NOT EXISTS account_type   text,
  ADD COLUMN IF NOT EXISTS account_number text,
  ADD COLUMN IF NOT EXISTS account_holder text,
  ADD COLUMN IF NOT EXISTS gcash_number   text,
  ADD COLUMN IF NOT EXISTS gcash_name     text,
  ADD COLUMN IF NOT EXISTS note_ja        text,
  ADD COLUMN IF NOT EXISTS note_en        text,
  ADD COLUMN IF NOT EXISTS updated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- updated_at already exists on this table (added with it). Named here only so
-- the column list in the task reads complete; IF NOT EXISTS makes it a no-op.
ALTER TABLE public.payment_instructions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.payment_instructions.account_number IS
  'Bank account number. Entered by an admin in the Hub (Settings -> Payment Details) and never seeded, never placeholdered. Masked in the Hub list view. The website function returns it only for the customer''s own pending-transfer order.';
COMMENT ON COLUMN public.payment_instructions.updated_by IS
  'auth user who last saved this row. Written by the Hub editor alongside an audit_logs entry (entity_type = ''payment_instructions'').';

-- ===================================================== placeholders must go
-- The seeded body_ja / body_en say the details are being finalised. Nothing
-- reads them after this migration, but leaving live-looking placeholder prose
-- in a table named payment_instructions is how it ends up on a page later.
-- Blanked, not deleted: the columns stay, the misleading content does not.
UPDATE public.payment_instructions
   SET body_ja = NULL, body_en = NULL
 WHERE body_ja LIKE '%準備中%' OR body_en ILIKE '%being finalised%';

-- ============================================================ RLS unchanged
-- payment_instructions_staff_read (SELECT, authenticated) and
-- payment_instructions_admin_write (ALL, has_role admin) already exist and are
-- correct for this feature: any signed-in staff member can read the labels,
-- only an admin can write. has_role() is SECURITY DEFINER, so the policy does
-- not read another RLS-protected table — Bug #165's fail-closed trap does not
-- apply. No policy changes here.

-- ============================================================ VERIFICATION
--   -- 10 new columns present, updated_at already there
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='payment_instructions'
--    ORDER BY ordinal_position;
--   -- both rows exist, both blanked, no details yet (admin enters them in the Hub)
--   SELECT country, bank_name, account_number, gcash_number, body_ja, body_en
--     FROM public.payment_instructions ORDER BY country;
