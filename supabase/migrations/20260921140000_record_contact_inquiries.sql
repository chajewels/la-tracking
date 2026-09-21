-- RECORD-ONLY. Captured 2026-09-21.
--
-- The owner created public.contact_inquiries in the SQL Editor. Committed here
-- for the reason CLAUDE.md gives under "A SQL EDITOR CHANGE THAT IS NEVER
-- COMMITTED IS INVISIBLE TO EVERY LATER REBUILD" — a rebuild from the baseline
-- would come back without the table, and the Hub's Audience tab would break on
-- a card that queries a table that does not exist.
--
-- Replaying against live is a no-op: IF NOT EXISTS on the table and the index,
-- DROP POLICY IF EXISTS ahead of each CREATE POLICY. The index was unnamed as
-- run, so it is named here with the name Postgres generated for it
-- (contact_inquiries_status_created_at_idx) — same index, now replayable.
-- Nothing else differs from what was run.
--
-- NO updated_at TRIGGER, deliberately recorded as such: every other website_*
-- table has trg_<t>_updated_at running public.update_updated_at_column(), and
-- this table does not. Until one exists, updated_at only ever holds the insert
-- time unless the writer sets it — so ContactInquiriesCard's triage sets it
-- explicitly. See docs/WEBSITE-WORKSPACE.md §6.

CREATE TABLE IF NOT EXISTS public.contact_inquiries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    text NOT NULL,
  email        text NOT NULL,
  phone        text,
  message      text NOT NULL,
  lang         text NOT NULL DEFAULT 'en' CHECK (lang IN ('en','ja')),
  page         text,
  -- Nullable, and ON DELETE SET NULL: most people who use the contact form are
  -- not Hub customers, and deleting a customer must not delete what they wrote.
  customer_id  uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new','replied','closed')),
  staff_note   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The Audience tab reads newest-first and triages by status.
CREATE INDEX IF NOT EXISTS contact_inquiries_status_created_at_idx
  ON public.contact_inquiries (status, created_at DESC);

ALTER TABLE public.contact_inquiries ENABLE ROW LEVEL SECURITY;

-- Staff read and triage everything.
DROP POLICY IF EXISTS "Staff can view contact inquiries" ON public.contact_inquiries;
CREATE POLICY "Staff can view contact inquiries"   ON public.contact_inquiries
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Staff can manage contact inquiries" ON public.contact_inquiries;
CREATE POLICY "Staff can manage contact inquiries" ON public.contact_inquiries
  FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- A catalog manager who is not staff can read and TRIAGE, but not insert or
-- delete: the rows are the public's words, written by the `website` edge
-- function, and the Hub's job on them is to record what happened, not to
-- author or destroy them.
DROP POLICY IF EXISTS "Website catalog managers can view contact inquiries" ON public.contact_inquiries;
CREATE POLICY "Website catalog managers can view contact inquiries" ON public.contact_inquiries
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'));

DROP POLICY IF EXISTS "Website catalog managers can update contact inquiries" ON public.contact_inquiries;
CREATE POLICY "Website catalog managers can update contact inquiries" ON public.contact_inquiries
  FOR UPDATE TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_catalog'));
