-- Fixtures mirroring the live pre-flight state recorded in docs/STEP4-ACCEPTANCE.md §0.
INSERT INTO public.plan_configurations (plan_months, min_amount_jpy, min_amount_php, dp_percentage, is_active, display_label, risk_tier) VALUES
 (3,       0,      0, 0.30, true, '3 Months',  'LOW'),
 (6,   25000,  10500, 0.30, true, '6 Months',  'LOW'),
 (8,  300000, 126000, 0.30, true, '8 Months',  'MODERATE'),
 (10, 600000, 252000, 0.30, true, '10 Months', 'HIGH'),
 (12,1000000, 420000, 0.30, true, '12 Months', 'CRITICAL');

INSERT INTO public.system_settings (key, value) VALUES ('php_jpy_rate', '"0.42"'::jsonb);

-- Test Customer, is_test = true, exactly as live (invoices auto-prefix TEST-).
INSERT INTO public.customers (id, customer_code, full_name, email, is_test, country)
VALUES ('4201767c-54e6-48d0-8c9e-c1b3c07a931e','CJ-2026-05088','Test Customer','test@example.com', true, 'JP');
-- A second, NON-test customer: needed to see behaviour without the TEST- prefix.
INSERT INTO public.customers (id, customer_code, full_name, email, is_test, country)
VALUES ('11111111-1111-4111-8111-111111111111','CJ-2026-09999','Real Customer','real@example.com', false, 'JP');

-- The three catalog pieces and their measured stock.
INSERT INTO public.website_products (id, sku, slug, name, name_ja, status) VALUES
 ('a0000000-0000-4000-8000-000000000001','R7828','ring-r7828','Ring 750 YG/WG Diamond 2.70ct','リング','active'),
 ('a0000000-0000-4000-8000-000000000002','N4020','necklace-n4020','Necklace Tiffany & Co. Open Teardrop','ネックレス','active'),
 ('a0000000-0000-4000-8000-000000000003','R3341','ring-r3341','Ring K18WG Diamond 3.82ct','リング','active');
INSERT INTO public.website_product_variants (id, product_id, size, price_jpy, stock_qty) VALUES
 ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','12', 679980, 1),
 ('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002',NULL,  72980, 3),
 ('b0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000003','10', 628980, 0);

-- A staff user for the audit-actor checks.
INSERT INTO public.profiles (user_id, full_name, email) VALUES ('22222222-2222-4222-8222-222222222222','Cynthia','cyn@example.com');
INSERT INTO public.user_roles (user_id, role) VALUES ('22222222-2222-4222-8222-222222222222','admin');
