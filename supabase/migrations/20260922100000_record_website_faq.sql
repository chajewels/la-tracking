-- RECORD-ONLY. Captured 2026-09-22.
--
-- The owner created public.website_faq_sections and public.website_faq_items in
-- the SQL Editor. Committed here for the reason CLAUDE.md gives under "A SQL
-- EDITOR CHANGE THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD":
-- a rebuild from the baseline would come back without either table, and the
-- Website → Content tab would query tables that do not exist.
--
-- Replaying against live is a no-op: IF NOT EXISTS on both tables and the
-- index, and DROP POLICY / DROP TRIGGER IF EXISTS ahead of each CREATE. The
-- triggers as run carried NO drop guard and the index was unnamed, so those
-- two guards plus the index's generated name are the only differences from
-- what was executed.
--
-- NOT RECORDED, on the owner's instruction: the revalidation triggers on both
-- tables, which are Lovable's. The updated_at triggers ARE ours — the same
-- division as website_settings and website_posts.

CREATE TABLE IF NOT EXISTS public.website_faq_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The section's anchor on the FAQ page. UNIQUE because two sections sharing
  -- an anchor means one of them is unreachable by link.
  slug        text NOT NULL UNIQUE,
  title_en    text NOT NULL,
  title_ja    text,
  sort_order  integer NOT NULL DEFAULT 100,
  -- Note the default: TRUE. A section is visible the moment it exists, unlike
  -- a post, which starts as a draft.
  published   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

CREATE TABLE IF NOT EXISTS public.website_faq_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE. Deleting a section takes every answer in it, silently,
  -- at the database. The Hub refuses to delete a section that still has items
  -- (sectionDeleteBlocker in website-faq.ts) precisely because this cascade
  -- would not: the guard is the only thing between a mis-click and a page of
  -- published layaway and loyalty terms.
  section_id   uuid NOT NULL REFERENCES public.website_faq_sections(id) ON DELETE CASCADE,
  question_en  text NOT NULL,
  question_ja  text,
  answer_en    text NOT NULL,
  answer_ja    text,
  -- Shown on the English site only.
  layaway_only boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 100,
  published    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid
);

-- The storefront's query and the Hub's: a section's questions, in order.
CREATE INDEX IF NOT EXISTS website_faq_items_section_id_sort_order_idx
  ON public.website_faq_items (section_id, sort_order);

ALTER TABLE public.website_faq_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_faq_items    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view faq sections" ON public.website_faq_sections;
CREATE POLICY "Staff can view faq sections" ON public.website_faq_sections
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Content managers can manage faq sections" ON public.website_faq_sections;
CREATE POLICY "Content managers can manage faq sections" ON public.website_faq_sections
  FOR ALL TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_content'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_content'));

DROP POLICY IF EXISTS "Staff can view faq items" ON public.website_faq_items;
CREATE POLICY "Staff can view faq items" ON public.website_faq_items
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Content managers can manage faq items" ON public.website_faq_items;
CREATE POLICY "Content managers can manage faq items" ON public.website_faq_items
  FOR ALL TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_content'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_content'));

DROP TRIGGER IF EXISTS trg_faq_sections_updated_at ON public.website_faq_sections;
CREATE TRIGGER trg_faq_sections_updated_at BEFORE UPDATE ON public.website_faq_sections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_faq_items_updated_at ON public.website_faq_items;
CREATE TRIGGER trg_faq_items_updated_at BEFORE UPDATE ON public.website_faq_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
