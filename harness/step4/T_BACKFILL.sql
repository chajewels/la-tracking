-- Section 5 of 20260915160000: the backfill, exercised rather than asserted.
--
-- Two steps, in this order — the whole point is that the orders exist BEFORE
-- the migration, written by the pre-fix writers that do not take a snapshot:
--
--   ./build.sh
--   psql -d chaharness -f T_BACKFILL.sql                       # creates them
--   psql -d chaharness -f ../../supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql
--   psql -d chaharness -f T_BACKFILL_CHECK.sql                 # counts them
--
-- The migration's own DO block RAISEs if it leaves a web order with no
-- snapshot while its address still resolves, so step 2 failing IS the report.
\pset pager off
UPDATE website_product_variants SET stock_qty = 50;

SELECT replace_customer_addresses('11111111-1111-4111-8111-111111111111', '[
  {"label":"Home","recipient_name":"Real Customer","line1":"1-2-3 Ginza","city":"Chuo","region":"Tokyo","postal_code":"104-0061","country":"JP","phone":"09011112222","is_default":true}
]'::jsonb) AS seeded;

SELECT id AS addr FROM customer_addresses
 WHERE customer_id = '11111111-1111-4111-8111-111111111111' \gset

-- one web CASH order
SELECT mk_quote('11111111-1111-4111-8111-111111111111','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date) AS q \gset
UPDATE checkout_quotes SET mode='full', ship_to_address_id = :'addr',
       recipient_name='Real Customer', recipient_phone='09011112222' WHERE id = :'q';
SELECT create_web_order_atomic('11111111-1111-4111-8111-111111111111', :'q', 'transfer','en')->>'web_reference' AS cash_order;

-- one web LAYAWAY
SELECT mk_quote('11111111-1111-4111-8111-111111111111','b0000000-0000-4000-8000-000000000002',1,6,'JPY',2000,NULL,current_date) AS q2 \gset
UPDATE checkout_quotes SET ship_to_address_id = :'addr',
       recipient_name='Real Customer', recipient_phone='09011112222' WHERE id = :'q2';
SELECT create_web_layaway_atomic('11111111-1111-4111-8111-111111111111', :'q2',
       'en', now()+interval '72 hours', current_date)->>'web_reference' AS layaway;

\echo '--- pre-check, the same shape the migration header states for live:'
SELECT
  (SELECT count(*) FROM cash_orders WHERE source_channel='web') AS web_cash_orders,
  (SELECT count(*) FROM cash_orders c WHERE c.source_channel='web' AND c.ship_to_address_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM customer_addresses a WHERE a.id=c.ship_to_address_id)) AS cash_fk_resolves,
  (SELECT count(*) FROM layaway_accounts WHERE source_channel='web') AS web_layaways,
  (SELECT count(*) FROM layaway_accounts l JOIN checkout_quotes q ON q.id=l.quote_id
     JOIN customer_addresses a ON a.id=q.ship_to_address_id WHERE l.source_channel='web') AS layaway_fk_resolves;
\echo '--- expected writes: 1 cash + 1 layaway. Now load the migration, then T_BACKFILL_CHECK.sql.'
