-- Portal tokens: record that they are used, and warn before they lapse.
--
-- WHY. On 2026-09-15, 447 of 632 active portal tokens were 30 days from
-- expiry — 195 of them on a single Sunday — and nothing in the Hub knew.
-- No notification, no indicator, no cron watching expires_at. A dated UPDATE
-- bought 180 days; it changed nothing about the shape, and 440 of the 632 now
-- land in March 2027.
--
-- TWO SEPARATE THINGS LIVE HERE, and only the second is a warning system:
--
--   A. LAST-SEEN. There is currently NO record anywhere of a portal
--      authentication. Every "does this customer use the portal" figure the
--      2026-09-15 investigation could produce was built from customers taking
--      an ACTION that happened to leave a row — a submission, an edit, a
--      redemption. A read-only visit (checking a balance, reading a schedule —
--      the commonest reason to open the portal) writes nothing at all, so the
--      153 customers that measurement found are a FLOOR and the 479 "no
--      recorded use" are a CEILING. Nothing in the database narrows it.
--
--      The lifecycle question — should expiry run from the mint or from last
--      use — cannot honestly be answered against a floor, and it does not have
--      to be answered now: the extension leaves ~6 months of runway. So this
--      migration starts the recording and DEFERS the decision.
--
--   B. THE WARNING. Even with the best lifecycle rule, some tokens lapse, and
--      staff must know before a customer does.
--
-- Nothing here changes a single existing value.

-- ========================================================== A. last-seen
-- ON THE TOKEN, because the deferred question is about TOKENS: "should this
-- token's expiry run from its mint or its last use" is answered by token-level
-- recency and nothing else.
ALTER TABLE public.customer_portal_tokens
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.customer_portal_tokens.last_used_at IS
  'When this token last authenticated a portal request (_shared/portal-auth.ts, Path 1 and Path 2). NULL means never seen SINCE 2026-09-15 — it does not mean never used, because nothing recorded this before that date. Written fire-and-forget and throttled to at most once an hour per token.';

COMMENT ON COLUMN public.customer_portal_tokens.use_count IS
  'Portal SESSIONS this token has authenticated, not page loads: it shares last_used_at''s one-hour throttle, so a customer clicking around for ten minutes increments it once. Counts from 2026-09-15 only.';

-- ON THE CUSTOMER TOO, because the token column cannot see the JWT path.
-- resolvePortalAuth Path 0 (email/password, Phase B) returns no
-- source_token_id, and 76 of the 632 token-holders — 12% — also hold a
-- password. Recording only against tokens would file every one of them as
-- "never uses the portal" each time they sign in with their password, and
-- they are precisely the people the warning list must NOT chase: their access
-- does not depend on the token at all.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS portal_last_seen_at timestamptz;

COMMENT ON COLUMN public.customers.portal_last_seen_at IS
  'When this customer last authenticated to the customer portal by ANY route — password (JWT), session, or token. Distinct from customer_portal_tokens.last_used_at, which tracks one token. Recording began 2026-09-15; NULL before then means unrecorded, not unused.';

-- The report filters active tokens by expires_at; 650 rows needs no index for
-- that. This one serves the "has anything ever recorded?" health check, which
-- must stay cheap enough to run on every dashboard load.
CREATE INDEX IF NOT EXISTS idx_customer_portal_tokens_last_used
  ON public.customer_portal_tokens (last_used_at)
  WHERE is_active;

-- The writer, called fire-and-forget from _shared/portal-auth.ts on every
-- successful authentication (all three paths).
--
-- ONE ROUND TRIP, and the throttle lives in the WHERE clause so it costs no
-- read. Eleven edge functions call resolvePortalAuth, so one customer opening
-- the portal and submitting a payment authenticates about four times; the
-- one-hour throttle turns that into a single write. The side effect — that
-- use_count counts SESSIONS rather than page loads — is the more useful number.
--
-- p_token_id is NULL on the JWT path, which has no token row.
CREATE OR REPLACE FUNCTION public.record_portal_seen(
  p_customer_id uuid,
  p_token_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Two plain statements rather than one data-modifying CTE. Postgres does
  -- execute an unreferenced WITH ... UPDATE, but this function is the only
  -- thing standing between the Hub and another six months of no data, so it is
  -- written to be obviously correct rather than cleverly correct.
  IF p_token_id IS NOT NULL THEN
    UPDATE public.customer_portal_tokens
       SET last_used_at = now(),
           use_count = use_count + 1
     WHERE id = p_token_id
       AND (last_used_at IS NULL OR last_used_at < now() - interval '1 hour');
  END IF;

  UPDATE public.customers
     SET portal_last_seen_at = now()
   WHERE id = p_customer_id
     AND (portal_last_seen_at IS NULL OR portal_last_seen_at < now() - interval '1 hour');
END;
$$;

COMMENT ON FUNCTION public.record_portal_seen(uuid, uuid) IS
  'Records a successful portal authentication against the token (when there is one) and the customer. Throttled to one write an hour each. Called fire-and-forget by _shared/portal-auth.ts; callers are service-role edge functions.';

-- Service role only: this is written by edge functions, never by a browser.
REVOKE ALL ON FUNCTION public.record_portal_seen(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_portal_seen(uuid, uuid) TO service_role;

-- =================================================== B. the expiry report
-- Mirrors email_delivery_report: one SECURITY DEFINER function returning a
-- jsonb verdict, staff-gated inside the function because customers hold
-- authenticated sessions too.
CREATE OR REPLACE FUNCTION public.portal_token_expiry_report(p_days integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_days integer := GREATEST(1, COALESCE(p_days, 60));
  v_result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance')
    OR public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'csr')) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;

  -- One pass, CTEs rather than a temp table: a SECURITY DEFINER function that
  -- creates a temp table carries cross-call state and needs CREATE on the temp
  -- schema for every caller. Nothing here needs either.
  WITH live AS (
    SELECT DISTINCT la.customer_id
      FROM layaway_accounts la
      JOIN customers c ON c.id = la.customer_id
     WHERE COALESCE(c.is_test, false) = false
       AND la.invoice_number ~ '^[0-9]+$'
       AND la.status::text IN ('active','overdue','extension_active','reactivated')
  ),
  tok AS (
    SELECT t.id, t.expires_at, t.last_used_at,
           (l.customer_id IS NOT NULL) AS live_plan
      FROM customer_portal_tokens t
      LEFT JOIN live l ON l.customer_id = t.customer_id
     WHERE t.is_active
  ),
  win AS (
    SELECT * FROM tok
     WHERE expires_at IS NOT NULL
       AND expires_at <= now() + make_interval(days => v_days)
  ),
  -- THE PEAK DAY, not the window total. These were minted in bulk, so the
  -- population is a spike: on 2026-09-15 the 30-day figure was 447 but the
  -- actionable sentence was "195 lapse on Sunday". A total hides that.
  peak AS (
    SELECT (expires_at AT TIME ZONE 'Asia/Manila')::date AS day,
           count(*)::integer AS n,
           count(*) FILTER (WHERE live_plan)::integer AS n_live
      FROM win GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'window_days', v_days,
    'active_tokens', (SELECT count(*) FROM tok),
    'expiring_in_window', (SELECT count(*) FROM win),
    'expiring_in_window_with_live_plan', (SELECT count(*) FILTER (WHERE live_plan) FROM win),
    'bands', jsonb_build_object(
      'd60',     (SELECT count(*) FROM tok WHERE expires_at <= now() + interval '60 days' AND expires_at > now() + interval '30 days'),
      'd30',     (SELECT count(*) FROM tok WHERE expires_at <= now() + interval '30 days' AND expires_at > now() + interval '14 days'),
      'd14',     (SELECT count(*) FROM tok WHERE expires_at <= now() + interval '14 days' AND expires_at > now()),
      'expired', (SELECT count(*) FROM tok WHERE expires_at <= now())),
    'peak_day', (SELECT day FROM peak),
    'peak_day_count', COALESCE((SELECT n FROM peak), 0),
    'peak_day_with_live_plan', COALESCE((SELECT n_live FROM peak), 0),
    -- The group that matters most: a live plan, and no sign they have ever
    -- reached the portal, so a lapsed link strands someone mid-plan.
    'never_seen', (SELECT count(*) FROM tok WHERE last_used_at IS NULL),
    'never_seen_with_live_plan', (SELECT count(*) FROM tok WHERE last_used_at IS NULL AND live_plan),
    -- SELF-CHECK. The last-seen write is fire-and-forget: if it silently stops
    -- working, the lifecycle question is unanswerable again in six months and
    -- nobody finds out until then. Reporting the count means a stuck zero is
    -- visible in the Hub instead of discovered in March.
    'tokens_with_any_last_seen', (SELECT count(*) FROM tok WHERE last_used_at IS NOT NULL),
    'last_seen_recording_since', '2026-09-15'::date,
    'status', CASE
      WHEN (SELECT count(*) FROM tok WHERE expires_at <= now()) > 0 THEN 'expired'
      WHEN (SELECT count(*) FROM tok WHERE expires_at <= now() + interval '14 days' AND expires_at > now()) > 0 THEN 'urgent'
      WHEN (SELECT count(*) FROM tok WHERE expires_at <= now() + interval '30 days' AND expires_at > now() + interval '14 days') > 0 THEN 'soon'
      WHEN (SELECT count(*) FROM tok WHERE expires_at <= now() + interval '60 days' AND expires_at > now() + interval '30 days') > 0 THEN 'watch'
      ELSE 'ok' END
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.portal_token_expiry_report(integer) IS
  'Portal token expiry verdict for the Hub indicator and the daily check. Reports the PEAK DAY rather than the window total, because these tokens were minted in bulk and lapse in clusters. Staff only.';

REVOKE ALL ON FUNCTION public.portal_token_expiry_report(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_token_expiry_report(integer) TO authenticated, service_role;

-- ==================================================== C. the worklist RPC
-- The customer list NEVER travels in a notification — staff_notifications shows
-- 20 rows in the bell, so one alert naming hundreds of customers would bury
-- everything else. The alert carries counts; this returns the list, behind the
-- indicator, when someone opens it.
CREATE OR REPLACE FUNCTION public.portal_tokens_expiring_list(p_days integer DEFAULT 60)
RETURNS TABLE (
  token_id uuid, customer_id uuid, customer_code text, full_name text,
  email text, mobile_number text, expires_at timestamptz, days_left integer,
  last_used_at timestamptz, use_count integer, has_live_plan boolean,
  live_plan_count integer, has_password boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance')
    OR public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'csr')) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH live AS (
    SELECT la.customer_id, count(*)::integer AS n
      FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
     WHERE COALESCE(c.is_test, false) = false
       AND la.invoice_number ~ '^[0-9]+$'
       AND la.status::text IN ('active','overdue','extension_active','reactivated')
     GROUP BY la.customer_id
  )
  SELECT t.id, t.customer_id, c.customer_code, c.full_name, c.email, c.mobile_number,
         t.expires_at,
         GREATEST(0, (t.expires_at::date - now()::date))::integer,
         t.last_used_at, t.use_count,
         (l.customer_id IS NOT NULL),
         COALESCE(l.n, 0),
         (c.auth_user_id IS NOT NULL)
    FROM customer_portal_tokens t
    JOIN customers c ON c.id = t.customer_id
    LEFT JOIN live l ON l.customer_id = t.customer_id
   WHERE t.is_active
     AND t.expires_at IS NOT NULL
     AND t.expires_at <= now() + make_interval(days => GREATEST(1, COALESCE(p_days, 60)))
   -- Live plans first, then soonest to lapse: the order staff should work it in.
   ORDER BY (l.customer_id IS NOT NULL) DESC, t.expires_at ASC, c.full_name ASC;
END;
$$;

COMMENT ON FUNCTION public.portal_tokens_expiring_list(integer) IS
  'The worklist behind the portal-token indicator: who is about to lose their portal link, live plans first. has_password marks customers who can sign in without the token and therefore lose nothing when it lapses.';

REVOKE ALL ON FUNCTION public.portal_tokens_expiring_list(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_tokens_expiring_list(integer) TO authenticated, service_role;

-- =========================================================== D. the cron
-- Vault-backed like every other cron (CLAUDE.md CRON AUTH RULE). 00:55 UTC,
-- five minutes after email-health-check and clear of the morning chain, which
-- finishes at 00:25.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'portal-token-check';
SELECT cron.schedule('portal-token-check', '55 0 * * *', $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/portal-token-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{}'::jsonb
  );
$cron$);

-- Verification after applying:
--   SELECT public.portal_token_expiry_report(60);
--   SELECT count(*) FROM public.portal_tokens_expiring_list(400);
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='customer_portal_tokens' AND column_name IN ('last_used_at','use_count');
