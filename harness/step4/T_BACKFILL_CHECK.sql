-- Post-check for T_BACKFILL.sql. Run AFTER loading 20260915160000.
\pset pager off
SELECT * FROM (VALUES (
  'backfill filled every web order whose address still resolves',
  (SELECT count(*) FROM cash_orders WHERE source_channel='web' AND ship_to_snapshot IS NOT NULL)::text
    || ' cash, '
    || (SELECT count(*) FROM layaway_accounts WHERE source_channel='web' AND ship_to_snapshot IS NOT NULL)::text
    || ' layaway; unfilled: '
    || (SELECT count(*) FROM cash_orders WHERE source_channel='web' AND ship_to_snapshot IS NULL)::text
    || ' + '
    || (SELECT count(*) FROM layaway_accounts WHERE source_channel='web' AND ship_to_snapshot IS NULL)::text,
  '1 cash, 1 layaway; unfilled: 0 + 0',
  CASE WHEN (SELECT count(*) FROM cash_orders WHERE source_channel='web' AND ship_to_snapshot IS NOT NULL) = 1
        AND (SELECT count(*) FROM layaway_accounts WHERE source_channel='web' AND ship_to_snapshot IS NOT NULL) = 1
        AND (SELECT count(*) FROM cash_orders WHERE source_channel='web' AND ship_to_snapshot IS NULL) = 0
        AND (SELECT count(*) FROM layaway_accounts WHERE source_channel='web' AND ship_to_snapshot IS NULL) = 0
       THEN 'PASS' ELSE 'FAIL' END
), (
  'a backfilled snapshot is identical to one the writer would have taken',
  (SELECT CASE WHEN (c.ship_to_snapshot - 'captured_at')
               = (public.address_snapshot(c.ship_to_address_id) - 'captured_at')
          THEN 'identical' ELSE 'DIFFERS' END
     FROM cash_orders c WHERE c.source_channel='web' LIMIT 1),
  'identical',
  (SELECT CASE WHEN (c.ship_to_snapshot - 'captured_at')
               = (public.address_snapshot(c.ship_to_address_id) - 'captured_at')
          THEN 'PASS' ELSE 'FAIL' END
     FROM cash_orders c WHERE c.source_channel='web' LIMIT 1)
)) v(property, actual, expected, verdict);
