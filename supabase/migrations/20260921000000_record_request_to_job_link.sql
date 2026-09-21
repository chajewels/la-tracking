-- RECORD-ONLY MIGRATION — request → job link
--
-- Captured: 2026-09-21. Reason: the owner applied this in the SQL Editor, which
-- is a sanctioned write path that leaves no trace in supabase/migrations/. Per
-- CLAUDE.md ("A SQL EDITOR CHANGE THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY
-- LATER REBUILD"), a change to a FUNCTION BODY is committed as a migration in
-- the same session so the next rebuild from the baseline does not silently
-- revert it.
--
-- This file RECORDS live; it does not change it. Replaying it against the live
-- project is a no-op, and per the Migrations baseline rule the repo is never
-- pushed to live. Its purpose is faithful fresh rebuilds (local dev, staging).
--
-- Before editing trg_sync_service_request_from_job, diff against LIVE, never
-- against this file:
--   SELECT pg_get_functiondef(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'sync_service_request_from_job';

-- 1. service_type gains 'Appraisal'.
--    Guarded so a rebuild that already has it is a no-op. ALTER TYPE ... ADD
--    VALUE is permitted inside a transaction on PG 12+ as long as the new value
--    is not USED in the same transaction; nothing below uses it.
DO $$
DECLARE
  v_enum regtype;
BEGIN
  SELECT a.atttypid::regtype
    INTO v_enum
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'service_jobs'
     AND a.attname = 'service_type'
     AND a.attnum > 0;

  IF v_enum IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_type t WHERE t.oid = v_enum AND t.typtype = 'e')
     AND NOT EXISTS (
       SELECT 1 FROM pg_enum e WHERE e.enumtypid = v_enum AND e.enumlabel = 'Appraisal'
     )
  THEN
    EXECUTE format('ALTER TYPE %s ADD VALUE %L', v_enum::text, 'Appraisal');
  END IF;
END
$$;

-- 2. The link itself. It lives on the REQUEST side: a request points at the one
--    job raised from it, and service_jobs knows nothing about requests.
ALTER TABLE public.service_requests
  ADD COLUMN IF NOT EXISTS service_job_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'service_requests_service_job_id_fkey'
       AND conrelid = 'public.service_requests'::regclass
  ) THEN
    ALTER TABLE public.service_requests
      ADD CONSTRAINT service_requests_service_job_id_fkey
      FOREIGN KEY (service_job_id) REFERENCES public.service_jobs(id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_service_requests_service_job_id
  ON public.service_requests (service_job_id)
  WHERE service_job_id IS NOT NULL;

-- 3. Completion is the DATABASE's, not the Hub's.
--    The Hub writes status 'received' when it links the job, and nothing after.
--    From there this trigger is the single writer of the request's status as
--    the job moves, so the two can never disagree.
--
--    Completed          → 'completed'
--    Process, On-going  → 'in_progress'
--    Pending, Cancelled → untouched (and Logged, the initial status)
--
--    "Untouched" is the point: a job going back to Pending does not un-say
--    whatever a human last told the customer, and a cancelled job is a
--    conversation for a person to have, not a status flip.
CREATE OR REPLACE FUNCTION public.sync_service_request_from_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next text;
BEGIN
  v_next := CASE NEW.service_status
              WHEN 'Completed' THEN 'completed'
              WHEN 'Process'   THEN 'in_progress'
              WHEN 'On-going'  THEN 'in_progress'
              ELSE NULL
            END;

  IF v_next IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.service_requests
     SET status = v_next,
         updated_at = now()
   WHERE service_job_id = NEW.id
     AND status IS DISTINCT FROM v_next;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_service_request_from_job ON public.service_jobs;
CREATE TRIGGER trg_sync_service_request_from_job
AFTER INSERT OR UPDATE OF service_status ON public.service_jobs
FOR EACH ROW
EXECUTE FUNCTION public.sync_service_request_from_job();
