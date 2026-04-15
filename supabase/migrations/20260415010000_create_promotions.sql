-- Promotions / ads feature
-- Admin & staff manage promos via /promotions page.
-- Customer portal (public, token-based) displays active promos in a banner
-- carousel, so SELECT on active rows must be open to anon.

CREATE TABLE IF NOT EXISTS public.promotions (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text         NOT NULL,
  description    text,
  media_url      text,
  media_type     text         CHECK (media_type IN ('image', 'video')),
  link_url       text,
  is_active      boolean      NOT NULL DEFAULT true,
  display_order  integer      NOT NULL DEFAULT 0,
  created_by     uuid         REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promotions_active_order_idx
  ON public.promotions (is_active, display_order);

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

-- Public (anonymous) read of active promos — required by the unauthenticated
-- customer portal banner.
DROP POLICY IF EXISTS "Public read active promotions" ON public.promotions;
CREATE POLICY "Public read active promotions"
  ON public.promotions
  FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

-- Admin & staff full read (includes inactive rows for the manager page).
DROP POLICY IF EXISTS "Admin and staff read all promotions" ON public.promotions;
CREATE POLICY "Admin and staff read all promotions"
  ON public.promotions
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- Admin & staff write.
DROP POLICY IF EXISTS "Admin and staff insert promotions" ON public.promotions;
CREATE POLICY "Admin and staff insert promotions"
  ON public.promotions
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

DROP POLICY IF EXISTS "Admin and staff update promotions" ON public.promotions;
CREATE POLICY "Admin and staff update promotions"
  ON public.promotions
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

DROP POLICY IF EXISTS "Admin and staff delete promotions" ON public.promotions;
CREATE POLICY "Admin and staff delete promotions"
  ON public.promotions
  FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_promotions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promotions_updated_at ON public.promotions;
CREATE TRIGGER trg_promotions_updated_at
  BEFORE UPDATE ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION public.update_promotions_updated_at();

-- Seed manage_promotions permission for admin & staff (idempotent)
INSERT INTO public.role_permissions (role, permission_key, is_allowed)
VALUES
  ('admin', 'manage_promotions', true),
  ('staff', 'manage_promotions', true),
  ('finance', 'manage_promotions', false),
  ('csr', 'manage_promotions', false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- Storage bucket for promo media (public — served directly to portal)
INSERT INTO storage.buckets (id, name, public)
VALUES ('promotions', 'promotions', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Public read of promo media
DROP POLICY IF EXISTS "Public read promo media" ON storage.objects;
CREATE POLICY "Public read promo media"
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'promotions');

-- Admin & staff upload
DROP POLICY IF EXISTS "Admin and staff upload promo media" ON storage.objects;
CREATE POLICY "Admin and staff upload promo media"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'promotions'
    AND (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  );

DROP POLICY IF EXISTS "Admin and staff update promo media" ON storage.objects;
CREATE POLICY "Admin and staff update promo media"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'promotions'
    AND (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  );

DROP POLICY IF EXISTS "Admin and staff delete promo media" ON storage.objects;
CREATE POLICY "Admin and staff delete promo media"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'promotions'
    AND (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  );
