-- Phase 2, step 1 — customer auth linkage + addresses.
-- Plan: docs/PHASE2-WEBSITE.md (source: cha-jewels-web docs/tasks/phase2-plan.md).
--
-- WHAT THE PLAN ASSUMED vs WHAT IS LIVE (checked 2026-09-10):
--   - "Schema additions: customers.auth_user_id" — ALREADY EXISTS, already
--     indexed (idx_customers_auth_user_id, partial WHERE NOT NULL). 122 of 882
--     customers are linked. Nothing to add.
--   - It is NOT unique. That is the real gap: /auth/customer and /me look a
--     customer up BY auth user, so two rows sharing one auth_user_id would make
--     the lookup ambiguous and could serve one customer another's profile.
--     Section 1 closes it.
--   - customer_addresses does not exist. Section 2 creates it and backfills
--     from the flat columns already on customers (704 of 882 populated).
--
-- PHONE OTP — DECISION NEEDED BEFORE THE PLAN'S PRIMARY AUTH CAN SHIP.
-- The live linking rule (setup-customer-account) matches an auth user to a
-- customer by the JWT's verified EMAIL, protected by the existing partial
-- unique index on lower(email) WHERE auth_user_id IS NOT NULL. A phone-OTP
-- user has NO email, and mobile_number has no unique index. Measured today:
--     863 customers have a phone, but only 77 are clean E.164,
--     and 10 groups of customers collide once digits are normalised.
-- So linking by phone would need an E.164 normalisation pass and a decision on
-- those 10 collisions before it could be made unique. Until then, matching on
-- phone would risk attaching a new signup to the WRONG existing customer —
-- handing over someone else's order history and loyalty balance.
-- Step 1 therefore ships EMAIL linkage only, and /auth/customer rejects a JWT
-- with no email rather than creating an unlinkable orphan row.
--
-- FLAT ADDRESS COLUMNS ARE NOT DROPPED. customers.address_line1 / city /
-- postal_code / country / location stay: the Hub UI reads them today. Dropping
-- them is a separate migration after the Hub UI moves to customer_addresses.
-- Until then customer_addresses is the storefront's source and the flat columns
-- are the Hub's; the backfill seeds the former from the latter ONCE.

-- ============================================================ 1. auth linkage
-- Partial, so the 760 unlinked customers (auth_user_id IS NULL) are unaffected.
-- Verified 0 duplicates before writing this, so it will not fail on live data.
CREATE UNIQUE INDEX IF NOT EXISTS customers_auth_user_id_unique
  ON public.customers (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

COMMENT ON COLUMN public.customers.auth_user_id IS
  'Supabase Auth user linked to this customer. One customer per auth user (customers_auth_user_id_unique). Set by setup-customer-account (portal) and POST /auth/customer (storefront), both matching on the JWT verified email.';

-- ========================================================= 2. customer_addresses
CREATE TABLE IF NOT EXISTS public.customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  label text,
  recipient_name text,
  line1 text NOT NULL,
  line2 text,
  city text,
  region text,
  postal_code text,
  country text NOT NULL DEFAULT 'JP',
  phone text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.customer_addresses IS
  'Delivery addresses for storefront checkout. Written only by the website edge function (service role). Seeded once from the flat address columns on customers, which are NOT dropped.';
COMMENT ON COLUMN public.customer_addresses.region IS
  'Prefecture (JP) or province (PH). Named region rather than state to suit both.';

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
  ON public.customer_addresses (customer_id);

-- At most one default per customer, enforced rather than assumed: PUT
-- /me/addresses replaces the whole list and would otherwise be able to mark two.
CREATE UNIQUE INDEX IF NOT EXISTS customer_addresses_one_default
  ON public.customer_addresses (customer_id)
  WHERE is_default;

DROP TRIGGER IF EXISTS trg_customer_addresses_updated_at ON public.customer_addresses;
CREATE TRIGGER trg_customer_addresses_updated_at
  BEFORE UPDATE ON public.customer_addresses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS: enabled with NO anon or authenticated policy, so only service_role
-- reaches it. This is deliberate and matches CLAUDE.md: all customer-facing
-- writes go through a service-role edge function, and an anon/authenticated
-- policy that references another RLS-protected table (customers) fails closed
-- silently (Bug #165). Do not add a customer-facing policy here — add the
-- route to the website function instead.
ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.customer_addresses TO service_role;

-- ================================================================ 3. backfill
-- One row per customer that has any flat address data, marked default.
-- line1 is NOT NULL, so fall back to city/location when address_line1 is blank
-- rather than dropping the address; skip only rows with nothing usable.
-- Guarded by NOT EXISTS so re-running never duplicates.
INSERT INTO public.customer_addresses
  (customer_id, label, recipient_name, line1, city, postal_code, country, phone, is_default)
SELECT
  c.id,
  'imported',
  NULLIF(btrim(c.full_name), ''),
  COALESCE(
    NULLIF(btrim(c.address_line1), ''),
    NULLIF(btrim(c.city), ''),
    NULLIF(btrim(c.location), '')
  ),
  NULLIF(btrim(c.city), ''),
  NULLIF(btrim(c.postal_code), ''),
  COALESCE(NULLIF(btrim(c.country), ''), 'JP'),
  NULLIF(btrim(c.mobile_number), ''),
  true
FROM public.customers c
WHERE COALESCE(
        NULLIF(btrim(c.address_line1), ''),
        NULLIF(btrim(c.city), ''),
        NULLIF(btrim(c.location), '')
      ) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.customer_addresses a WHERE a.customer_id = c.id
  );

-- Verification after applying:
--   -- expect dupes = 0
--   SELECT count(*) AS dupes FROM (
--     SELECT auth_user_id FROM public.customers
--     WHERE auth_user_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d;
--   -- expect addresses ≈ 704, every one default, none with a null line1
--   SELECT count(*) AS addresses,
--          count(*) FILTER (WHERE is_default) AS defaults,
--          count(*) FILTER (WHERE line1 IS NULL) AS bad_line1
--   FROM public.customer_addresses;

-- =========================================== 4. replace_customer_addresses RPC
-- PUT /me/addresses replaces the whole list. Doing that as DELETE-then-INSERT
-- over two PostgREST calls is not atomic: if the insert fails the customer is
-- left with no addresses. This does both in one transaction, so a bad payload
-- leaves the existing list untouched.
--
-- SECURITY DEFINER with a fixed search_path, and it takes the customer_id the
-- edge function already resolved from the JWT — it does NOT trust a caller to
-- name a customer. EXECUTE is granted to service_role only; the function is
-- unreachable from anon/authenticated, matching the table's RLS posture.
CREATE OR REPLACE FUNCTION public.replace_customer_addresses(
  p_customer_id uuid,
  p_addresses jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_inserted int;
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'customer_id_required');
  END IF;
  IF p_addresses IS NULL OR jsonb_typeof(p_addresses) <> 'array' THEN
    RETURN jsonb_build_object('error', 'addresses_must_be_array');
  END IF;

  v_count := jsonb_array_length(p_addresses);
  IF v_count > 20 THEN
    RETURN jsonb_build_object('error', 'too_many_addresses');
  END IF;

  -- Every entry needs a line1; reject the whole payload rather than silently
  -- dropping entries the customer thinks they saved.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_addresses) e
    WHERE COALESCE(btrim(e->>'line1'), '') = ''
  ) THEN
    RETURN jsonb_build_object('error', 'line1_required');
  END IF;

  DELETE FROM public.customer_addresses WHERE customer_id = p_customer_id;

  -- The first entry is the default unless exactly one entry says is_default.
  -- customer_addresses_one_default would otherwise reject a payload marking two.
  WITH src AS (
    SELECT e, row_number() OVER () AS rn,
           COALESCE((e->>'is_default')::boolean, false) AS wants_default
    FROM jsonb_array_elements(p_addresses) e
  ), flagged AS (
    SELECT e, rn,
           CASE
             WHEN (SELECT count(*) FROM src s2 WHERE s2.wants_default) = 1 THEN wants_default
             ELSE rn = 1
           END AS is_default
    FROM src
  )
  INSERT INTO public.customer_addresses
    (customer_id, label, recipient_name, line1, line2, city, region, postal_code, country, phone, is_default)
  SELECT
    p_customer_id,
    NULLIF(btrim(e->>'label'), ''),
    NULLIF(btrim(e->>'recipient_name'), ''),
    btrim(e->>'line1'),
    NULLIF(btrim(e->>'line2'), ''),
    NULLIF(btrim(e->>'city'), ''),
    NULLIF(btrim(e->>'region'), ''),
    NULLIF(btrim(e->>'postal_code'), ''),
    COALESCE(NULLIF(btrim(e->>'country'), ''), 'JP'),
    NULLIF(btrim(e->>'phone'), ''),
    is_default
  FROM flagged;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'count', v_inserted);
END $$;

REVOKE ALL ON FUNCTION public.replace_customer_addresses(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_customer_addresses(uuid, jsonb) TO service_role;
