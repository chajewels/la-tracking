-- RECORD-ONLY (repo structure catch-up, owner go 2026-10-09). The HEAD.
--
-- Live holds tables, columns and enum types that were created in the SQL
-- Editor (or by a Lovable session) and never committed as a migration, yet
-- later migrations use them. On an empty database the repo could not rebuild
-- live (V03 evidence, finding F2). This file records them, read from live's
-- catalog on 2026-10-09, right after the 2026-07-05 baseline.
--
-- Everything is IF NOT EXISTS / duplicate-safe: applying this to live changes
-- nothing. Tables carry their columns, defaults and primary key only — their
-- other constraints, indexes, triggers, policies and grants are recorded by
-- 20261023235900_record_live_only_policies.sql and
-- 20261130140000_record_live_structure_tail.sql, where everything they refer
-- to already exists.
--
-- Record-only: committed, NOT applied by Lovable. If it is ever applied to live
-- by mistake it is a proven no-op (re-applied to a live-identical rebuild on
-- 2026-10-09: no catalog change); the lock timeout keeps it from queueing
-- behind a long reader.
SET LOCAL lock_timeout = '5s';

DO $e$ BEGIN CREATE TYPE public.store_credit_lot_status AS ENUM ('active', 'consumed', 'expired', 'voided'); EXCEPTION WHEN duplicate_object THEN NULL; END $e$;
DO $e$ BEGIN CREATE TYPE public.store_credit_txn_type AS ENUM ('issued', 'redeemed', 'expired', 'voided', 'adjusted'); EXCEPTION WHEN duplicate_object THEN NULL; END $e$;
ALTER TABLE public.cash_orders ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'hub_manual'::text;
-- Columns on live never added by any migration (read from live 2026-10-09).
ALTER TABLE public.cash_orders ADD COLUMN IF NOT EXISTS shipping_fee numeric(12,2) DEFAULT 0 NOT NULL;
ALTER TABLE public.cash_orders ADD COLUMN IF NOT EXISTS shopify_order_id text;
ALTER TABLE public.cash_orders ADD COLUMN IF NOT EXISTS pancake_order_id text;
ALTER TABLE public.commission_splits ADD COLUMN IF NOT EXISTS top_sales_2_pct numeric DEFAULT 0 NOT NULL;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS needs_review boolean DEFAULT false NOT NULL;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS shopify_customer_id text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS pancake_fb_id text;
ALTER TABLE public.layaway_accounts ADD COLUMN IF NOT EXISTS shipping_fee numeric(15,2) DEFAULT 0 NOT NULL;
ALTER TABLE public.layaway_accounts ADD COLUMN IF NOT EXISTS pancake_order_id text;
ALTER TABLE public.penalty_waiver_requests ADD COLUMN IF NOT EXISTS auto_unwaived_at timestamp with time zone;
ALTER TABLE public.penalty_waiver_requests ADD COLUMN IF NOT EXISTS is_auto boolean DEFAULT false NOT NULL;
ALTER TABLE public.penalty_waiver_requests ADD COLUMN IF NOT EXISTS source_submission_id uuid;
CREATE TABLE IF NOT EXISTS public.cash_order_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cash_order_id uuid NOT NULL,
  product_id uuid,
  shopify_line_item_id text,
  title text NOT NULL,
  sku text,
  quantity integer NOT NULL DEFAULT 1,
  unit_price_jpy numeric(12,2) NOT NULL,
  line_total_jpy numeric(12,2) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  image_url text,
  variant_id uuid,
  website_product_id uuid,
  CONSTRAINT cash_order_items_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.message_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  message_type text NOT NULL,
  part text NOT NULL,
  body text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT message_lines_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_norm text,
  lang text NOT NULL DEFAULT 'en'::text,
  source text,
  customer_id uuid,
  consented_at timestamp with time zone NOT NULL DEFAULT now(),
  unsubscribed_at timestamp with time zone,
  unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_subscribers_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.pancake_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  pancake_order_id text NOT NULL,
  system_id bigint,
  event_type text NOT NULL,
  event_updated_at timestamp with time zone NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  attempts integer NOT NULL DEFAULT 0,
  error_detail text,
  raw_payload jsonb NOT NULL,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  processed_at timestamp with time zone,
  CONSTRAINT pancake_events_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.product_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invite_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  cash_order_id uuid,
  layaway_account_id uuid,
  website_product_id uuid,
  piece_name text NOT NULL,
  rating smallint NOT NULL,
  body_original text NOT NULL,
  original_language text,
  body_en text,
  body_ja text,
  display_name text NOT NULL,
  upload_paths text[] NOT NULL DEFAULT '{}'::text[],
  photo_urls text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'pending'::text,
  reject_reason text,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  submitted_ip_hash text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT product_reviews_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.products (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  shopify_product_id text NOT NULL,
  title text NOT NULL,
  sku text,
  price_jpy numeric(12,2),
  inventory_quantity integer,
  barcode text,
  status text NOT NULL,
  vendor text,
  handle text,
  product_type text,
  tags text[],
  collection_titles text[],
  image_url text,
  description text,
  shopify_updated_at timestamp with time zone,
  synced_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT products_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.review_invites (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  cash_order_id uuid,
  layaway_account_id uuid,
  website_product_id uuid,
  piece_name text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT review_invites_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.service_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  cash_order_id uuid,
  layaway_account_id uuid,
  item_title text,
  kind text NOT NULL,
  details text NOT NULL,
  ring_size text,
  status text NOT NULL DEFAULT 'requested'::text,
  staff_note text,
  customer_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  service_job_id uuid,
  web_draft_id uuid,
  CONSTRAINT service_requests_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.shopify_webhook_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL,
  topic text NOT NULL,
  webhook_id text,
  status text NOT NULL DEFAULT 'processed'::text,
  error_detail text,
  processed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shopify_webhook_events_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.store_credit_lots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  currency account_currency NOT NULL,
  original_amount numeric(12,2) NOT NULL,
  remaining_amount numeric(12,2) NOT NULL,
  status store_credit_lot_status NOT NULL DEFAULT 'active'::store_credit_lot_status,
  source_type text NOT NULL,
  source_account_id uuid,
  source_cash_order_id uuid,
  rate_snapshot numeric,
  notes text,
  issued_by_user_id uuid,
  issued_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  source_refund_id text,
  CONSTRAINT store_credit_lots_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.store_credit_reconciliation (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  shopify_customer_id text,
  currency account_currency NOT NULL,
  hub_balance numeric(12,2) NOT NULL DEFAULT 0,
  shopify_balance numeric(12,2),
  delta numeric(12,2),
  status text NOT NULL,
  detail text,
  checked_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT store_credit_reconciliation_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.store_credit_shopify_sync (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  shopify_customer_id text,
  lot_id uuid,
  direction text NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency account_currency NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  shopify_transaction_id text,
  shopify_balance_after numeric(12,2),
  error_detail text,
  attempts integer NOT NULL DEFAULT 0,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  synced_at timestamp with time zone,
  CONSTRAINT store_credit_shopify_sync_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.store_credit_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  lot_id uuid,
  txn_type store_credit_txn_type NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency account_currency NOT NULL,
  account_id uuid,
  cash_order_id uuid,
  balance_after numeric(12,2),
  notes text,
  performed_by_user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT store_credit_transactions_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.website_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  name_ja text,
  description text,
  description_ja text,
  hero_media text,
  cta_label text,
  cta_label_ja text,
  sort_order integer NOT NULL DEFAULT 100,
  published boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT website_categories_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.website_category_products (
  category_id uuid NOT NULL,
  product_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  CONSTRAINT website_category_products_pkey PRIMARY KEY (category_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.website_testimonials (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_name text NOT NULL,
  location text,
  quote_en text,
  quote_ja text,
  item text,
  rating smallint,
  sort_order integer NOT NULL DEFAULT 100,
  published boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  testimonial_date date,
  CONSTRAINT website_testimonials_pkey PRIMARY KEY (id)
);
-- website_settings: created on live in the SQL Editor; first used by 20260921144439 (Lovable),
-- recorded by 20260921150000 (IF NOT EXISTS). Same shape as that record migration.
CREATE TABLE IF NOT EXISTS public.website_settings (
  key text PRIMARY KEY, value jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text','bilingual','json','bool','date')),
  public boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
-- website_posts: on live outside migrations; first used by 20260921150921_680ed7a9-c775-41ed-abf6-6f6833546215.sql
CREATE TABLE IF NOT EXISTS public.website_posts (id uuid NOT NULL, slug text NOT NULL, type text NOT NULL, title_en text NOT NULL, title_ja text, excerpt_en text, excerpt_ja text, body_en text NOT NULL, body_ja text, cover_media text, published boolean NOT NULL, published_at date, layaway_only boolean NOT NULL, created_at timestamp with time zone NOT NULL, updated_at timestamp with time zone NOT NULL, updated_by uuid);
ALTER TABLE public.website_posts ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.website_posts ALTER COLUMN type SET DEFAULT 'article'::text;
ALTER TABLE public.website_posts ALTER COLUMN published SET DEFAULT false;
ALTER TABLE public.website_posts ALTER COLUMN layaway_only SET DEFAULT false;
ALTER TABLE public.website_posts ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.website_posts ALTER COLUMN updated_at SET DEFAULT now();
DO $e$ BEGIN ALTER TABLE public.website_posts ADD CONSTRAINT website_posts_pkey PRIMARY KEY (id); EXCEPTION WHEN invalid_table_definition OR duplicate_object THEN NULL; END $e$;

-- website_faq_sections: on live outside migrations; first used by 20260921234018_6dd103c6-cbd3-4796-86b0-d27611c2a178.sql
CREATE TABLE IF NOT EXISTS public.website_faq_sections (id uuid NOT NULL, slug text NOT NULL, title_en text NOT NULL, title_ja text, sort_order integer NOT NULL, published boolean NOT NULL, created_at timestamp with time zone NOT NULL, updated_at timestamp with time zone NOT NULL, updated_by uuid);
ALTER TABLE public.website_faq_sections ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.website_faq_sections ALTER COLUMN sort_order SET DEFAULT 100;
ALTER TABLE public.website_faq_sections ALTER COLUMN published SET DEFAULT true;
ALTER TABLE public.website_faq_sections ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.website_faq_sections ALTER COLUMN updated_at SET DEFAULT now();
DO $e$ BEGIN ALTER TABLE public.website_faq_sections ADD CONSTRAINT website_faq_sections_pkey PRIMARY KEY (id); EXCEPTION WHEN invalid_table_definition OR duplicate_object THEN NULL; END $e$;

-- website_faq_items: on live outside migrations; first used by 20260921234018_6dd103c6-cbd3-4796-86b0-d27611c2a178.sql
CREATE TABLE IF NOT EXISTS public.website_faq_items (id uuid NOT NULL, section_id uuid NOT NULL, question_en text NOT NULL, question_ja text, answer_en text NOT NULL, answer_ja text, layaway_only boolean NOT NULL, sort_order integer NOT NULL, published boolean NOT NULL, created_at timestamp with time zone NOT NULL, updated_at timestamp with time zone NOT NULL, updated_by uuid);
ALTER TABLE public.website_faq_items ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.website_faq_items ALTER COLUMN layaway_only SET DEFAULT false;
ALTER TABLE public.website_faq_items ALTER COLUMN sort_order SET DEFAULT 100;
ALTER TABLE public.website_faq_items ALTER COLUMN published SET DEFAULT true;
ALTER TABLE public.website_faq_items ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.website_faq_items ALTER COLUMN updated_at SET DEFAULT now();
DO $e$ BEGIN ALTER TABLE public.website_faq_items ADD CONSTRAINT website_faq_items_pkey PRIMARY KEY (id); EXCEPTION WHEN invalid_table_definition OR duplicate_object THEN NULL; END $e$;

