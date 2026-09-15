\pset pager off
SELECT set_config('harness.uid','22222222-2222-4222-8222-222222222222',false) \gset x
\echo '=== Q12: the quote DOWNGRADES. What does the WRITER do when a downgraded term reaches it? ==='
\echo '--- the quote first: R7828 at 679,980 + 2,000 shipping, asked for 12M'
SELECT (q->>'eligible')::bool AS eligible, q->>'requested_term_months' AS requested,
       q->>'term_months' AS granted, (q->>'term_downgraded')::bool AS downgraded,
       q->>'max_term_months' AS max_term,
       (SELECT jsonb_object_agg(t->>'months', t->'eligible') FROM jsonb_array_elements(q->'allowed_terms') t) AS allowed
FROM (SELECT layaway_quote(679980, 12, 'JPY', current_date, 2000, 0) AS q) s;

\echo '--- now put that exact downgraded quote through the writer'
SELECT mk_quote('4201767c-54e6-48d0-8c9e-c1b3c07a931e','b0000000-0000-4000-8000-000000000001',1,12,'JPY',2000,NULL,current_date) AS qid \gset
\echo '  (mk_quote stores term_months = what layaway_quote granted, exactly as the website function does)'
SELECT term_months AS term_stored_on_quote, total_jpy FROM checkout_quotes WHERE id = :'qid';
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e', :'qid', 'en', now() + interval '72 hours', current_date) AS writer_result;

\echo '--- and a quote that really does carry the UNREACHABLE term (a caller that did not clamp)'
UPDATE checkout_quotes SET term_months = 12, consumed_at = NULL WHERE id = :'qid';
SELECT create_web_layaway_atomic('4201767c-54e6-48d0-8c9e-c1b3c07a931e', :'qid', 'en', now() + interval '72 hours', current_date) AS writer_result_on_12M;
\echo '--- was anything written? stock, account, schedule'
SELECT (SELECT count(*) FROM layaway_accounts WHERE quote_id = :'qid') AS accounts_created,
       (SELECT stock_qty FROM website_product_variants WHERE id='b0000000-0000-4000-8000-000000000001') AS r7828_stock,
       (SELECT consumed_at IS NULL FROM checkout_quotes WHERE id = :'qid') AS quote_still_unconsumed;

\echo '--- N4020 (72,980) asked for 8M: the second downgrade fixture'
SELECT (q->>'term_months') AS granted, (q->>'term_downgraded')::bool AS downgraded, q->>'max_term_months' AS max_term
FROM (SELECT layaway_quote(72980, 8, 'JPY', current_date, 2000, 0) AS q) s;

\echo '--- a basket below EVERY minimum? (3M has none, so eligible always survives)'
SELECT (q->>'eligible')::bool AS eligible, q->>'term_months' AS granted, (q->>'term_downgraded')::bool AS downgraded
FROM (SELECT layaway_quote(500, 12, 'JPY', current_date, 0, 0) AS q) s;
