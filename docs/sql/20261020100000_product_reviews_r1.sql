-- STAGED MIGRATION — NOT APPLIED. Intended path on apply:
--   supabase/migrations/20261020100000_product_reviews_r1.sql
-- (Lovable cannot write into supabase/migrations/ without applying; the file is
-- staged here verbatim so it can be applied after owner approval.)
--
-- Product reviews, Hub side (PR-R1). Owner-approved plan 2026-09-30 19:08 JST.
--
-- A review belongs to an ORDER (cash order or layaway account). Staff create a
-- personal one-order review link from a COMPLETED order and send it on
-- Messenger; the link itself proves the purchase. Only the sha256 hex of the
-- token is stored — never the raw token.
--
-- Nothing is public until the owner approves (status 'approved'). Photos live
-- in the PRIVATE bucket review-uploads until approval copies them to the
-- PUBLIC bucket review-photos. Customer writes go through the `website` edge
-- function (service role); staff actions go through RLS below.
--
-- Also: message_lines, the foundation for the random Copy Message lines work.
-- For now only 'review_invite' uses it.

-- ── review_invites ──────────────────────────────────────────────────────────
CREATE TABLE public.review_invites (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES public.customers(id),
  cash_order_id      uuid NULL REFERENCES public.cash_orders(id),
  layaway_account_id uuid NULL REFERENCES public.layaway_accounts(id),
  website_product_id uuid NULL REFERENCES public.website_products(id) ON DELETE SET NULL,
  piece_name         text NOT NULL CHECK (char_length(btrim(piece_name)) BETWEEN 1 AND 200),
  token_hash         text NOT NULL UNIQUE,
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz NULL,
  revoked_at         timestamptz NULL,
  created_by         uuid NULL REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_invites_one_order CHECK (num_nonnulls(cash_order_id, layaway_account_id) = 1)
);

-- One open invite per order.
CREATE UNIQUE INDEX uq_review_invites_open_per_order
  ON public.review_invites ((COALESCE(cash_order_id, layaway_account_id)))
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_review_invites_cash_order ON public.review_invites (cash_order_id);
CREATE INDEX idx_review_invites_layaway ON public.review_invites (layaway_account_id);

GRANT SELECT, INSERT, UPDATE ON public.review_invites TO authenticated;
GRANT ALL ON public.review_invites TO service_role;
ALTER TABLE public.review_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view review invites" ON public.review_invites
  FOR SELECT TO authenticated
  USING ((SELECT is_staff((SELECT auth.uid()))));
CREATE POLICY "Invite senders can create review invites" ON public.review_invites
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT has_permission((SELECT auth.uid()), 'send_review_invite'))
              AND created_by = (SELECT auth.uid()));
-- Staff only ever revoke (revoked_at); used_at is written by the website function.
CREATE POLICY "Invite senders can revoke review invites" ON public.review_invites
  FOR UPDATE TO authenticated
  USING ((SELECT has_permission((SELECT auth.uid()), 'send_review_invite')))
  WITH CHECK ((SELECT has_permission((SELECT auth.uid()), 'send_review_invite')));

-- ── product_reviews ─────────────────────────────────────────────────────────
CREATE TABLE public.product_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id          uuid NOT NULL UNIQUE REFERENCES public.review_invites(id),
  customer_id        uuid NOT NULL REFERENCES public.customers(id),
  cash_order_id      uuid NULL,
  layaway_account_id uuid NULL,
  website_product_id uuid NULL REFERENCES public.website_products(id) ON DELETE SET NULL,
  piece_name         text NOT NULL,
  rating             smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body_original      text NOT NULL CHECK (char_length(body_original) BETWEEN 10 AND 2000),
  original_language  text NULL CHECK (original_language IN ('en', 'ja', 'tl', 'mixed')),
  body_en            text NULL,
  body_ja            text NULL,
  display_name       text NOT NULL,
  upload_paths       text[] NOT NULL DEFAULT '{}',
  photo_urls         text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  reject_reason      text NULL,
  reviewed_by        uuid NULL,
  reviewed_at        timestamptz NULL,
  submitted_ip_hash  text NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_reviews_status_reviewed ON public.product_reviews (status, reviewed_at DESC);
CREATE INDEX idx_product_reviews_product_approved ON public.product_reviews (website_product_id)
  WHERE status = 'approved';

GRANT SELECT, UPDATE ON public.product_reviews TO authenticated;
GRANT ALL ON public.product_reviews TO service_role;
ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view product reviews" ON public.product_reviews
  FOR SELECT TO authenticated
  USING ((SELECT is_staff((SELECT auth.uid()))));
CREATE POLICY "Moderators can update product reviews" ON public.product_reviews
  FOR UPDATE TO authenticated
  USING ((SELECT has_permission((SELECT auth.uid()), 'moderate_reviews')))
  WITH CHECK ((SELECT has_permission((SELECT auth.uid()), 'moderate_reviews')));

CREATE TRIGGER update_product_reviews_updated_at
  BEFORE UPDATE ON public.product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── message_lines ───────────────────────────────────────────────────────────
CREATE TABLE public.message_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_type text NOT NULL,
  part         text NOT NULL CHECK (part IN ('opening', 'closing', 'full')),
  body         text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  sort         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_lines_type ON public.message_lines (message_type, part) WHERE active;

GRANT SELECT, UPDATE ON public.message_lines TO authenticated;
GRANT ALL ON public.message_lines TO service_role;
ALTER TABLE public.message_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view message lines" ON public.message_lines
  FOR SELECT TO authenticated
  USING ((SELECT is_staff((SELECT auth.uid()))));
CREATE POLICY "Admins can update message lines" ON public.message_lines
  FOR UPDATE TO authenticated
  USING ((SELECT has_role((SELECT auth.uid()), 'admin'::app_role)))
  WITH CHECK ((SELECT has_role((SELECT auth.uid()), 'admin'::app_role)));

CREATE TRIGGER update_message_lines_updated_at
  BEFORE UPDATE ON public.message_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Eight review-invite lines. Each carries {first_name}, {piece} and {link}
-- exactly once. No prices, no pressure.
INSERT INTO public.message_lines (message_type, part, body, sort) VALUES
  ('review_invite', 'full', 'Hi {first_name}! 💛 Salamat po sa pagtitiwala sa Cha Jewels. Kumusta ang {piece} mo? We''d love to hear your thoughts — pa-review naman po dito: {link} ✨', 1),
  ('review_invite', 'full', 'Hello {first_name}! ✨ Thank you so much for choosing Cha Jewels. We hope you''re loving your {piece}! If you have a minute, you can share a quick review here: {link} 💛', 2),
  ('review_invite', 'full', 'Hi {first_name}, maraming salamat po! 🧡 Sana nag-eenjoy ka sa {piece} mo. Your feedback means a lot to us — pwede po kayong mag-iwan ng review dito: {link}', 3),
  ('review_invite', 'full', 'Good day {first_name}! 💎 Thank you for your trust in Cha Jewels. How''s your {piece} so far? Share your experience with us here, whenever you''re free: {link} 😊', 4),
  ('review_invite', 'full', 'Hi {first_name}! 🌸 Salamat ulit sa order mo. We''re curious — how do you like your {piece}? A short review would make our day: {link} 💛', 5),
  ('review_invite', 'full', 'Hello po {first_name}! ✨ Thank you for being part of the Cha Jewels family. Kamusta po ang {piece}? Kung okay lang, pa-share naman po ng review: {link} 🧡', 6),
  ('review_invite', 'full', 'Hi {first_name}, thank you so much for shopping with us! 💛 We hope your {piece} brings you joy every day. Tell us what you think here: {link} ✨', 7),
  ('review_invite', 'full', 'Hey {first_name}! 😊 Salamat sa pagpili sa Cha Jewels. Enjoying your {piece}? We''d be so happy to read your review — dito po: {link} 💎', 8);

-- ── Storage buckets ─────────────────────────────────────────────────────────
-- review-uploads: PRIVATE (customer photos before approval). No public policy.
-- review-photos:  PUBLIC  (copies of approved photos only).
-- NOTE: on Lovable Cloud buckets are created with the storage tool, not SQL;
-- if this INSERT is refused, create both buckets with these exact settings
-- and apply the rest unchanged.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('review-uploads', 'review-uploads', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp']),
  ('review-photos',  'review-photos',  true,  5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

-- Moderators read the private uploads (signed URLs) and copy / remove the
-- public copies. Customer uploads come through the website function (service role).
CREATE POLICY "Moderators can read review uploads" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'review-uploads'
         AND (SELECT has_permission((SELECT auth.uid()), 'moderate_reviews')));
CREATE POLICY "Moderators can add review photos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'review-photos'
              AND (SELECT has_permission((SELECT auth.uid()), 'moderate_reviews')));
CREATE POLICY "Moderators can replace review photos" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'review-photos'
         AND (SELECT has_permission((SELECT auth.uid()), 'moderate_reviews')));
CREATE POLICY "Moderators can remove review photos" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'review-photos'
         AND (SELECT has_permission((SELECT auth.uid()), 'moderate_reviews')));

-- ── Permissions ─────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
  ('admin'::app_role,      'send_review_invite', true),
  ('staff'::app_role,      'send_review_invite', true),
  ('csr'::app_role,        'send_review_invite', true),
  ('finance'::app_role,    'send_review_invite', false),
  ('live_agent'::app_role, 'send_review_invite', false),
  ('admin'::app_role,      'moderate_reviews', true),
  ('staff'::app_role,      'moderate_reviews', false),
  ('csr'::app_role,        'moderate_reviews', false),
  ('finance'::app_role,    'moderate_reviews', false),
  ('live_agent'::app_role, 'moderate_reviews', false)
ON CONFLICT (role, permission_key) DO NOTHING;
