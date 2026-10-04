\set ON_ERROR_STOP 1
-- Fixtures
INSERT INTO customers (id, full_name, email) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Old Owner', 'same@example.com'),
  ('00000000-0000-0000-0000-0000000000b2', 'New Owner', 'same@example.com');
INSERT INTO cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status, loyalty_jpy_amount, order_date, source_channel, payment_status)
VALUES
  ('00000000-0000-0000-0000-00000000c001', 'CJ-1', '00000000-0000-0000-0000-0000000000a1', 'JPY', 50000, 0, 50000, 'pending', 50000, current_date, 'web', 'pending_transfer'),
  ('00000000-0000-0000-0000-00000000c002', 'CJ-2', '00000000-0000-0000-0000-0000000000a1', 'JPY', 50000, 0, 50000, 'pending', 50000, current_date, 'web', 'pending_transfer'),
  ('00000000-0000-0000-0000-00000000c003', 'CJ-3', '00000000-0000-0000-0000-0000000000a1', 'JPY', 50000, 0, 50000, 'pending', 50000, current_date, 'web', 'pending_transfer'),
  ('00000000-0000-0000-0000-00000000c004', 'CJ-4', '00000000-0000-0000-0000-0000000000a1', 'JPY', 50000, 0, 50000, 'pending', 50000, current_date, 'web', 'pending_transfer');
INSERT INTO layaway_accounts (id, customer_id, invoice_number, total_amount, order_date, status, loyalty_jpy_amount)
VALUES ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000a1', 'LA-1', 50000, current_date, 'active', 50000);

CREATE TEMP TABLE results (name text, ok boolean, detail text);
CREATE FUNCTION pg_temp.ra(o uuid, kind text, apply boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.reassign_order_owner_atomic(kind, o, '00000000-0000-0000-0000-0000000000b2', NULL, 'test reason', gen_random_uuid(), apply, false) $$;
CREATE FUNCTION pg_temp.has_refusal(j jsonb, code text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(j -> 'refusals') r WHERE r ->> 'code' = code) $$;

-- R-1 no Paidy history: preview can apply, no paidy_order refusal
INSERT INTO results SELECT 'R1 no paidy: can_apply', (pg_temp.ra('00000000-0000-0000-0000-00000000c001','cash',false) ->> 'can_apply')::boolean, '';
-- R-2 a paidy_payments row (captured, test) → refusal in preview and on apply
INSERT INTO paidy_payments (cash_order_id, customer_id, paidy_payment_id, status, amount_jpy) VALUES ('00000000-0000-0000-0000-00000000c002','00000000-0000-0000-0000-0000000000a1','pay_x','closed',50000);
INSERT INTO results SELECT 'R2 paidy payment: preview refusal', pg_temp.has_refusal(pg_temp.ra('00000000-0000-0000-0000-00000000c002','cash',false),'paidy_order'), '';
INSERT INTO results SELECT 'R2 paidy payment: preview can_apply false', NOT (pg_temp.ra('00000000-0000-0000-0000-00000000c002','cash',false) ->> 'can_apply')::boolean, '';
INSERT INTO results SELECT 'R2 paidy payment: apply refused', (j ->> 'ok') = 'false' AND (j ->> 'error') = 'paidy_order', j ->> 'message' FROM (SELECT pg_temp.ra('00000000-0000-0000-0000-00000000c002','cash',true) j) x;
INSERT INTO results SELECT 'R2 order did not move', customer_id = '00000000-0000-0000-0000-0000000000a1', '' FROM cash_orders WHERE id = '00000000-0000-0000-0000-00000000c002';
-- R-3 only a checkout attempt (window opened, then closed)
INSERT INTO paidy_checkout_attempts (cash_order_id, customer_id, status, amount_jpy, expires_at) VALUES ('00000000-0000-0000-0000-00000000c003','00000000-0000-0000-0000-0000000000a1','ended',50000, now());
INSERT INTO results SELECT 'R3 checkout attempt: refusal', pg_temp.has_refusal(pg_temp.ra('00000000-0000-0000-0000-00000000c003','cash',false),'paidy_order'), '';
-- R-4 only a submission labelled paidy (rejected)
INSERT INTO payment_submissions (customer_id, cash_order_id, submitted_amount, payment_method, status) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000c004',50000,'paidy','rejected');
INSERT INTO results SELECT 'R4 paidy submission: refusal', pg_temp.has_refusal(pg_temp.ra('00000000-0000-0000-0000-00000000c004','cash',false),'paidy_order'), '';
-- R-5 layaway never gets the refusal
INSERT INTO results SELECT 'R5 layaway: no paidy refusal', NOT pg_temp.has_refusal(pg_temp.ra('00000000-0000-0000-0000-00000000d001','layaway',false),'paidy_order'), '';
-- R-6 an order without Paidy really moves (apply path intact)
INSERT INTO results SELECT 'R6 no paidy: apply moves', (j ->> 'applied')::boolean, '' FROM (SELECT pg_temp.ra('00000000-0000-0000-0000-00000000c001','cash',true) j) x;
INSERT INTO results SELECT 'R6 order moved', customer_id = '00000000-0000-0000-0000-0000000000b2', '' FROM cash_orders WHERE id = '00000000-0000-0000-0000-00000000c001';

-- ---- cash_payments guard ----
CREATE FUNCTION pg_temp.try(sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE sql; RETURN 'ok'; EXCEPTION WHEN others THEN RETURN SQLERRM; END $$;
INSERT INTO cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status, source_channel, payment_status)
VALUES ('00000000-0000-0000-0000-00000000e001', 'CJ-E', '00000000-0000-0000-0000-0000000000a1', 'JPY', 50000, 0, 50000, 'pending', 'web', 'pending_transfer');
-- G-1 nothing in progress → store credit allowed
INSERT INTO results SELECT 'G1 no lock: store credit allowed', pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-00000000e001', 1000, 'JPY', 'store_credit')$q$) = 'ok', '';
DELETE FROM cash_payments WHERE cash_order_id = '00000000-0000-0000-0000-00000000e001';
-- a Paidy authorisation filed and waiting
INSERT INTO paidy_payments (id, cash_order_id, customer_id, paidy_payment_id, status, amount_jpy, expires_at) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-0000000000a1','pay_y','authorized',50000, now() + interval '20 days');
INSERT INTO payment_submissions (id, customer_id, cash_order_id, submitted_amount, payment_method, status, paidy_payment_id) VALUES ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000e001',50000,'paidy','submitted','00000000-0000-0000-0000-0000000000f1');
INSERT INTO results SELECT 'G2 lock reason', public.cash_order_payment_lock('00000000-0000-0000-0000-00000000e001') = 'paidy_submission_pending', public.cash_order_payment_lock('00000000-0000-0000-0000-00000000e001');
INSERT INTO results SELECT 'G3 paidy held: store credit refused', r LIKE 'paidy_in_progress: paidy_submission_pending%', r FROM (SELECT pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-00000000e001', 1000, 'JPY', 'store_credit')$q$) r) x;
INSERT INTO results SELECT 'G4 paidy held: loyalty refused', pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-00000000e001', 1000, 'JPY', 'loyalty_points')$q$) LIKE 'paidy_in_progress%', '';
INSERT INTO results SELECT 'G5 paidy held: manual transfer refused', pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-00000000e001', 1000, 'JPY', 'bank_transfer')$q$) LIKE 'paidy_in_progress%', '';
INSERT INTO results SELECT 'G6 paidy held: Paidy recording allowed', pg_temp.try($q$INSERT INTO cash_payments (id, cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-00000000e001', 50000, 'JPY', 'paidy')$q$) = 'ok', '';
INSERT INTO results SELECT 'G7 paidy held: a voided insert allowed', pg_temp.try($q$INSERT INTO cash_payments (id, cash_order_id, amount_paid, currency, payment_method, voided_at) VALUES ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-00000000e001', 1000, 'JPY', 'bank_transfer', now())$q$) = 'ok', '';
INSERT INTO results SELECT 'G8 paidy held: un-void refused', pg_temp.try($q$UPDATE cash_payments SET voided_at = NULL WHERE id = '00000000-0000-0000-0000-0000000000f4'$q$) LIKE 'paidy_in_progress%', '';
INSERT INTO results SELECT 'G9 paidy held: voiding allowed', pg_temp.try($q$UPDATE cash_payments SET voided_at = now() WHERE id = '00000000-0000-0000-0000-0000000000f3'$q$) = 'ok', '';
INSERT INTO results SELECT 'G10 paidy held: other column edit allowed', pg_temp.try($q$UPDATE cash_payments SET remarks = 'x' WHERE id = '00000000-0000-0000-0000-0000000000f4'$q$) = 'ok', '';
-- G-11 staff Reject: submission rejected and Paidy closed → order open again
UPDATE payment_submissions SET status = 'rejected' WHERE id = '00000000-0000-0000-0000-0000000000f2';
UPDATE paidy_payments SET status = 'closed' WHERE id = '00000000-0000-0000-0000-0000000000f1';
INSERT INTO results SELECT 'G11 after Reject: lock clear', public.cash_order_payment_lock('00000000-0000-0000-0000-00000000e001') IS NULL, coalesce(public.cash_order_payment_lock('00000000-0000-0000-0000-00000000e001'),'null');
INSERT INTO results SELECT 'G12 after Reject: store credit allowed', pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-00000000e001', 1000, 'JPY', 'store_credit')$q$) = 'ok', '';
INSERT INTO results SELECT 'G13 after Reject: un-void allowed', pg_temp.try($q$UPDATE cash_payments SET voided_at = NULL WHERE id = '00000000-0000-0000-0000-0000000000f4'$q$) = 'ok', '';
-- G-14 Paidy window open (checkout attempt) → refused
INSERT INTO cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status, source_channel, payment_status)
VALUES ('00000000-0000-0000-0000-00000000e002', 'CJ-F', '00000000-0000-0000-0000-0000000000a1', 'JPY', 50000, 0, 50000, 'pending', 'web', 'pending_transfer');
INSERT INTO paidy_checkout_attempts (cash_order_id, customer_id, status, amount_jpy, expires_at) VALUES ('00000000-0000-0000-0000-00000000e002','00000000-0000-0000-0000-0000000000a1','open',50000, now() + interval '30 minutes');
INSERT INTO results SELECT 'G14 window open: store credit refused', pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-00000000e002', 1000, 'JPY', 'store_credit')$q$) LIKE 'paidy_in_progress: paidy_checkout_open%', '';
-- G-15 captured but not recorded → refused
INSERT INTO cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status, source_channel, payment_status)
VALUES ('00000000-0000-0000-0000-00000000e003', 'CJ-G', '00000000-0000-0000-0000-0000000000a1', 'JPY', 50000, 0, 50000, 'pending', 'web', 'pending_transfer');
INSERT INTO paidy_payments (cash_order_id, customer_id, paidy_payment_id, status, amount_jpy) VALUES ('00000000-0000-0000-0000-00000000e003','00000000-0000-0000-0000-0000000000a1','pay_z','captured',50000);
INSERT INTO results SELECT 'G15 captured unrecorded: loyalty refused', pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-00000000e003', 1000, 'JPY', 'loyalty_points')$q$) LIKE 'paidy_in_progress: paidy_captured_unrecorded%', '';
-- G-16 an expired authorisation no longer holds the order
INSERT INTO cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status, source_channel, payment_status)
VALUES ('00000000-0000-0000-0000-00000000e004', 'CJ-H', '00000000-0000-0000-0000-0000000000a1', 'JPY', 50000, 0, 50000, 'pending', 'web', 'pending_transfer');
INSERT INTO paidy_payments (cash_order_id, customer_id, paidy_payment_id, status, amount_jpy, authorized_at, expires_at) VALUES ('00000000-0000-0000-0000-00000000e004','00000000-0000-0000-0000-0000000000a1','pay_w','authorized',50000, now() - interval '40 days', now() - interval '10 days');
INSERT INTO results SELECT 'G16 expired authorisation: allowed', pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-00000000e004', 1000, 'JPY', 'store_credit')$q$) = 'ok', '';
-- G-18 a live row moved onto a Paidy-held order → refused (review nit, 2026-10-04)
INSERT INTO results SELECT 'G18 live row moved onto held order: refused', pg_temp.try($q$UPDATE cash_payments SET cash_order_id = '00000000-0000-0000-0000-00000000e003' WHERE cash_order_id = '00000000-0000-0000-0000-00000000e004'$q$) LIKE 'paidy_in_progress%', '';
-- G-19 un-void + relabel to paidy in one UPDATE → refused
INSERT INTO cash_payments (id, cash_order_id, amount_paid, currency, payment_method, voided_at) VALUES ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-00000000e003', 1000, 'JPY', 'bank_transfer', now());
INSERT INTO results SELECT 'G19 un-void relabelled to paidy: refused', pg_temp.try($q$UPDATE cash_payments SET voided_at = NULL, payment_method = 'paidy' WHERE id = '00000000-0000-0000-0000-0000000000f5'$q$) LIKE 'paidy_in_progress%', '';
-- G-17 a layaway-only payment row (no cash order) is untouched
INSERT INTO results SELECT 'G17 no cash order: allowed', pg_temp.try($q$INSERT INTO cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES (NULL, 1000, 'JPY', 'store_credit')$q$) = 'ok', '';

SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS r, name, detail FROM results ORDER BY ok, name;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM results;
