CREATE TABLE public.wholesale_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  business text NOT NULL,
  email text NOT NULL,
  phone text,
  market text NOT NULL,
  volume text NOT NULL,
  notes text,
  lang text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wholesale_inquiries TO authenticated;
GRANT ALL ON public.wholesale_inquiries TO service_role;

ALTER TABLE public.wholesale_inquiries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Website catalog managers can view wholesale inquiries"
ON public.wholesale_inquiries
FOR SELECT
TO authenticated
USING (public.has_permission(auth.uid(), 'manage_website_catalog'));

CREATE INDEX idx_wholesale_inquiries_created_at ON public.wholesale_inquiries (created_at DESC);