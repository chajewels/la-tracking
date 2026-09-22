-- RECORD-ONLY. Captured 2026-09-22.
--
-- The owner created these two tables and the layaway trigger in the SQL
-- Editor. Committed here for the reason CLAUDE.md gives under "A SQL EDITOR
-- CHANGE THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD": a
-- rebuild from the baseline would come back without them, and Website →
-- Audience would query tables that do not exist.
--
-- Replaying against live is a no-op: IF NOT EXISTS on both tables and the
-- index, DROP POLICY / DROP TRIGGER IF EXISTS ahead of each CREATE, and the
-- index named with the name Postgres generated for the unnamed one as run.
-- CREATE OR REPLACE FUNCTION was already replay-safe. Those guards are the
-- only differences from what was executed.
--
-- NOT RECORDED, on the owner's instruction: the edge functions campaign-queue,
-- process-newsletter-campaigns and campaign-cancel, and their cron. All are
-- Lovable's. The Hub only composes and queues — nothing in src/ sends mail.

CREATE TABLE IF NOT EXISTS public.newsletter_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- All four are nullable so a campaign can be one language only. The CHECK at
  -- the bottom is what stops it being NO language.
  subject_en text, subject_ja text, body_en text, body_ja text,
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','en','ja')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sending','sent','cancelled')),
  product_ids uuid[] NOT NULL DEFAULT '{}', post_slug text,
  queued_at timestamptz, sent_at timestamptz,
  -- Written by the queue worker, never by the Hub.
  total integer NOT NULL DEFAULT 0, sent_count integer NOT NULL DEFAULT 0, failed_count integer NOT NULL DEFAULT 0,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (subject_en IS NOT NULL OR subject_ja IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.newsletter_campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES public.newsletter_campaigns(id) ON DELETE CASCADE,
  subscriber_id uuid NOT NULL REFERENCES public.newsletter_subscribers(id) ON DELETE CASCADE,
  lang text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error text, sent_at timestamptz,
  -- The composite PK is the idempotence guard: the worker cannot enqueue the
  -- same subscriber twice for one campaign, whatever it retries.
  PRIMARY KEY (campaign_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS newsletter_campaign_recipients_status_campaign_id_idx
  ON public.newsletter_campaign_recipients (status, campaign_id);

ALTER TABLE public.newsletter_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_campaign_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view campaigns" ON public.newsletter_campaigns;
CREATE POLICY "Staff can view campaigns" ON public.newsletter_campaigns
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS "Content managers can manage campaigns" ON public.newsletter_campaigns;
CREATE POLICY "Content managers can manage campaigns" ON public.newsletter_campaigns
  FOR ALL TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_content'))
  WITH CHECK (public.has_permission(auth.uid(), 'manage_website_content'));

-- NOTE: recipients are SELECT-only for staff and have NO write policy at all.
-- Those rows belong to the queue worker, which runs as service role and
-- bypasses RLS. Nothing in the Hub inserts or updates them, and nothing should.
DROP POLICY IF EXISTS "Staff can view campaign recipients" ON public.newsletter_campaign_recipients;
CREATE POLICY "Staff can view campaign recipients" ON public.newsletter_campaign_recipients
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON public.newsletter_campaigns;
CREATE TRIGGER trg_campaigns_updated_at BEFORE UPDATE ON public.newsletter_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Layaway is an English-market product and is not offered in Japanese. This
-- refuses the WRITE rather than filtering at send time, so a campaign that
-- would breach it cannot be saved, let alone queued.
--
-- It RAISEs without an ERRCODE, so it surfaces as SQLSTATE P0001 — the generic
-- code every other RAISE in this schema shares. The Hub therefore identifies
-- it by MESSAGE (isLayawayError in newsletter-campaigns.ts). Changing the
-- wording below without changing that matcher turns the friendly inline hint
-- back into a raw database exception.
CREATE OR REPLACE FUNCTION public.campaign_no_layaway_in_ja()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF concat_ws(' ', NEW.subject_ja, NEW.body_ja) ILIKE '%layaway%'
     OR concat_ws(' ', NEW.subject_ja, NEW.body_ja) LIKE '%レイアウェイ%' THEN
    RAISE EXCEPTION 'Layaway is English-only: remove it from the Japanese version or send this campaign in English only';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_campaigns_layaway_en ON public.newsletter_campaigns;
CREATE TRIGGER trg_campaigns_layaway_en BEFORE INSERT OR UPDATE ON public.newsletter_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.campaign_no_layaway_in_ja();
