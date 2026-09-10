-- Remove the address backfill from 20260910140000. It manufactured 871 junk
-- addresses instead of migrating real ones.
--
-- WHAT WENT WRONG
-- The backfill picked line1 as COALESCE(address_line1, city, location), a
-- fallback chain meant to avoid dropping partial addresses. On live data every
-- one of those 871 rows took the LAST branch:
--
--     line1 from address_line1 :   0
--     line1 from city          :   0
--     line1 from location      : 871
--     rows with no postal_code : 871
--
-- because address_line1, city and postal_code are empty for EVERY customer,
-- and `location` is not an address line — it holds a COUNTRY:
--
--     Japan 371 · Philippines 139 · United States 118 · Canada 54 ·
--     Australia 37 · United Kingdom 21 · ...
--
-- So each row read as a delivery address of "Japan", with no street, no city
-- and no postal code — and every one was flagged is_default, so checkout would
-- have preselected it. A country label presented as a saved address is worse
-- than no address: it misleads the customer, misleads staff, and ships nothing
-- anywhere.
--
-- The estimate that preceded it was wrong for the same reason. It counted
-- COALESCE(address_line1, city, postal_code, country) IS NOT NULL and got 704 —
-- but that 704 came from `country`, a column the backfill never read. The
-- pre-check and the INSERT looked at different columns.
--
-- CONCLUSION: there was no address data to migrate. The flat columns on
-- customers hold a country and nothing else. Real addresses start arriving at
-- checkout in Phase 2 step 2.

-- Delete only rows carrying the backfill's exact signature, so a genuine
-- address entered before this runs is left alone: label 'imported', and none of
-- the fields a real address would have.
DELETE FROM public.customer_addresses
WHERE label = 'imported'
  AND postal_code IS NULL
  AND city IS NULL
  AND region IS NULL
  AND line2 IS NULL;

COMMENT ON TABLE public.customer_addresses IS
  'Delivery addresses for storefront checkout. Written only by the website edge function (service role). NOT seeded from customers: the flat address columns there hold a country in `location` and nothing else, so the 20260910140000 backfill was removed by 20260910160000. Rows arrive from checkout.';

-- Verification: expect 0 while checkout is unbuilt, and no row should ever
-- again have a country name as its line1.
--   SELECT count(*) AS rows,
--          count(*) FILTER (WHERE postal_code IS NULL) AS no_postcode
--   FROM public.customer_addresses;
--
-- If a rebuild ever replays 20260910140000, this migration runs after it and
-- clears the same rows again. The backfill block in that file is left as-is on
-- purpose: an applied migration is history, not something to rewrite.
