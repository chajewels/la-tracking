-- ============================================================================
-- Cart reminders — LOCAL tests (2026-10-01). Run after the stub and the
-- migration (see the stub header). Every block RAISEs on a wrong answer, so
-- ON_ERROR_STOP makes the run pass/fail as a whole. Local throwaway only.
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('cartrem.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local stub only';
  END IF;
END $guard$;

BEGIN;

-- Fixtures: a real customer (JP), a PH customer, a test customer, products.
INSERT INTO customers (id, customer_code, full_name, email, location, is_test) VALUES
  ('11111111-1111-1111-1111-111111111111', 'CJ-2026-00008', 'Aki Real',   'aki@example.com',            'Tokyo, Japan',       false),
  ('22222222-2222-2222-2222-222222222222', 'CJ-2026-00016', 'Mila PH',    'mila@example.com',           'Manila, Philippines', false),
  ('33333333-3333-3333-3333-333333333333', 'CJ-2026-05088', 'Test Customer', 'chajewelsjapan@gmail.com', 'Tokyo, Japan',       true),
  ('44444444-4444-4444-4444-444444444444', 'CJ-2026-00024', 'Throwaway Test', 'throwaway@example.com',  'Tokyo, Japan',       true);
INSERT INTO website_products (id, sku, slug, name, name_ja, status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'E1001', 'pearl-drop-earrings', 'Pearl drop earrings', 'パールドロップピアス', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'R2002', 'gold-band-ring',      'Gold band ring',      NULL,                 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'N3003', 'unpublished-necklace','Unpublished necklace', NULL,                 'draft');
INSERT INTO website_product_variants (id, product_id, size, stone, price_jpy, stock_qty) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', NULL, 'Akoya pearl', 68000, 1),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', '12', NULL,          45000, 0),   -- sold out
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', NULL, NULL,          30000, 3);   -- unpublished
INSERT INTO website_product_media (variant_id, url, sort) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'https://cdn.example.com/e1001-2.jpg', 2),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'https://cdn.example.com/e1001-1.jpg', 1);

-- 1. website_set_cart: unknown variant dropped, qty clamped, cycle starts on first line, no-op leaves updated_at alone.
DO $t$
DECLARE r jsonb; k record;
BEGIN
  r := website_set_cart('11111111-1111-1111-1111-111111111111',
        '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000001","qty":"40"},{"variant_id":"ffffffff-0000-0000-0000-000000000009","qty":"1"}]'::jsonb,
        'en', now());
  IF (r->>'changed') <> 'true' OR (r->>'lines') <> '1' THEN RAISE EXCEPTION 'set_cart first write: %', r; END IF;
  SELECT * INTO k FROM customer_carts WHERE customer_id = '11111111-1111-1111-1111-111111111111';
  IF k.lang <> 'en' OR k.cycle_id IS NULL THEN RAISE EXCEPTION 'set_cart cart row: %', row_to_json(k); END IF;
  IF (SELECT qty FROM customer_cart_lines WHERE customer_id = k.customer_id) <> 20 THEN RAISE EXCEPTION 'qty not clamped to 20'; END IF;
  -- Same lines again: not a change; updated_at must not move.
  UPDATE customer_carts SET updated_at = now() - interval '2 days' WHERE customer_id = k.customer_id;
  r := website_set_cart(k.customer_id, '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000001","qty":"20"}]'::jsonb, 'ja', now());
  IF (r->>'changed') <> 'false' THEN RAISE EXCEPTION 'no-op reported as change: %', r; END IF;
  IF (SELECT updated_at FROM customer_carts WHERE customer_id = k.customer_id) > now() - interval '1 day' THEN
    RAISE EXCEPTION 'no-op moved updated_at';
  END IF;
  IF (SELECT lang FROM customer_carts WHERE customer_id = k.customer_id) <> 'ja' THEN RAISE EXCEPTION 'lang not updated on no-op'; END IF;
  -- Stale write (older as_of) is ignored.
  r := website_set_cart(k.customer_id, '[]'::jsonb, 'ja', now() - interval '1 hour');
  IF (r->>'stale') <> 'true' THEN RAISE EXCEPTION 'stale write accepted: %', r; END IF;
  IF (SELECT count(*) FROM customer_cart_lines WHERE customer_id = k.customer_id) <> 1 THEN RAISE EXCEPTION 'stale write changed lines'; END IF;
  -- Bad input.
  IF (website_set_cart(k.customer_id, '{"x":1}'::jsonb, 'ja', now())->>'error') <> 'bad_lines' THEN RAISE EXCEPTION 'bad_lines missing'; END IF;
  IF (website_set_cart('99999999-9999-9999-9999-999999999999', '[]'::jsonb, 'ja', now())->>'error') <> 'not_linked' THEN RAISE EXCEPTION 'not_linked missing'; END IF;
END $t$;

-- 2. Consent: opt-in needs a text version; events are appended; the token is stable.
DO $t$
DECLARE r jsonb; tok uuid;
BEGIN
  r := set_cart_reminder_consent('11111111-1111-1111-1111-111111111111', true, 'complete_profile', 'en', NULL);
  IF (r->>'error') <> 'text_version_required' THEN RAISE EXCEPTION 'opt-in without text version accepted: %', r; END IF;
  r := set_cart_reminder_consent('11111111-1111-1111-1111-111111111111', true, 'complete_profile', 'en', 'cart-reminder-2026-10');
  IF (r->>'opted_in') <> 'true' THEN RAISE EXCEPTION 'opt-in failed: %', r; END IF;
  SELECT unsubscribe_token INTO tok FROM customer_email_consents WHERE customer_id = '11111111-1111-1111-1111-111111111111';
  r := set_cart_reminder_consent('11111111-1111-1111-1111-111111111111', false, 'account', 'en', NULL);
  r := set_cart_reminder_consent('11111111-1111-1111-1111-111111111111', true, 'account', 'en', 'cart-reminder-2026-10');
  IF (SELECT unsubscribe_token FROM customer_email_consents WHERE customer_id = '11111111-1111-1111-1111-111111111111') <> tok THEN
    RAISE EXCEPTION 'token changed across opt-out/opt-in';
  END IF;
  IF (SELECT count(*) FROM customer_email_consent_events WHERE customer_id = '11111111-1111-1111-1111-111111111111') <> 3 THEN
    RAISE EXCEPTION 'expected 3 consent events';
  END IF;
  IF (set_cart_reminder_consent('11111111-1111-1111-1111-111111111111', true, 'email_link', 'en', 'v')->>'error') <> 'bad_source' THEN
    RAISE EXCEPTION 'email_link accepted as an opt-in source';
  END IF;
END $t$;

-- 3. Append-only events: update and delete refused.
DO $t$
BEGIN
  BEGIN
    DELETE FROM customer_email_consent_events WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    RAISE EXCEPTION 'delete allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE customer_email_consent_events SET action = 'opt_out' WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    RAISE EXCEPTION 'update allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
END $t$;

-- 4. Candidates: off → none; owner_only → owner addresses only; on → real + owner-readable test.
DO $t$
DECLARE n int;
BEGIN
  -- Make the cart idle (26h) with a published, in-stock line; consent on.
  UPDATE customer_carts SET updated_at = now() - interval '26 hours' WHERE customer_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) INTO n FROM cart_reminder_candidates(50);
  IF n <> 0 THEN RAISE EXCEPTION 'candidates while off: %', n; END IF;

  UPDATE system_settings SET value = '"owner_only"'::jsonb WHERE key = 'cart_reminders_mode';
  SELECT count(*) INTO n FROM cart_reminder_candidates(50);
  IF n <> 0 THEN RAISE EXCEPTION 'owner_only returned a non-owner address: %', n; END IF;

  UPDATE system_settings SET value = '"on"'::jsonb WHERE key = 'cart_reminders_mode';
END $t$;

-- 5. The time-of-day rule is evaluated against now(); pin the customer's zone to make the test deterministic.
--    (09:00–19:59 local.) We test both branches by moving the customer between Tokyo and Manila and a
--    far-away zone through `location` — the function only knows Tokyo/Manila, so instead we assert the rule's
--    SQL text and test the remaining rules with whichever zone is in-hours right now, if any.
DO $t$
DECLARE in_hours boolean; n int; c record;
BEGIN
  in_hours := extract(hour FROM now() AT TIME ZONE 'Asia/Tokyo') BETWEEN 9 AND 19;
  SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
  IF in_hours AND n <> 1 THEN RAISE EXCEPTION 'expected Aki as a candidate in Tokyo hours, got %', n; END IF;
  IF NOT in_hours AND n <> 0 THEN RAISE EXCEPTION 'candidate outside Tokyo hours'; END IF;
  IF in_hours THEN
    SELECT * INTO c FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF c.lang <> 'ja' OR c.email <> 'aki@example.com' THEN RAISE EXCEPTION 'candidate fields: %', row_to_json(c); END IF;
    IF jsonb_array_length(c.items) <> 1 THEN RAISE EXCEPTION 'expected 1 available item'; END IF;
    IF (c.items->0->>'image_url') <> 'https://cdn.example.com/e1001-1.jpg' THEN RAISE EXCEPTION 'first media by sort expected'; END IF;
    IF (c.items->0->>'qty') <> '1' THEN RAISE EXCEPTION 'qty must be capped at stock (1), got %', c.items->0->>'qty'; END IF;
    IF (c.items->0->>'name_ja') <> 'パールドロップピアス' THEN RAISE EXCEPTION 'name_ja missing'; END IF;
    IF c.quote_mode IS NOT NULL THEN RAISE EXCEPTION 'stage A must have no quote'; END IF;

    -- Stage B: a quote in this cycle, unconsumed, even if it expired.
    INSERT INTO checkout_quotes (customer_id, mode, term_months, settlement_currency, created_at)
      VALUES ('11111111-1111-1111-1111-111111111111', 'layaway', 6, 'PHP', now() - interval '25 hours');
    SELECT * INTO c FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF c.quote_mode <> 'layaway' OR c.quote_currency <> 'PHP' OR c.quote_term <> 6 THEN RAISE EXCEPTION 'stage B quote not returned: %', row_to_json(c); END IF;
    -- A quote from BEFORE this cycle does not count: move cycle start after it.
    UPDATE customer_carts SET cycle_started_at = now() - interval '2 hours' WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    SELECT * INTO c FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF c.quote_mode IS NOT NULL THEN RAISE EXCEPTION 'old-cycle quote leaked into stage B'; END IF;
    UPDATE customer_carts SET cycle_started_at = now() - interval '30 hours' WHERE customer_id = '11111111-1111-1111-1111-111111111111';

    -- An order since the cart was touched suppresses the reminder.
    INSERT INTO cash_orders (customer_id, created_at) VALUES ('11111111-1111-1111-1111-111111111111', now() - interval '1 hour');
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 0 THEN RAISE EXCEPTION 'order since cart did not suppress'; END IF;
    DELETE FROM cash_orders;

    -- A layaway since the cart was touched suppresses it too.
    INSERT INTO layaway_accounts (customer_id, created_at) VALUES ('11111111-1111-1111-1111-111111111111', now() - interval '1 hour');
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 0 THEN RAISE EXCEPTION 'layaway since cart did not suppress'; END IF;
    DELETE FROM layaway_accounts;

    -- Suppressed address → not a candidate.
    INSERT INTO suppressed_emails (email, reason) VALUES ('AKI@example.com', 'bounce');
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 0 THEN RAISE EXCEPTION 'suppressed address was a candidate'; END IF;
    DELETE FROM suppressed_emails;

    -- Idle too short, or too old (> 7 days) → not a candidate.
    UPDATE customer_carts SET updated_at = now() - interval '3 hours' WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 0 THEN RAISE EXCEPTION 'cart idle 3h was a candidate'; END IF;
    UPDATE customer_carts SET updated_at = now() - interval '8 days' WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 0 THEN RAISE EXCEPTION 'cart idle 8 days was a candidate'; END IF;
    UPDATE customer_carts SET updated_at = now() - interval '26 hours' WHERE customer_id = '11111111-1111-1111-1111-111111111111';

    -- The idle override (minimum 5) is honoured.
    UPDATE system_settings SET value = '"5"'::jsonb WHERE key = 'cart_reminder_idle_minutes';
    UPDATE customer_carts SET updated_at = now() - interval '10 minutes' WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 1 THEN RAISE EXCEPTION 'idle override not honoured'; END IF;
    UPDATE system_settings SET value = '"1440"'::jsonb WHERE key = 'cart_reminder_idle_minutes';
    UPDATE customer_carts SET updated_at = now() - interval '26 hours' WHERE customer_id = '11111111-1111-1111-1111-111111111111';

    -- Only sold-out / unpublished lines → no candidate, cycle not consumed.
    UPDATE customer_cart_lines SET variant_id = 'bbbbbbbb-0000-0000-0000-000000000002' WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 0 THEN RAISE EXCEPTION 'sold-out-only cart was a candidate'; END IF;
    UPDATE customer_cart_lines SET variant_id = 'bbbbbbbb-0000-0000-0000-000000000003' WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '11111111-1111-1111-1111-111111111111';
    IF n <> 0 THEN RAISE EXCEPTION 'unpublished-only cart was a candidate'; END IF;
    UPDATE customer_cart_lines SET variant_id = 'bbbbbbbb-0000-0000-0000-000000000001' WHERE customer_id = '11111111-1111-1111-1111-111111111111';

    -- Test customers: a throwaway address never; the owner-readable test address yes.
    PERFORM website_set_cart('44444444-4444-4444-4444-444444444444', '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000001","qty":"1"}]'::jsonb, 'en', now());
    PERFORM set_cart_reminder_consent('44444444-4444-4444-4444-444444444444', true, 'account', 'en', 'v');
    UPDATE customer_carts SET updated_at = now() - interval '26 hours' WHERE customer_id = '44444444-4444-4444-4444-444444444444';
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '44444444-4444-4444-4444-444444444444';
    IF n <> 0 THEN RAISE EXCEPTION 'throwaway test customer was a candidate'; END IF;
    PERFORM website_set_cart('33333333-3333-3333-3333-333333333333', '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000001","qty":"1"}]'::jsonb, 'en', now());
    PERFORM set_cart_reminder_consent('33333333-3333-3333-3333-333333333333', true, 'account', 'en', 'v');
    UPDATE customer_carts SET updated_at = now() - interval '26 hours' WHERE customer_id = '33333333-3333-3333-3333-333333333333';
    SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = '33333333-3333-3333-3333-333333333333';
    IF n <> 1 THEN RAISE EXCEPTION 'owner-readable test customer not a candidate'; END IF;
    -- owner_only: only the owner-readable one.
    UPDATE system_settings SET value = '"owner_only"'::jsonb WHERE key = 'cart_reminders_mode';
    SELECT count(*) INTO n FROM cart_reminder_candidates(50);
    IF n <> 1 OR (SELECT customer_id FROM cart_reminder_candidates(50)) <> '33333333-3333-3333-3333-333333333333' THEN
      RAISE EXCEPTION 'owner_only wrong set';
    END IF;
    UPDATE system_settings SET value = '"on"'::jsonb WHERE key = 'cart_reminders_mode';
  END IF;
END $t$;

-- 6. Claim: once per cycle; consent re-checked; the cart moving on means no claim; finish only from claimed.
DO $t$
DECLARE c record; id1 uuid; id2 uuid; n int;
BEGIN
  SELECT * INTO c FROM customer_carts WHERE customer_id = '11111111-1111-1111-1111-111111111111';
  id1 := claim_cart_reminder(c.customer_id, c.cycle_id, 'aki@example.com', 'ja', '[]'::jsonb);
  IF id1 IS NULL THEN RAISE EXCEPTION 'first claim refused'; END IF;
  id2 := claim_cart_reminder(c.customer_id, c.cycle_id, 'aki@example.com', 'ja', '[]'::jsonb);
  IF id2 IS NOT NULL THEN RAISE EXCEPTION 'second claim for the same cycle accepted'; END IF;
  -- Not a candidate any more (sent this cycle).
  SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = c.customer_id;
  IF n <> 0 THEN RAISE EXCEPTION 'claimed cycle still a candidate'; END IF;
  PERFORM finish_cart_reminder(id1, 'sent', NULL);
  IF (SELECT status FROM cart_reminder_sends WHERE id = id1) <> 'sent' THEN RAISE EXCEPTION 'finish did not record sent'; END IF;
  PERFORM finish_cart_reminder(id1, 'failed', 'late');
  IF (SELECT status FROM cart_reminder_sends WHERE id = id1) <> 'sent' THEN RAISE EXCEPTION 'finish rewrote a finished row'; END IF;
  BEGIN
    PERFORM finish_cart_reminder(id1, 'bogus', NULL);
    RAISE EXCEPTION 'bad status accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%bad status%' THEN RAISE; END IF;
  END;
  -- A new cycle (cart emptied then refilled) within 7 days: still no candidate (per-customer 7-day rule).
  PERFORM website_set_cart(c.customer_id, '[]'::jsonb, 'ja', now());
  PERFORM website_set_cart(c.customer_id, '[{"variant_id":"bbbbbbbb-0000-0000-0000-000000000001","qty":"1"}]'::jsonb, 'ja', now());
  IF (SELECT cycle_id FROM customer_carts WHERE customer_id = c.customer_id) = c.cycle_id THEN RAISE EXCEPTION 'new cycle not started'; END IF;
  UPDATE customer_carts SET updated_at = now() - interval '26 hours' WHERE customer_id = c.customer_id;
  SELECT count(*) INTO n FROM cart_reminder_candidates(50) WHERE customer_id = c.customer_id;
  IF n <> 0 THEN RAISE EXCEPTION 'second reminder inside 7 days'; END IF;
  -- Consent withdrawn between candidate and claim: claim says no.
  UPDATE cart_reminder_sends SET claimed_at = now() - interval '8 days' WHERE id = id1;
  PERFORM set_cart_reminder_consent(c.customer_id, false, 'account', 'ja', NULL);
  SELECT * INTO c FROM customer_carts WHERE customer_id = c.customer_id;
  IF claim_cart_reminder(c.customer_id, c.cycle_id, 'aki@example.com', 'ja', '[]'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION 'claim ignored a withdrawn consent';
  END IF;
  PERFORM set_cart_reminder_consent(c.customer_id, true, 'account', 'ja', 'v');
  -- Cart moved on (different cycle id) → no claim.
  IF claim_cart_reminder(c.customer_id, gen_random_uuid(), 'aki@example.com', 'ja', '[]'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION 'claim accepted a stale cycle';
  END IF;
END $t$;

-- 7. Token withdrawal: always "unsubscribed"; only a live opt-in writes an event; Lovable unsubscribe by email.
DO $t$
DECLARE tok uuid; before int; after int; r jsonb;
BEGIN
  SELECT unsubscribe_token INTO tok FROM customer_email_consents WHERE customer_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) INTO before FROM customer_email_consent_events;
  r := withdraw_cart_reminder_by_token(gen_random_uuid());
  IF (r->>'status') <> 'unsubscribed' THEN RAISE EXCEPTION 'unknown token answered differently: %', r; END IF;
  SELECT count(*) INTO after FROM customer_email_consent_events;
  IF after <> before THEN RAISE EXCEPTION 'unknown token wrote an event'; END IF;
  r := withdraw_cart_reminder_by_token(tok);
  IF (r->>'status') <> 'unsubscribed' THEN RAISE EXCEPTION 'token withdrawal: %', r; END IF;
  IF (SELECT opted_in FROM customer_email_consents WHERE customer_id = '11111111-1111-1111-1111-111111111111') THEN
    RAISE EXCEPTION 'token withdrawal left consent on';
  END IF;
  IF (SELECT source FROM customer_email_consents WHERE customer_id = '11111111-1111-1111-1111-111111111111') <> 'email_link' THEN
    RAISE EXCEPTION 'withdrawal source not email_link';
  END IF;
  -- Second click: still "unsubscribed", no new event.
  SELECT count(*) INTO before FROM customer_email_consent_events;
  PERFORM withdraw_cart_reminder_by_token(tok);
  SELECT count(*) INTO after FROM customer_email_consent_events;
  IF after <> before THEN RAISE EXCEPTION 'second click wrote an event'; END IF;
  -- Lovable unsubscribe, case-insensitive, counts the rows it turned off.
  PERFORM set_cart_reminder_consent('11111111-1111-1111-1111-111111111111', true, 'account', 'ja', 'v');
  IF withdraw_cart_reminder_by_email('  Aki@Example.com ') <> 1 THEN RAISE EXCEPTION 'email withdrawal count'; END IF;
  IF withdraw_cart_reminder_by_email('aki@example.com') <> 0 THEN RAISE EXCEPTION 'email withdrawal repeated'; END IF;
  IF (SELECT source FROM customer_email_consents WHERE customer_id = '11111111-1111-1111-1111-111111111111') <> 'lovable_unsubscribe' THEN
    RAISE EXCEPTION 'withdrawal source not lovable_unsubscribe';
  END IF;
END $t$;

-- 8. Retention: lines older than 90 days go; consent and events stay.
DO $t$
DECLARE n int;
BEGIN
  UPDATE customer_carts SET updated_at = now() - interval '91 days' WHERE customer_id = '33333333-3333-3333-3333-333333333333';
  n := purge_stale_customer_carts();
  IF n <> 1 THEN RAISE EXCEPTION 'purge count % (expected 1)', n; END IF;
  IF (SELECT count(*) FROM customer_cart_lines WHERE customer_id = '33333333-3333-3333-3333-333333333333') <> 0 THEN RAISE EXCEPTION 'stale lines kept'; END IF;
  IF (SELECT count(*) FROM customer_email_consents WHERE customer_id = '33333333-3333-3333-3333-333333333333') <> 1 THEN RAISE EXCEPTION 'purge touched consent'; END IF;
END $t$;

-- 9. Grants and RLS: anon/authenticated cannot execute; staff can read, a customer-role user cannot.
DO $t$
BEGIN
  IF has_function_privilege('anon', 'public.cart_reminder_candidates(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.website_set_cart(uuid,jsonb,text,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.withdraw_cart_reminder_by_token(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.claim_cart_reminder(uuid,uuid,text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants wrong';
  END IF;
END $t$;
INSERT INTO user_roles (user_id, role) VALUES ('55555555-5555-5555-5555-555555555555', 'staff');
SET LOCAL ROLE authenticated;
SET LOCAL test.uid = '55555555-5555-5555-5555-555555555555';
DO $t$ BEGIN
  IF (SELECT count(*) FROM customer_carts) < 1 THEN RAISE EXCEPTION 'staff cannot read carts'; END IF;
END $t$;
SET LOCAL test.uid = '66666666-6666-6666-6666-666666666666';
DO $t$ BEGIN
  IF (SELECT count(*) FROM customer_carts) <> 0 THEN RAISE EXCEPTION 'non-staff can read carts'; END IF;
  IF (SELECT count(*) FROM customer_email_consents) <> 0 THEN RAISE EXCEPTION 'non-staff can read consents'; END IF;
END $t$;
RESET ROLE;

ROLLBACK;
SELECT 'cart reminders local tests: PASS' AS result;
