-- Acceptance for 20261127100000_staff_bell_emails_and_bounce_bell.sql (V11b + V13).
-- Run on a Postgres copy of live AFTER the migration; everything is rolled back.
-- Expect every line to print PASS.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- fixtures: an active admin profile, an inactive admin, Brenda's address from the setting
INSERT INTO public.profiles (user_id, full_name, email, status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Admin One', 'ADMIN.one@example.com', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Admin Gone', 'admin.gone@example.com', 'inactive'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Staff Only', 'staff@example.com', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'admin'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'staff');

-- 1. recipients = Brenda + active admins only, lower-cased, de-duplicated
SELECT CASE WHEN public.staff_bell_email_recipients() = ARRAY['admin.one@example.com','bumagatbrenda@gmail.com']
  THEN 'PASS 1 recipients = Brenda + active admin' ELSE 'FAIL 1 ' || array_to_string(public.staff_bell_email_recipients(), ',') END;

-- 2. a listed bell type fans out one ledger row per recipient and wakes the sender
DELETE FROM net.calls;
INSERT INTO public.staff_notifications (id, type, title, body, invoice_number)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'card_refund_after_credit', 'Card refund on an order that already has store credit', 'CJ-W-TEST · ¥1 …', 'TEST-1');
SELECT CASE WHEN (SELECT count(*) FROM public.staff_bell_emails WHERE bell_id = 'bbbbbbbb-0000-0000-0000-000000000001' AND status = 'pending') = 2
             AND (SELECT count(*) FROM net.calls WHERE url LIKE '%/staff-bell-emails') = 1
  THEN 'PASS 2 fan-out 2 rows + 1 wake' ELSE 'FAIL 2' END;

-- 3. an unlisted type does nothing
INSERT INTO public.staff_notifications (id, type, title, body) VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'submission_created', 'x', 'y');
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM public.staff_bell_emails WHERE bell_id = 'bbbbbbbb-0000-0000-0000-000000000002')
  THEN 'PASS 3 unlisted type not emailed' ELSE 'FAIL 3' END;

-- 4. claim marks sending (attempts 1) and returns the bell text; a second claim returns nothing
-- (separate statements: a data-modifying function and a read in ONE statement share a snapshot)
CREATE TEMP TABLE t4 AS SELECT count(*) AS n FROM public.claim_staff_bell_emails(10);
CREATE TEMP TABLE t4b AS SELECT count(*) AS n FROM public.claim_staff_bell_emails(10);
SELECT CASE WHEN (SELECT n FROM t4) = 2
             AND (SELECT count(*) FROM public.staff_bell_emails WHERE status = 'sending' AND attempts = 1) = 2
             AND (SELECT n FROM t4b) = 0
  THEN 'PASS 4 claim once' ELSE 'FAIL 4' END;

-- 5. finish: sent / retry → pending again; after 3 attempts a retry becomes failed
SELECT public.finish_staff_bell_email('bbbbbbbb-0000-0000-0000-000000000001', 'bumagatbrenda@gmail.com', 'sent', NULL) AS f1 \gset
SELECT public.finish_staff_bell_email('bbbbbbbb-0000-0000-0000-000000000001', 'admin.one@example.com', 'retry', 'boom') AS f2 \gset
SELECT CASE WHEN :'f1' = 't' AND :'f2' = 't'
             AND (SELECT status FROM public.staff_bell_emails WHERE bell_id='bbbbbbbb-0000-0000-0000-000000000001' AND recipient='bumagatbrenda@gmail.com') = 'sent'
             AND (SELECT status FROM public.staff_bell_emails WHERE bell_id='bbbbbbbb-0000-0000-0000-000000000001' AND recipient='admin.one@example.com') = 'pending'
  THEN 'PASS 5a sent / retry' ELSE 'FAIL 5a' END;
UPDATE public.staff_bell_emails SET attempts = 2 WHERE recipient = 'admin.one@example.com';
CREATE TEMP TABLE t5 AS SELECT count(*) AS n FROM public.claim_staff_bell_emails(10);
SELECT public.finish_staff_bell_email('bbbbbbbb-0000-0000-0000-000000000001', 'admin.one@example.com', 'retry', 'boom again') AS f3 \gset
CREATE TEMP TABLE t5b AS SELECT count(*) AS n FROM public.claim_staff_bell_emails(10);
SELECT CASE WHEN (SELECT n FROM t5) = 1 AND :'f3' = 't'
             AND (SELECT status FROM public.staff_bell_emails WHERE recipient='admin.one@example.com') = 'failed'
             AND (SELECT n FROM t5b) = 0
  THEN 'PASS 5b third failure = failed, never claimed again' ELSE 'FAIL 5b' END;

-- 6. a stale 'sending' row (claimed > 10 min ago) is claimable again
UPDATE public.staff_bell_emails SET status='sending', attempts=1, claimed_at = now() - interval '11 minutes' WHERE recipient='bumagatbrenda@gmail.com';
CREATE TEMP TABLE t6 AS SELECT count(*) AS n FROM public.claim_staff_bell_emails(10);
SELECT CASE WHEN (SELECT n FROM t6) = 1 THEN 'PASS 6 stale sending reclaimed' ELSE 'FAIL 6' END;

-- 7. V13: a provider bounce on an address with recent sends rings email_bounced once per hour, naming the orders
INSERT INTO public.customers (id, full_name, email, is_test) VALUES ('cccccccc-0000-0000-0000-000000000001', 'Bounce Tester', 'bounce@example.com', true);
INSERT INTO public.email_send_log (template_name, recipient_email, status, channel, metadata, created_at)
VALUES ('order-update-refund_received', 'bounce@example.com', 'sent', 'storefront', '{"reference":"CJ-W-B1"}', now() - interval '2 hours');
INSERT INTO public.email_send_log (message_id, template_name, recipient_email, status, error_message)
VALUES ('mid-1', 'system', 'bounce@example.com', 'bounced', 'Permanent bounce');
SELECT CASE WHEN (SELECT count(*) FROM public.staff_notifications WHERE type='email_bounced' AND metadata->>'recipient'='bounce@example.com') = 1
             AND (SELECT body FROM public.staff_notifications WHERE type='email_bounced' AND metadata->>'recipient'='bounce@example.com') LIKE '%order-update-refund_received CJ-W-B1%'
             AND (SELECT customer_id FROM public.staff_notifications WHERE type='email_bounced' AND metadata->>'recipient'='bounce@example.com') = 'cccccccc-0000-0000-0000-000000000001'
  THEN 'PASS 7a bounce bell with the refund email named' ELSE 'FAIL 7a' END;
INSERT INTO public.email_send_log (message_id, template_name, recipient_email, status, error_message)
VALUES ('mid-2', 'system', 'bounce@example.com', 'bounced', 'Permanent bounce');
SELECT CASE WHEN (SELECT count(*) FROM public.staff_notifications WHERE type='email_bounced' AND metadata->>'recipient'='bounce@example.com') = 1
  THEN 'PASS 7b second bounce within the hour: no second bell' ELSE 'FAIL 7b' END;
-- the bounce bell itself is on the email list → fan-out
SELECT CASE WHEN (SELECT count(*) FROM public.staff_bell_emails e JOIN public.staff_notifications n ON n.id=e.bell_id WHERE n.type='email_bounced') = 2
  THEN 'PASS 7c bounce bell emailed to Brenda + admin' ELSE 'FAIL 7c' END;

-- 8. V13: a suppressed refund email rings; a suppressed non-refund email does not
INSERT INTO public.email_send_log (template_name, recipient_email, status, channel, metadata)
VALUES ('order-update-refund_received', 'other@example.com', 'suppressed', 'storefront', '{"reference":"CJ-W-S1","idempotency_key":"k"}');
INSERT INTO public.email_send_log (template_name, recipient_email, status, channel, metadata)
VALUES ('payment-reminder', 'third@example.com', 'suppressed', 'storefront', '{}');
SELECT CASE WHEN (SELECT count(*) FROM public.staff_notifications WHERE type='email_bounced' AND metadata->>'recipient'='other@example.com') = 1
             AND (SELECT count(*) FROM public.staff_notifications WHERE type='email_bounced' AND metadata->>'recipient'='third@example.com') = 0
  THEN 'PASS 8 suppressed refund email rings, other suppressed does not' ELSE 'FAIL 8' END;

-- 9. guard: SQL edits of the settings are refused; the setter (admin) works and audits
DO $g$ BEGIN
  BEGIN
    UPDATE public.system_settings SET value = '[]'::jsonb WHERE key = 'staff_bell_email_types';
    RAISE EXCEPTION 'FAIL 9a guard did not fire';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN RAISE NOTICE 'PASS 9a guard refuses SQL edit';
  END;
END $g$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT 'aaaaaaaa-0000-0000-0000-000000000001'::uuid $$;
SELECT (public.set_staff_bell_emails('["card_refund_after_credit","email_bounced"]'::jsonb, '["Brenda@Example.com"]'::jsonb, '["admin"]'::jsonb))->>'changed' AS s9 \gset
SELECT CASE WHEN :'s9' = 'true'
             AND public.staff_bell_email_types() = ARRAY['card_refund_after_credit','email_bounced']
             AND public.staff_bell_email_recipients() = ARRAY['admin.one@example.com','brenda@example.com']
             AND (SELECT count(*) FROM public.audit_logs WHERE action='set_staff_bell_emails') = 1
  THEN 'PASS 9b setter changes + audits' ELSE 'FAIL 9b' END;
SELECT CASE WHEN (public.set_staff_bell_emails('["bad type!"]'::jsonb, NULL, NULL))->>'error' = 'invalid_type'
             AND (public.set_staff_bell_emails(NULL, '["not-an-email"]'::jsonb, NULL))->>'error' = 'invalid_address'
             AND (public.set_staff_bell_emails(NULL, NULL, '["king"]'::jsonb))->>'error' = 'invalid_role'
  THEN 'PASS 9c setter validation' ELSE 'FAIL 9c' END;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT 'aaaaaaaa-0000-0000-0000-000000000003'::uuid $$;
SELECT CASE WHEN (public.set_staff_bell_emails('[]'::jsonb, NULL, NULL))->>'error' = 'permission_denied' THEN 'PASS 9d non-admin refused' ELSE 'FAIL 9d' END;

-- 10. a bell insert never fails because of the fan-out (recipients function broken)
CREATE OR REPLACE FUNCTION public.staff_bell_email_recipients() RETURNS text[] LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
INSERT INTO public.staff_notifications (id, type, title, body) VALUES ('bbbbbbbb-0000-0000-0000-000000000003', 'card_refund_after_credit', 'x', 'y');
SELECT CASE WHEN EXISTS (SELECT 1 FROM public.staff_notifications WHERE id='bbbbbbbb-0000-0000-0000-000000000003') THEN 'PASS 10 bell survives a broken fan-out' ELSE 'FAIL 10' END;

ROLLBACK;
