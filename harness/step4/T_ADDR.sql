-- The address book, the checkout, and the order's own record of where it went.
--
-- Run it TWICE, and compare:
--
--   ./build.sh && psql -d chaharness -f T_ADDR.sql          # the live bodies
--   ./build.sh \
--     && psql -d chaharness -f ../../supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql \
--     && psql -d chaharness -f T_ADDR.sql                   # with the fix
--
-- The verdict table at the end names each of the three properties the fix has
-- to hold, prints the ACTUAL value beside the expected one, and says PASS or
-- FAIL. Before the fix, all three FAIL — that is the bug, reproduced rather
-- than described.
--
-- The endpoint is the same in both runs: `website` PUT /me/addresses calls
-- replace_customer_addresses. After the migration that name forwards to
-- upsert_customer_addresses, so a caller that has not been redeployed is
-- already safe. That is deliberate and this script exercises it: it calls the
-- OLD name throughout.
\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
UPDATE website_product_variants SET stock_qty = 50;

\echo '=== setup: a real customer with TWO saved addresses ==='
SELECT replace_customer_addresses('11111111-1111-4111-8111-111111111111', '[
  {"label":"Home","recipient_name":"Real Customer","line1":"1-2-3 Ginza","city":"Chuo","region":"Tokyo","postal_code":"104-0061","country":"JP","phone":"09011112222","is_default":true},
  {"label":"Office","recipient_name":"Real Customer","line1":"4-5-6 Marunouchi","city":"Chiyoda","region":"Tokyo","postal_code":"100-0005","country":"JP","phone":"09033334444"}
]'::jsonb) AS seeded;

CREATE TEMP TABLE before_ids AS
  SELECT id, label FROM customer_addresses
   WHERE customer_id = '11111111-1111-4111-8111-111111111111';
SELECT label, id FROM before_ids ORDER BY label;

\echo ''
\echo '=== setup: a CASH order shipped to Home, through the real writer ==='
SELECT mk_quote('11111111-1111-4111-8111-111111111111','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date) AS q \gset
-- mk_quote builds a layaway-mode quote; create_web_order_atomic wants mode
-- 'full' and reads the shipping fields, which are already right. The address
-- and recipient are what the `website` function writes from the request body.
UPDATE checkout_quotes SET mode='full',
       ship_to_address_id = (SELECT id FROM before_ids WHERE label='Home'),
       recipient_name = 'Real Customer', recipient_phone = '09011112222'
 WHERE id = :'q';
SELECT (create_web_order_atomic('11111111-1111-4111-8111-111111111111', :'q', 'transfer','en')->>'order_id') AS cash_id \gset

\echo '=== setup: a WEB LAYAWAY shipped to Office, through the real writer ==='
SELECT mk_quote('11111111-1111-4111-8111-111111111111','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date) AS q2 \gset
UPDATE checkout_quotes SET ship_to_address_id = (SELECT id FROM before_ids WHERE label='Office'),
       recipient_name = 'Real Customer', recipient_phone = '09033334444'
 WHERE id = :'q2';
SELECT (create_web_layaway_atomic('11111111-1111-4111-8111-111111111111', :'q2',
        'en', now()+interval '72 hours', current_date)->>'account_id') AS lay_id \gset

CREATE TEMP TABLE before_orders AS
  -- to_jsonb(row)->'ship_to_snapshot' rather than the bare column, so this
  -- script also runs against the PRE-FIX schema, where the column does not
  -- exist yet — an absent key reads as NULL instead of erroring. That is the
  -- point of the two-run comparison.
  SELECT 'cash' AS kind, ship_to_address_id AS fk, to_jsonb(c.*)->'ship_to_snapshot' AS snap
    FROM cash_orders c WHERE c.id = :'cash_id'
  UNION ALL
  SELECT 'layaway', NULL::uuid, to_jsonb(l.*)->'ship_to_snapshot'
    FROM layaway_accounts l WHERE l.id = :'lay_id';
SELECT kind, fk IS NOT NULL AS has_fk, snap->>'line1' AS snapshot_line1 FROM before_orders ORDER BY kind;

\echo ''
\echo '=== THE CHECKOUT: the customer adds a THIRD address and re-sends all three ==='
\echo '--- exactly what checkout-flow.tsx does: the full list, existing entries carrying their ids'
SELECT replace_customer_addresses('11111111-1111-4111-8111-111111111111',
  (SELECT jsonb_agg(e) FROM (
     SELECT jsonb_build_object('id', a.id, 'label', a.label, 'recipient_name', a.recipient_name,
            'line1', a.line1, 'city', a.city, 'region', a.region,
            'postal_code', a.postal_code, 'country', a.country, 'phone', a.phone,
            'is_default', a.is_default) AS e
       FROM customer_addresses a
      WHERE a.customer_id = '11111111-1111-4111-8111-111111111111'
      UNION ALL
     SELECT jsonb_build_object('label','Parents','recipient_name','Someone Else',
            'line1','7-8-9 Namba','city','Osaka','region','Osaka','postal_code','542-0076',
            'country','JP','phone','09055556666')
   ) s) ) AS after_checkout;

-- Captured HERE, before property 3's delete, so the count is the count as the
-- checkout left it.
CREATE TEMP TABLE after_checkout_ids AS
  SELECT id, label FROM customer_addresses
   WHERE customer_id = '11111111-1111-4111-8111-111111111111';
SELECT label, id, is_default FROM customer_addresses
 WHERE customer_id = '11111111-1111-4111-8111-111111111111' ORDER BY label;

\echo ''
\echo '=== property 3: the customer DELETES an address ==='
\echo '--- not reachable from today''s storefront, but the FK is ON DELETE SET NULL,'
\echo '--- so this is what a delete route would do to the order tomorrow.'
DELETE FROM customer_addresses WHERE id = (SELECT id FROM before_ids WHERE label='Home');

\echo ''
\echo '=== VERDICT ==='
WITH survived AS (
  SELECT count(*) AS n FROM before_ids b
   WHERE EXISTS (SELECT 1 FROM after_checkout_ids a WHERE a.id = b.id)
), cash_now AS (
  SELECT ship_to_address_id AS fk, to_jsonb(c.*)->'ship_to_snapshot' AS snap
    FROM cash_orders c WHERE c.id = :'cash_id'
), lay_now AS (
  SELECT to_jsonb(l.*)->'ship_to_snapshot' AS snap FROM layaway_accounts l WHERE l.id = :'lay_id'
)
SELECT * FROM (VALUES
  ('1. adding a third address leaves the existing ids alone',
   (SELECT n::text FROM survived) || ' of 2 original ids survived; rows after the checkout: '
     || (SELECT count(*)::text FROM after_checkout_ids),
   '2 of 2 original ids survived; rows after the checkout: 3',
   CASE WHEN (SELECT n FROM survived) = 2 AND (SELECT count(*) FROM after_checkout_ids) = 3
        THEN 'PASS' ELSE 'FAIL' END),

  ('2. a past order''s address is unchanged by that checkout',
   'cash snapshot ' || COALESCE((SELECT snap->>'line1' FROM cash_now), '(null)')
     || ' / layaway snapshot ' || COALESCE((SELECT snap->>'line1' FROM lay_now), '(null)'),
   'cash snapshot 1-2-3 Ginza / layaway snapshot 4-5-6 Marunouchi',
   CASE WHEN (SELECT snap->>'line1' FROM cash_now) = '1-2-3 Ginza'
         AND (SELECT snap->>'line1' FROM lay_now)  = '4-5-6 Marunouchi'
        THEN 'PASS' ELSE 'FAIL' END),

  ('3. deleting an address leaves the order''s snapshot intact',
   'fk is ' || CASE WHEN (SELECT fk FROM cash_now) IS NULL THEN 'NULL' ELSE 'set' END
     || ', snapshot is ' || COALESCE((SELECT snap->>'line1' FROM cash_now), '(null)'),
   'fk is NULL, snapshot is 1-2-3 Ginza',
   CASE WHEN (SELECT fk FROM cash_now) IS NULL
         AND (SELECT snap->>'line1' FROM cash_now) = '1-2-3 Ginza'
        THEN 'PASS' ELSE 'FAIL' END)
) v(property, actual, expected, verdict);
