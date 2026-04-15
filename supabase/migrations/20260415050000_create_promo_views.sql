-- Track promo impressions from the customer portal.
-- One row per (promo × assigned category) view event. If the promo has no
-- assigned categories, a single row is written with category_id = NULL.
-- De-duplication to once-per-promo-per-session happens client-side.

CREATE TABLE IF NOT EXISTS public.promo_views (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id        uuid         NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  category_id     uuid         REFERENCES public.promo_categories(id) ON DELETE SET NULL,
  customer_id     uuid         REFERENCES public.customers(id) ON DELETE SET NULL,
  invoice_number  text,
  viewed_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promo_views_promo_id_idx
  ON public.promo_views (promo_id);
CREATE INDEX IF NOT EXISTS promo_views_promo_category_idx
  ON public.promo_views (promo_id, category_id);
CREATE INDEX IF NOT EXISTS promo_views_customer_idx
  ON public.promo_views (customer_id);

ALTER TABLE public.promo_views ENABLE ROW LEVEL SECURITY;

-- Public (anonymous) INSERT — the customer portal is unauthenticated and
-- writes views directly from the client.
DROP POLICY IF EXISTS "Public insert promo views" ON public.promo_views;
CREATE POLICY "Public insert promo views"
  ON public.promo_views
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Admin & staff SELECT (for the admin Promotions view stats).
DROP POLICY IF EXISTS "Admin and staff read promo views" ON public.promo_views;
CREATE POLICY "Admin and staff read promo views"
  ON public.promo_views
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));
