-- RECORD-ONLY. Captured 2026-09-21.
--
-- The owner ran this in the SQL Editor. It is committed here for the reason
-- CLAUDE.md gives under "A SQL EDITOR CHANGE THAT IS NEVER COMMITTED IS
-- INVISIBLE TO EVERY LATER REBUILD": the SQL Editor is a sanctioned write path
-- that leaves no trace in supabase/migrations, so a rebuild from the baseline
-- would come back with neither permission key and none of these policies —
-- and the Website workspace would be admin-only with no way to grant it.
--
-- Replaying this against live is a no-op. The seed already had ON CONFLICT DO
-- NOTHING; the three policies gained a DROP POLICY IF EXISTS ahead of each
-- CREATE, which is the only change from what was run and is what makes a
-- replay safe. Nothing else was altered.

-- Both keys, for every role, but ALLOWED only for admin. The other four roles
-- get an explicit false row rather than no row, so the Settings › Matrix
-- toggle has something to flip — an absent row reads as false but cannot be
-- turned on from the matrix.
INSERT INTO public.role_permissions (role, permission_key, is_allowed)
SELECT r.role, k.key, (r.role = 'admin')
FROM (VALUES ('admin'::app_role), ('staff'), ('finance'), ('csr'), ('live_agent')) AS r(role)
CROSS JOIN (VALUES ('manage_website_catalog'), ('manage_website_content')) AS k(key)
ON CONFLICT (role, permission_key) DO NOTHING;

-- The catalog key governs the shop's two taxonomies...
DROP POLICY IF EXISTS "Catalog managers can manage website collections" ON public.website_collections;
CREATE POLICY "Catalog managers can manage website collections" ON public.website_collections
  FOR ALL TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_catalog'));

DROP POLICY IF EXISTS "Catalog managers can manage website categories" ON public.website_categories;
CREATE POLICY "Catalog managers can manage website categories" ON public.website_categories
  FOR ALL TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_catalog'));

-- ...and the content key governs the words on the site. This is the server
-- half of the split the Hub shows: the UI hides what you cannot do, and these
-- decide it independently, so hiding a button is never the only thing
-- stopping a write.
DROP POLICY IF EXISTS "Content managers can manage website testimonials" ON public.website_testimonials;
CREATE POLICY "Content managers can manage website testimonials" ON public.website_testimonials
  FOR ALL TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_content'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_content'));
