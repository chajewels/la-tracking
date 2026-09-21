-- RECORD-ONLY. Captured 2026-09-21.
--
-- The owner ran this ALTER TABLE in the SQL Editor. It is committed here for
-- the reason CLAUDE.md gives under "A SQL EDITOR CHANGE THAT IS NEVER
-- COMMITTED IS INVISIBLE TO EVERY LATER REBUILD": the SQL Editor is a
-- sanctioned write path that leaves no trace in supabase/migrations, so a
-- later rebuild from the baseline would drop the column and take the Hub's
-- editor and the storefront's date with it.
--
-- Replaying this is a no-op against live — IF NOT EXISTS — which is what a
-- record-only migration is for. It adds nothing and changes nothing; it only
-- means the repo now knows what live already has.
--
-- Nullable on purpose: every testimonial written before today has no date,
-- and inventing one would be putting a month in a customer's mouth. The Hub's
-- editor writes NULL for an empty box and the row header shows an em dash.
ALTER TABLE public.website_testimonials
  ADD COLUMN IF NOT EXISTS testimonial_date date;
