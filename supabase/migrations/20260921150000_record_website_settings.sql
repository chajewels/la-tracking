-- RECORD-ONLY. Captured 2026-09-21.
--
-- The owner created public.website_settings and seeded it in the SQL Editor.
-- Committed here for the reason CLAUDE.md gives under "A SQL EDITOR CHANGE
-- THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD": a rebuild from
-- the baseline would come back without the table, and the Website → Settings
-- tab would query a table that does not exist. The SEED matters as much as the
-- DDL — an empty website_settings is not a broken site, it is a site with no
-- contact address and no footer links, which is worse because it looks fine.
--
-- Replaying against live is a no-op: IF NOT EXISTS on the table, DROP POLICY
-- IF EXISTS ahead of each CREATE POLICY (the trigger already had its own DROP),
-- and ON CONFLICT DO NOTHING on the seed so it never overwrites copy that has
-- been edited since. Those guards are the only difference from what was run.
--
-- NOT RECORDED, on the owner's instruction: the notify_website_revalidate()
-- extension and the revalidate trigger on this table. Both were applied by
-- Lovable's own migration and belong to it, not here.

CREATE TABLE IF NOT EXISTS public.website_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  -- The five shapes the Hub's editor knows how to render. A key whose kind is
  -- outside this set cannot be written, which is what stops the table drifting
  -- into a free-form JSON dumping ground.
  kind       text NOT NULL CHECK (kind IN ('text','bilingual','json','bool','date')),
  public     boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Plain uuid, no FK: this records WHO last touched a setting, and that fact
  -- must outlive the staff account being removed.
  updated_by uuid
);

ALTER TABLE public.website_settings ENABLE ROW LEVEL SECURITY;

-- Any staff member may read what the site currently says...
DROP POLICY IF EXISTS "Staff can view website settings" ON public.website_settings;
CREATE POLICY "Staff can view website settings"   ON public.website_settings
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- ...and only a content manager may change it. This is the server half of the
-- SettingsCard's canManage guard: the card goes read-only without the key, and
-- this refuses the write independently, so a read-only card is never the only
-- thing stopping an edit.
DROP POLICY IF EXISTS "Content managers can manage website settings" ON public.website_settings;
CREATE POLICY "Content managers can manage website settings" ON public.website_settings
  FOR ALL TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_content'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_content'));

DROP TRIGGER IF EXISTS trg_website_settings_updated_at ON public.website_settings;
CREATE TRIGGER trg_website_settings_updated_at BEFORE UPDATE ON public.website_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The eight keys the Settings tab manages, with the copy the site shipped with.
-- ON CONFLICT DO NOTHING: replaying this must never overwrite edits made since.
INSERT INTO public.website_settings (key, value, kind) VALUES
 ('social.follow', '[{"key":"email","href":"mailto:sales@chajewelsjp.com"},{"key":"facebook","href":"https://www.facebook.com/chajewelsjapan"},{"key":"messenger","href":"https://m.me/chajewelsjapan"}]', 'json'),
 ('social.loyalty_groups', '[{"key":"whatsapp","href":"https://chat.whatsapp.com/ENdMNvF8N3jB3iG963f6EF"},{"key":"line","href":"https://line.me/ti/g/5fb8KyBCCJ"},{"key":"messenger","href":"https://m.me/ch/AbYF1EaEkypQc5Jk/?send_source=cm:copy_invite_link"}]', 'json'),
 ('contact.email', '"sales@chajewelsjp.com"', 'text'),
 ('footer.tagline', '{"en":"Fine gold, pearl and diamond jewelry. Made in Japan.","ja":"上質なゴールド・パール・ダイヤモンドジュエリー。日本製。"}', 'bilingual'),
 ('announcement.active', 'false', 'bool'),
 ('announcement.text', '{"en":"","ja":""}', 'bilingual'),
 ('announcement.href', '""', 'text'),
 ('announcement.until', 'null', 'date')
ON CONFLICT (key) DO NOTHING;
