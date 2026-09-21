-- RECORD-ONLY. Captured 2026-09-22.
--
-- The owner created public.website_posts in the SQL Editor. Committed here for
-- the reason CLAUDE.md gives under "A SQL EDITOR CHANGE THAT IS NEVER
-- COMMITTED IS INVISIBLE TO EVERY LATER REBUILD": a rebuild from the baseline
-- would come back without the table, and the Website → Content tab would query
-- a table that does not exist.
--
-- Replaying against live is a no-op: IF NOT EXISTS on the table and the index,
-- DROP POLICY IF EXISTS ahead of each CREATE POLICY (the trigger already
-- carried its own DROP). The index was unnamed as run, so it is named here
-- with the name Postgres generated for it. That is the whole difference from
-- what was executed.
--
-- NOT RECORDED, on the owner's instruction: the revalidation trigger on this
-- table, which is Lovable's. The updated_at trigger below IS ours to record —
-- same division as website_settings in 20260921150000.
--
-- No seed: the site ships with no posts, and an invented one would appear on
-- chajewelsjp.com as though someone had written it.

CREATE TABLE IF NOT EXISTS public.website_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The post's address on the website. UNIQUE is load-bearing: two posts with
  -- one slug is one unreachable post.
  slug          text NOT NULL UNIQUE,
  type          text NOT NULL DEFAULT 'article' CHECK (type IN ('article','news')),
  -- English is the source language; the Japanese columns are nullable because
  -- a post is written and published before it is translated.
  title_en      text NOT NULL,
  title_ja      text,
  excerpt_en    text,
  excerpt_ja    text,
  body_en       text NOT NULL,
  body_ja       text,
  cover_media   text,
  published     boolean NOT NULL DEFAULT false,
  published_at  date,
  layaway_only  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Plain uuid, no FK: who last touched a post must outlive the staff account.
  updated_by    uuid
);

-- The storefront's query: published posts of a type, newest first.
CREATE INDEX IF NOT EXISTS website_posts_published_type_published_at_idx
  ON public.website_posts (published, type, published_at DESC);

ALTER TABLE public.website_posts ENABLE ROW LEVEL SECURITY;

-- Any staff member may read what has been written...
DROP POLICY IF EXISTS "Staff can view website posts" ON public.website_posts;
CREATE POLICY "Staff can view website posts"   ON public.website_posts
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- ...and only a content manager may write it. Server half of PostsCard's
-- canManage guard: the card goes read-only without the key, and this refuses
-- the write independently, so a read-only card is never the only thing
-- stopping an edit.
DROP POLICY IF EXISTS "Content managers can manage website posts" ON public.website_posts;
CREATE POLICY "Content managers can manage website posts" ON public.website_posts
  FOR ALL TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_content'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_content'));

DROP TRIGGER IF EXISTS trg_website_posts_updated_at ON public.website_posts;
CREATE TRIGGER trg_website_posts_updated_at BEFORE UPDATE ON public.website_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
