-- RECORD-ONLY (repo structure catch-up, owner go 2026-10-09). The TAIL.
--
-- After every migration in this repo has run on an empty database, these are
-- the differences that remain against live (read from live's catalog on
-- 2026-10-09 by scripts/structure-drift-audit). Every statement is guarded so
-- that on live — where all of this is already true — NOTHING executes; on an
-- empty database it makes the rebuild equal to live.
--
-- Sections: enum value, column shapes, view, constraints, indexes, triggers,
-- RLS policies, function grants, table grants. Lovable's platform role sandbox_exec* is
-- ignored (it is not ours and differs per project).
--
-- Record-only: committed, NOT applied by Lovable. If it is ever applied to live
-- by mistake it is a proven no-op (re-applied to a live-identical rebuild on
-- 2026-10-09: no catalog change); the lock timeout keeps it from queueing
-- behind a long reader.
SET LOCAL lock_timeout = '5s';

-- 1. Enum value live has (penalty waiver auto-unwaive, 2026-08-18).
ALTER TYPE public.waiver_status ADD VALUE IF NOT EXISTS 'auto_unwaived';

-- 2. Column shapes.
DO $c$ BEGIN
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.layaway_account_items'::regclass AND attname = 'unit_price_jpy') <> 'numeric(12,2)' THEN
    ALTER TABLE public.layaway_account_items ALTER COLUMN unit_price_jpy TYPE numeric(12,2);
  END IF;
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.layaway_account_items'::regclass AND attname = 'line_total_jpy') <> 'numeric(12,2)' THEN
    ALTER TABLE public.layaway_account_items ALTER COLUMN line_total_jpy TYPE numeric(12,2);
  END IF;
  IF (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.penalty_waiver_requests'::regclass AND attname = 'requested_by_user_id') THEN
    ALTER TABLE public.penalty_waiver_requests ALTER COLUMN requested_by_user_id DROP NOT NULL;
  END IF;
  -- live: a GENERATED column (lower(btrim(email))), not a plain one
  IF (SELECT attgenerated FROM pg_attribute WHERE attrelid = 'public.newsletter_subscribers'::regclass AND attname = 'email_norm') IS DISTINCT FROM 's' THEN
    ALTER TABLE public.newsletter_subscribers DROP COLUMN IF EXISTS email_norm;
    ALTER TABLE public.newsletter_subscribers ADD COLUMN email_norm text GENERATED ALWAYS AS (lower(btrim(email))) STORED;
  END IF;
END $c$;

-- 3. View live has and no migration creates (CLAUDE.md "Active Features").
DO $v$ BEGIN IF to_regclass('public.product_inquiries_with_accumulated') IS NULL THEN EXECUTE 'CREATE VIEW public.product_inquiries_with_accumulated WITH (security_invoker = on) AS SELECT id,
    item_code,
    product_name,
    category,
    inquiry_count,
    last_inquired_date,
    popular_inquiries_notes,
    source,
    action_needed,
    order_placed,
    inquirer_name,
    entered_by,
    created_at,
    updated_at,
        CASE
            WHEN (COALESCE(NULLIF(btrim(item_code), ''''::text), NULLIF(btrim(product_name), ''''::text)) IS NULL) THEN NULL::integer
            ELSE (sum(inquiry_count) OVER (PARTITION BY (lower(COALESCE(NULLIF(btrim(item_code), ''''::text), NULLIF(btrim(product_name), ''''::text)))) ORDER BY last_inquired_date NULLS FIRST, created_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::integer
        END AS accumulated_inquiry_count
   FROM product_inquiries pi'; END IF; END $v$;

-- 4. Constraints (add if missing by name; replace where live's definition differs).
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cash_order_items'::regclass AND conname = 'cash_order_items_cash_order_id_fkey') THEN ALTER TABLE public.cash_order_items ADD CONSTRAINT cash_order_items_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cash_order_items'::regclass AND conname = 'cash_order_items_product_id_fkey') THEN ALTER TABLE public.cash_order_items ADD CONSTRAINT cash_order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cash_order_items'::regclass AND conname = 'cash_order_items_variant_id_fkey') THEN ALTER TABLE public.cash_order_items ADD CONSTRAINT cash_order_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES website_product_variants(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cash_order_items'::regclass AND conname = 'cash_order_items_website_product_id_fkey') THEN ALTER TABLE public.cash_order_items ADD CONSTRAINT cash_order_items_website_product_id_fkey FOREIGN KEY (website_product_id) REFERENCES website_products(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.layaway_account_items'::regclass AND conname = 'layaway_account_items_product_id_fkey') THEN ALTER TABLE public.layaway_account_items ADD CONSTRAINT layaway_account_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.message_lines'::regclass AND conname = 'message_lines_part_check') THEN ALTER TABLE public.message_lines ADD CONSTRAINT message_lines_part_check CHECK ((part = ANY (ARRAY['opening'::text, 'closing'::text, 'full'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.newsletter_subscribers'::regclass AND conname = 'newsletter_subscribers_customer_id_fkey') THEN ALTER TABLE public.newsletter_subscribers ADD CONSTRAINT newsletter_subscribers_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.newsletter_subscribers'::regclass AND conname = 'newsletter_subscribers_lang_check') THEN ALTER TABLE public.newsletter_subscribers ADD CONSTRAINT newsletter_subscribers_lang_check CHECK ((lang = ANY (ARRAY['en'::text, 'ja'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pancake_events'::regclass AND conname = 'pancake_events_idem_key') THEN ALTER TABLE public.pancake_events ADD CONSTRAINT pancake_events_idem_key UNIQUE (pancake_order_id, event_type, event_updated_at); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pancake_events'::regclass AND conname = 'pancake_events_status_check') THEN ALTER TABLE public.pancake_events ADD CONSTRAINT pancake_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processed'::text, 'skipped'::text, 'error'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_reviews'::regclass AND conname = 'product_reviews_body_original_check') THEN ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_body_original_check CHECK (((char_length(body_original) >= 10) AND (char_length(body_original) <= 2000))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_reviews'::regclass AND conname = 'product_reviews_customer_id_fkey') THEN ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_reviews'::regclass AND conname = 'product_reviews_invite_id_fkey') THEN ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES review_invites(id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_reviews'::regclass AND conname = 'product_reviews_invite_id_key') THEN ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_invite_id_key UNIQUE (invite_id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_reviews'::regclass AND conname = 'product_reviews_original_language_check') THEN ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_original_language_check CHECK ((original_language = ANY (ARRAY['en'::text, 'ja'::text, 'tl'::text, 'mixed'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_reviews'::regclass AND conname = 'product_reviews_rating_check') THEN ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_reviews'::regclass AND conname = 'product_reviews_status_check') THEN ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'hidden'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.product_reviews'::regclass AND conname = 'product_reviews_website_product_id_fkey') THEN ALTER TABLE public.product_reviews ADD CONSTRAINT product_reviews_website_product_id_fkey FOREIGN KEY (website_product_id) REFERENCES website_products(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.products'::regclass AND conname = 'products_shopify_product_id_key') THEN ALTER TABLE public.products ADD CONSTRAINT products_shopify_product_id_key UNIQUE (shopify_product_id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.review_invites'::regclass AND conname = 'review_invites_cash_order_id_fkey') THEN ALTER TABLE public.review_invites ADD CONSTRAINT review_invites_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.review_invites'::regclass AND conname = 'review_invites_created_by_fkey') THEN ALTER TABLE public.review_invites ADD CONSTRAINT review_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.review_invites'::regclass AND conname = 'review_invites_customer_id_fkey') THEN ALTER TABLE public.review_invites ADD CONSTRAINT review_invites_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.review_invites'::regclass AND conname = 'review_invites_layaway_account_id_fkey') THEN ALTER TABLE public.review_invites ADD CONSTRAINT review_invites_layaway_account_id_fkey FOREIGN KEY (layaway_account_id) REFERENCES layaway_accounts(id); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.review_invites'::regclass AND conname = 'review_invites_one_order') THEN ALTER TABLE public.review_invites ADD CONSTRAINT review_invites_one_order CHECK ((num_nonnulls(cash_order_id, layaway_account_id) = 1)); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.review_invites'::regclass AND conname = 'review_invites_piece_name_check') THEN ALTER TABLE public.review_invites ADD CONSTRAINT review_invites_piece_name_check CHECK (((char_length(btrim(piece_name)) >= 1) AND (char_length(btrim(piece_name)) <= 200))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.review_invites'::regclass AND conname = 'review_invites_token_hash_key') THEN ALTER TABLE public.review_invites ADD CONSTRAINT review_invites_token_hash_key UNIQUE (token_hash); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.review_invites'::regclass AND conname = 'review_invites_website_product_id_fkey') THEN ALTER TABLE public.review_invites ADD CONSTRAINT review_invites_website_product_id_fkey FOREIGN KEY (website_product_id) REFERENCES website_products(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_cash_order_id_fkey') THEN ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_customer_id_fkey') THEN ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_kind_check') THEN ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_kind_check CHECK ((kind = ANY (ARRAY['resize'::text, 'cleaning'::text, 'repair'::text, 'appraisal'::text, 'other'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_layaway_account_id_fkey') THEN ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_layaway_account_id_fkey FOREIGN KEY (layaway_account_id) REFERENCES layaway_accounts(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_service_job_id_fkey') THEN ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_service_job_id_fkey FOREIGN KEY (service_job_id) REFERENCES service_jobs(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_status_check') THEN ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'received'::text, 'in_progress'::text, 'completed'::text, 'declined'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_web_draft_id_fkey') THEN ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_web_draft_id_fkey FOREIGN KEY (web_draft_id) REFERENCES web_order_drafts(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_lots'::regclass AND conname = 'store_credit_lots_customer_id_fkey') THEN ALTER TABLE public.store_credit_lots ADD CONSTRAINT store_credit_lots_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_lots'::regclass AND conname = 'store_credit_lots_original_amount_check') THEN ALTER TABLE public.store_credit_lots ADD CONSTRAINT store_credit_lots_original_amount_check CHECK ((original_amount > (0)::numeric)); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_lots'::regclass AND conname = 'store_credit_lots_remaining_amount_check') THEN ALTER TABLE public.store_credit_lots ADD CONSTRAINT store_credit_lots_remaining_amount_check CHECK ((remaining_amount >= (0)::numeric)); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_lots'::regclass AND conname = 'store_credit_lots_remaining_le_original') THEN ALTER TABLE public.store_credit_lots ADD CONSTRAINT store_credit_lots_remaining_le_original CHECK ((remaining_amount <= original_amount)); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_lots'::regclass AND conname = 'store_credit_lots_source_account_id_fkey') THEN ALTER TABLE public.store_credit_lots ADD CONSTRAINT store_credit_lots_source_account_id_fkey FOREIGN KEY (source_account_id) REFERENCES layaway_accounts(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_lots'::regclass AND conname = 'store_credit_lots_source_cash_order_id_fkey') THEN ALTER TABLE public.store_credit_lots ADD CONSTRAINT store_credit_lots_source_cash_order_id_fkey FOREIGN KEY (source_cash_order_id) REFERENCES cash_orders(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_lots'::regclass AND conname = 'store_credit_lots_source_type_chk') THEN ALTER TABLE public.store_credit_lots ADD CONSTRAINT store_credit_lots_source_type_chk CHECK ((source_type = ANY (ARRAY['cancelled_layaway'::text, 'cancelled_cash'::text, 'manual_admin'::text, 'shopify_partial_refund'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_reconciliation'::regclass AND conname = 'store_credit_reconciliation_customer_fkey') THEN ALTER TABLE public.store_credit_reconciliation ADD CONSTRAINT store_credit_reconciliation_customer_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_reconciliation'::regclass AND conname = 'store_credit_reconciliation_status_chk') THEN ALTER TABLE public.store_credit_reconciliation ADD CONSTRAINT store_credit_reconciliation_status_chk CHECK ((status = ANY (ARRAY['match'::text, 'drift'::text, 'shopify_unreadable'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_shopify_sync'::regclass AND conname = 'store_credit_shopify_sync_customer_fkey') THEN ALTER TABLE public.store_credit_shopify_sync ADD CONSTRAINT store_credit_shopify_sync_customer_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_shopify_sync'::regclass AND conname = 'store_credit_shopify_sync_direction_chk') THEN ALTER TABLE public.store_credit_shopify_sync ADD CONSTRAINT store_credit_shopify_sync_direction_chk CHECK ((direction = ANY (ARRAY['credit'::text, 'debit'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_shopify_sync'::regclass AND conname = 'store_credit_shopify_sync_lot_fkey') THEN ALTER TABLE public.store_credit_shopify_sync ADD CONSTRAINT store_credit_shopify_sync_lot_fkey FOREIGN KEY (lot_id) REFERENCES store_credit_lots(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_shopify_sync'::regclass AND conname = 'store_credit_shopify_sync_status_chk') THEN ALTER TABLE public.store_credit_shopify_sync ADD CONSTRAINT store_credit_shopify_sync_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'synced'::text, 'failed'::text, 'skipped'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_transactions'::regclass AND conname = 'store_credit_transactions_account_id_fkey') THEN ALTER TABLE public.store_credit_transactions ADD CONSTRAINT store_credit_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_transactions'::regclass AND conname = 'store_credit_transactions_cash_order_id_fkey') THEN ALTER TABLE public.store_credit_transactions ADD CONSTRAINT store_credit_transactions_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_transactions'::regclass AND conname = 'store_credit_transactions_customer_id_fkey') THEN ALTER TABLE public.store_credit_transactions ADD CONSTRAINT store_credit_transactions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.store_credit_transactions'::regclass AND conname = 'store_credit_transactions_lot_id_fkey') THEN ALTER TABLE public.store_credit_transactions ADD CONSTRAINT store_credit_transactions_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES store_credit_lots(id) ON DELETE SET NULL; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.website_categories'::regclass AND conname = 'website_categories_slug_key') THEN ALTER TABLE public.website_categories ADD CONSTRAINT website_categories_slug_key UNIQUE (slug); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.website_category_products'::regclass AND conname = 'website_category_products_category_id_fkey') THEN ALTER TABLE public.website_category_products ADD CONSTRAINT website_category_products_category_id_fkey FOREIGN KEY (category_id) REFERENCES website_categories(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.website_category_products'::regclass AND conname = 'website_category_products_product_id_fkey') THEN ALTER TABLE public.website_category_products ADD CONSTRAINT website_category_products_product_id_fkey FOREIGN KEY (product_id) REFERENCES website_products(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.website_faq_items'::regclass AND conname = 'website_faq_items_section_id_fkey') THEN ALTER TABLE public.website_faq_items ADD CONSTRAINT website_faq_items_section_id_fkey FOREIGN KEY (section_id) REFERENCES website_faq_sections(id) ON DELETE CASCADE; END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.website_faq_sections'::regclass AND conname = 'website_faq_sections_slug_key') THEN ALTER TABLE public.website_faq_sections ADD CONSTRAINT website_faq_sections_slug_key UNIQUE (slug); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.website_posts'::regclass AND conname = 'website_posts_slug_key') THEN ALTER TABLE public.website_posts ADD CONSTRAINT website_posts_slug_key UNIQUE (slug); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.website_posts'::regclass AND conname = 'website_posts_type_check') THEN ALTER TABLE public.website_posts ADD CONSTRAINT website_posts_type_check CHECK ((type = ANY (ARRAY['article'::text, 'news'::text]))); END IF; END $k$;
DO $k$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.website_testimonials'::regclass AND conname = 'website_testimonials_rating_check') THEN ALTER TABLE public.website_testimonials ADD CONSTRAINT website_testimonials_rating_check CHECK (((rating >= 1) AND (rating <= 5))); END IF; END $k$;
-- live has no layaway_account_items_quantity_check on layaway_account_items: a migration added it where live already had the table.
ALTER TABLE public.layaway_account_items DROP CONSTRAINT IF EXISTS layaway_account_items_quantity_check;
DO $k$ BEGIN IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_service_job_id_fkey') <> 'FOREIGN KEY (service_job_id) REFERENCES service_jobs(id) ON DELETE SET NULL' THEN ALTER TABLE public.service_requests DROP CONSTRAINT service_requests_service_job_id_fkey; ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_service_job_id_fkey FOREIGN KEY (service_job_id) REFERENCES service_jobs(id) ON DELETE SET NULL; END IF; END $k$;

-- 5. Indexes.
CREATE INDEX IF NOT EXISTS idx_cash_order_items_order ON public.cash_order_items USING btree (cash_order_id);
CREATE INDEX IF NOT EXISTS idx_cash_order_items_product ON public.cash_order_items USING btree (product_id);
CREATE INDEX IF NOT EXISTS idx_layaway_items_account ON public.layaway_account_items USING btree (account_id);
CREATE INDEX IF NOT EXISTS idx_layaway_items_product ON public.layaway_account_items USING btree (product_id);
CREATE INDEX IF NOT EXISTS idx_message_lines_type ON public.message_lines USING btree (message_type, part) WHERE active;
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_approved ON public.product_reviews USING btree (website_product_id) WHERE (status = 'approved'::text);
CREATE INDEX IF NOT EXISTS idx_product_reviews_status_reviewed ON public.product_reviews USING btree (status, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_collections ON public.products USING gin (collection_titles);
CREATE INDEX IF NOT EXISTS idx_products_sku ON public.products USING btree (sku);
CREATE INDEX IF NOT EXISTS idx_products_status ON public.products USING btree (status);
CREATE INDEX IF NOT EXISTS idx_review_invites_cash_order ON public.review_invites USING btree (cash_order_id);
CREATE INDEX IF NOT EXISTS idx_review_invites_layaway ON public.review_invites USING btree (layaway_account_id);
CREATE INDEX IF NOT EXISTS idx_sc_recon_customer ON public.store_credit_reconciliation USING btree (customer_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_sc_recon_drift ON public.store_credit_reconciliation USING btree (checked_at DESC) WHERE (status <> 'match'::text);
CREATE INDEX IF NOT EXISTS idx_sc_recon_run ON public.store_credit_reconciliation USING btree (run_id, status);
CREATE INDEX IF NOT EXISTS idx_sc_shopify_sync_customer ON public.store_credit_shopify_sync USING btree (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sc_shopify_sync_failed ON public.store_credit_shopify_sync USING btree (status) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));
CREATE INDEX IF NOT EXISTS idx_store_credit_lots_customer ON public.store_credit_lots USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_store_credit_lots_expiry_sweep ON public.store_credit_lots USING btree (expires_at) WHERE (status = 'active'::store_credit_lot_status);
CREATE INDEX IF NOT EXISTS idx_store_credit_lots_fifo ON public.store_credit_lots USING btree (customer_id, expires_at) WHERE (status = 'active'::store_credit_lot_status);
CREATE INDEX IF NOT EXISTS idx_store_credit_txn_customer ON public.store_credit_transactions USING btree (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_credit_txn_lot ON public.store_credit_transactions USING btree (lot_id);
CREATE INDEX IF NOT EXISTS newsletter_subscribers_unsubscribed_at_idx ON public.newsletter_subscribers USING btree (unsubscribed_at);
CREATE INDEX IF NOT EXISTS pancake_events_retry_idx ON public.pancake_events USING btree (status) WHERE (status <> 'processed'::text);
CREATE INDEX IF NOT EXISTS service_requests_customer_id_created_at_idx ON public.service_requests USING btree (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS service_requests_service_job_id_idx ON public.service_requests USING btree (service_job_id);
CREATE INDEX IF NOT EXISTS service_requests_status_idx ON public.service_requests USING btree (status);
CREATE INDEX IF NOT EXISTS website_category_products_product_id_idx ON public.website_category_products USING btree (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS cash_orders_pancake_order_id_uidx ON public.cash_orders USING btree (pancake_order_id) WHERE (pancake_order_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS customers_pancake_fb_id_uidx ON public.customers USING btree (pancake_fb_id) WHERE (pancake_fb_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_order_items_shopify_line ON public.cash_order_items USING btree (shopify_line_item_id) WHERE (shopify_line_item_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_payments_reference_unique ON public.cash_payments USING btree (reference_number) WHERE ((reference_number IS NOT NULL) AND (voided_at IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shopify_customer_id ON public.customers USING btree (shopify_customer_id) WHERE (shopify_customer_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS layaway_accounts_pancake_order_id_uidx ON public.layaway_accounts USING btree (pancake_order_id) WHERE (pancake_order_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscribers_email_norm_key ON public.newsletter_subscribers USING btree (email_norm);
CREATE UNIQUE INDEX IF NOT EXISTS pancake_events_idem_key ON public.pancake_events USING btree (pancake_order_id, event_type, event_updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS product_reviews_invite_id_key ON public.product_reviews USING btree (invite_id);
CREATE UNIQUE INDEX IF NOT EXISTS products_shopify_product_id_key ON public.products USING btree (shopify_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS review_invites_token_hash_key ON public.review_invites USING btree (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_invites_open_per_order ON public.review_invites USING btree (COALESCE(cash_order_id, layaway_account_id)) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_credit_lots_source_refund ON public.store_credit_lots USING btree (source_refund_id) WHERE ((source_refund_id IS NOT NULL) AND (status <> 'voided'::store_credit_lot_status));
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_order_items_shopify_line_item_id ON public.cash_order_items USING btree (shopify_line_item_id) WHERE (shopify_line_item_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_orders_shopify_order_id ON public.cash_orders USING btree (shopify_order_id) WHERE (shopify_order_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_shopify_webhook_events_order_topic ON public.shopify_webhook_events USING btree (shopify_order_id, topic);
CREATE UNIQUE INDEX IF NOT EXISTS website_categories_slug_key ON public.website_categories USING btree (slug);
CREATE UNIQUE INDEX IF NOT EXISTS website_faq_sections_slug_key ON public.website_faq_sections USING btree (slug);
CREATE UNIQUE INDEX IF NOT EXISTS website_posts_slug_key ON public.website_posts USING btree (slug);
-- live has no idx_service_requests_service_job_id (it has an equivalent index of its own).
DROP INDEX IF EXISTS public.idx_service_requests_service_job_id;

-- 6. Triggers.
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'store_credit_lots_updated_at' AND tgrelid = 'public.store_credit_lots'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER store_credit_lots_updated_at BEFORE UPDATE ON public.store_credit_lots FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()'; END IF; END $t$;
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_auto_waive_same_day' AND tgrelid = 'public.payment_submissions'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER trg_auto_waive_same_day AFTER INSERT ON public.payment_submissions FOR EACH ROW EXECUTE FUNCTION auto_waive_same_day_penalties()'; END IF; END $t$;
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contact_inquiries_updated_at' AND tgrelid = 'public.contact_inquiries'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER trg_contact_inquiries_updated_at BEFORE UPDATE ON public.contact_inquiries FOR EACH ROW EXECUTE FUNCTION set_updated_at()'; END IF; END $t$;
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_note_account_status_change' AND tgrelid = 'public.layaway_accounts'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER trg_note_account_status_change AFTER UPDATE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION note_account_status_change()'; END IF; END $t$;
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_note_extension_request' AND tgrelid = 'public.extension_requests'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER trg_note_extension_request AFTER INSERT OR UPDATE ON public.extension_requests FOR EACH ROW EXECUTE FUNCTION note_extension_request()'; END IF; END $t$;
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_note_penalty_waiver' AND tgrelid = 'public.penalty_waiver_requests'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER trg_note_penalty_waiver AFTER INSERT OR UPDATE ON public.penalty_waiver_requests FOR EACH ROW EXECUTE FUNCTION note_penalty_waiver()'; END IF; END $t$;
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_revert_auto_waive' AND tgrelid = 'public.payment_submissions'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER trg_revert_auto_waive AFTER UPDATE ON public.payment_submissions FOR EACH ROW EXECUTE FUNCTION revert_auto_waive_on_rejection()'; END IF; END $t$;
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_message_lines_updated_at' AND tgrelid = 'public.message_lines'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER update_message_lines_updated_at BEFORE UPDATE ON public.message_lines FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()'; END IF; END $t$;
DO $t$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_product_reviews_updated_at' AND tgrelid = 'public.product_reviews'::regclass AND NOT tgisinternal) THEN EXECUTE 'CREATE TRIGGER update_product_reviews_updated_at BEFORE UPDATE ON public.product_reviews FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()'; END IF; END $t$;

-- 7. RLS policies (live's text exactly). Two loyalty_banners policies were renamed on live.
DROP POLICY IF EXISTS "Admin/finance can insert loyalty_banners" ON public.loyalty_banners;
DROP POLICY IF EXISTS "Admin/finance can update loyalty_banners" ON public.loyalty_banners;
DO $p$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'layaway_account_items' AND policyname = 'Customers can view own layaway account items') THEN EXECUTE 'CREATE POLICY "Customers can view own layaway account items" ON public.layaway_account_items AS PERMISSIVE FOR SELECT TO "authenticated" USING ((account_id IN ( SELECT la.id
   FROM layaway_accounts la
  WHERE (la.customer_id IN ( SELECT c.id
           FROM customers c
          WHERE (c.auth_user_id = ( SELECT auth.uid() AS uid)))))))'; END IF; END $p$;
DO $p$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'layaway_account_items' AND policyname = 'account_creators_insert_layaway_account_items') THEN EXECUTE 'CREATE POLICY "account_creators_insert_layaway_account_items" ON public.layaway_account_items AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK ((( SELECT has_role(( SELECT auth.uid() AS uid), ''staff''::app_role) AS has_role) OR ( SELECT has_role(( SELECT auth.uid() AS uid), ''admin''::app_role) AS has_role)))'; END IF; END $p$;
DO $p$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'layaway_account_items' AND policyname = 'staff_finance_read_layaway_account_items') THEN EXECUTE 'CREATE POLICY "staff_finance_read_layaway_account_items" ON public.layaway_account_items AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT has_role(( SELECT auth.uid() AS uid), ''staff''::app_role) AS has_role) OR ( SELECT has_role(( SELECT auth.uid() AS uid), ''finance''::app_role) AS has_role)))'; END IF; END $p$;
DO $p$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'loyalty_banners' AND policyname = 'Admin/finance/staff can insert loyalty_banners') THEN EXECUTE 'CREATE POLICY "Admin/finance/staff can insert loyalty_banners" ON public.loyalty_banners AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((( SELECT has_role(( SELECT auth.uid() AS uid), ''admin''::app_role) AS has_role) OR ( SELECT has_role(( SELECT auth.uid() AS uid), ''finance''::app_role) AS has_role) OR ( SELECT has_role(( SELECT auth.uid() AS uid), ''staff''::app_role) AS has_role)))'; END IF; END $p$;
DO $p$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'loyalty_banners' AND policyname = 'Admin/finance/staff can update loyalty_banners') THEN EXECUTE 'CREATE POLICY "Admin/finance/staff can update loyalty_banners" ON public.loyalty_banners AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((( SELECT has_role(( SELECT auth.uid() AS uid), ''admin''::app_role) AS has_role) OR ( SELECT has_role(( SELECT auth.uid() AS uid), ''finance''::app_role) AS has_role) OR ( SELECT has_role(( SELECT auth.uid() AS uid), ''staff''::app_role) AS has_role)))'; END IF; END $p$;

-- 8. Function grants: live's EXECUTE list, exactly (sandbox_exec* ignored).
-- pg_temp.cj_set_exec only acts when the current list differs.
CREATE OR REPLACE FUNCTION pg_temp.cj_set_exec(p_fn regprocedure, p_roles text[]) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_now text[]; r text;
BEGIN
  SELECT coalesce(array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END ORDER BY 1), '{}')
    INTO v_now
    FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE p.oid = p_fn AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
     AND (a.grantee = 0 OR a.grantee::regrole::text NOT LIKE 'sandbox_exec%');
  IF v_now IS DISTINCT FROM (SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM unnest(p_roles) x) THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', p_fn);
    FOREACH r IN ARRAY p_roles LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', p_fn, r);
    END LOOP;
  END IF;
END $f$;
SELECT pg_temp.cj_set_exec('public.address_snapshot(uuid)'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.admin_correct_birthday(uuid,date)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.admin_keep_allocation_override(uuid,numeric)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.audit_account(text)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.audit_all_accounts()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.audit_delete_cleanup_invariants()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.auto_backup_payment()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.auto_waive_same_day_penalties()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.campaign_no_layaway_in_ja()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.check_allocation_ceiling()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.check_duplicate_payment(uuid,numeric,date)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.consume_store_credit_for_shopify_atomic(uuid,account_currency,numeric,uuid,text,text)'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.deactivate_expired_promotions()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.delete_cash_order_atomic(uuid,uuid)'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.derive_cash_order_loyalty_jpy(uuid)'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.derive_order_loyalty_jpy(uuid)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.enforce_plan_minimum_amount()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_at_risk_accounts()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_at_risk_detail()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_cfo_insights()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_cohort_timeline()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_coverage_ratio()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_evaluate_alerts()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_gross_profit()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_monthly_inflow(date)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_net_exposure_risk(numeric)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_penalty_driven_accounts()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_penalty_revenue()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_plan_performance()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.fc_portfolio_value()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.generate_customer_code()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_aging_buckets(text)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_audit_filter_options()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_cash_orders_monthly()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_collection_analytics(text,integer)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_forecast_6m()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_forecast_drilldown(text)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_media_cutout_worker_state()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_monthly_analytics()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_monthly_sales(text,integer)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_monthly_tracking_export(integer,integer)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_recent_qualifying_order(uuid,integer)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_staff_performance(integer)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_top_outstanding_customers()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_tracking_for_invoices(text[])'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_trade_kpis()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.get_trade_monthly_trends(integer)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.handle_new_user()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.has_role(uuid,app_role)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.hero_cutout_source_ok(text)'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.hero_pick_reason(text,text,integer,integer,boolean)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.is_paid_or_completed_order(text,numeric,uuid,boolean)'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.is_staff(uuid)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.issue_store_credit_atomic(uuid,account_currency,numeric,text,uuid,uuid,uuid,text,text,text,text)'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.layaway_quote(integer,integer,text,date,integer,integer)'::regprocedure, ARRAY['PUBLIC', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.log_admin_table_change()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.log_schedule_deletion()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.loyalty_lots_set_updated_at()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.loyalty_members_set_updated_at()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.loyalty_transactions_guard_update()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.loyalty_transactions_no_update()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.media_cutout_wake_on_settings()'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.media_cutout_wake_on_work()'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.monthly_inflow_by_plan_6m()'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.next_reconciliation_batch(integer)'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.note_account_status_change()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.note_extension_request()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.note_loyalty_transaction()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.note_penalty_waiver()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_account_created()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_cash_order_created()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_customer_notified()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_deadline_label(timestamp with time zone)'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_extension_event()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_loyalty_enrolled()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_money_label(numeric,text)'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_submission_created()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_submission_reviewed()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_tier_changed()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.notify_waiver_event()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_base_amount_change()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_birthday_change()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_customer_code_change()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_paid_order_delete()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_paid_row_modification()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_payment_backup_modification()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_schedule_deletion()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_total_amount_change()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_web_layaway_delete()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.prevent_web_order_delete()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.redeem_store_credit_atomic(uuid,uuid,uuid,numeric,uuid,text,boolean)'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.rename_invoice_number_atomic(uuid,text,uuid)'::regprocedure, ARRAY['authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.revalidate_account_from_vault(text)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.revert_auto_waive_on_rejection()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.revoke_loyalty_points_partial(uuid,text,numeric,uuid,text,text,uuid)'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.set_account_deadlines(text,uuid,timestamp with time zone,text,uuid)'::regprocedure, ARRAY['service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.set_completed_at()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.sync_auth_email_to_customer()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.sync_web_order_payment_status()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.sync_website_product_metals()'::regprocedure, ARRAY['PUBLIC', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.update_cash_orders_updated_at()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.update_loyalty_members_updated_at()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.update_loyalty_promos_updated_at()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.update_updated_at()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.update_updated_at_column()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.validate_bulk_import(jsonb)'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.validate_schedule_chronology()'::regprocedure, ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']::text[]);
SELECT pg_temp.cj_set_exec('public.void_store_credit_lot_atomic(uuid,text,uuid,text)'::regprocedure, ARRAY['service_role']::text[]);
DROP FUNCTION pg_temp.cj_set_exec(regprocedure, text[]);

-- 9. Table grants that differ (live is tighter than the default the repo leaves).
-- Guarded on anon's access, so on live — where anon already has none — nothing runs
-- (and PG17's MAINTAIN grant on live is never touched).
DO $g$ BEGIN
  IF has_table_privilege('anon', 'public.customer_pins', 'SELECT') THEN
    REVOKE ALL ON public.customer_pins FROM anon, authenticated;
  END IF;
  IF has_table_privilege('anon', 'public.schedule_with_actuals', 'SELECT') THEN
    REVOKE ALL ON public.schedule_with_actuals FROM anon, authenticated;
    GRANT SELECT ON public.schedule_with_actuals TO authenticated;
  END IF;
END $g$;
