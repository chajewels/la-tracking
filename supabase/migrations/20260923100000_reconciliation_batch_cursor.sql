-- ═══════════════════════════════════════════════════════════════════════════
-- Reconciliation cursor in SQL, a second daily run, and two hot indexes
-- 2026-09-23 — owner-approved from the Lovable issue scan
--
-- Nothing here changes a business rule. It changes where the reconciliation
-- cursor is computed, how often the job runs, and how two dashboard queries
-- reach their rows.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. next_reconciliation_batch — the cursor daily-reconciliation used to build
--    in JavaScript.
--
--    The old code paged reconciliation_log newest-first into a Map and stopped
--    as soon as the Map held as many distinct accounts as there were
--    candidates. That test counts every account the log has ever carried
--    (1,305 on 2026-09-23), not the 563 candidates, so it can stop with
--    candidates still unseen — those are then handed to the sort as "never
--    reconciled" and jump the queue. It also pages the log, so its cost grows
--    with the log (20,134 rows and ~92 more every night) rather than with the
--    work.
--
--    Ordering is unchanged and deliberate: never reconciled first
--    (COALESCE(max(checked_at), '-infinity')), then oldest first, then id so a
--    tie can never make two runs disagree about who is next.
-- ───────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_reconciliation_log_account_checked
  ON public.reconciliation_log (account_id, checked_at DESC);
COMMENT ON INDEX public.idx_reconciliation_log_account_checked IS
  'Serves next_reconciliation_batch: one index-only lookup per candidate for max(checked_at). Added 2026-09-23.';

CREATE OR REPLACE FUNCTION public.next_reconciliation_batch(p_limit integer DEFAULT 800)
RETURNS TABLE (
  id                uuid,
  invoice_number    text,
  status            text,
  total_paid        numeric,
  remaining_balance numeric,
  last_checked_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT a.id,
         a.invoice_number,
         a.status::text,
         a.total_paid,
         a.remaining_balance,
         l.last_checked_at
  FROM public.layaway_accounts a
  LEFT JOIN LATERAL (
    SELECT max(r.checked_at) AS last_checked_at
    FROM public.reconciliation_log r
    WHERE r.account_id = a.id
  ) l ON true
  WHERE a.status IN ('active', 'overdue', 'extension_active', 'final_settlement')
  ORDER BY COALESCE(l.last_checked_at, '-infinity'::timestamptz), a.id
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.next_reconciliation_batch(integer) IS
  'Accounts daily-reconciliation should reconcile next: never reconciled first, then oldest reconciliation_log.checked_at first, stable on id. Replaces the JS log sweep. Added 2026-09-23.';

REVOKE ALL ON FUNCTION public.next_reconciliation_batch(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_reconciliation_batch(integer) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. A second reconciliation run at 12:20 UTC (20:20 PHT).
--
--    The 00:20 run covers ~91 of 563 candidates before its budget is spent
--    (measured: 91, 91, 91, 91 accounts on 2026-09-18..22, ~2.0s each), so a
--    full pass takes about six nights. The budget is spent on real work, not on
--    overhead, so the only way to shorten the cycle is to run more often: two
--    runs cover ~182 a day and close the cycle in about three.
--
--    12:20 UTC sits far from the 00:00-00:55 morning chain, so it competes with
--    nothing in it. cron.schedule upserts by jobname, so replaying this is a
--    no-op. Body copied verbatim from jobid 15 — same Vault-backed key, per the
--    CRON AUTH RULE.
-- ───────────────────────────────────────────────────────────────────────────

SELECT cron.schedule(
  'daily-reconciliation-midday',
  '20 12 * * *',
  $cron$
    SELECT net.http_post(
      url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/daily-reconciliation',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
      ),
      body := '{}'::jsonb
    );
  $cron$
);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Two hot indexes.
--
--    Both tables are small enough that every one of these queries is a
--    sequential scan today, and both are polled on a timer, so the cost is paid
--    over and over for a handful of rows.
-- ───────────────────────────────────────────────────────────────────────────

-- src/hooks/use-pending-submissions.ts:15 (usePendingSubmissionCount, head:true
-- count, polled every 30s by every signed-in user who can see submissions) and
-- :47 (usePendingSubmissions, the same filter then ORDER BY created_at DESC
-- LIMIT 5). 4,902 rows scanned to count the 4 that match.
-- Measured over the 191-day pg_stat_statements window: the count query alone is
-- 256,582 calls at 214.7ms mean = 55,078s (15.3 hours) of database time, and the
-- summary query another 59,684 calls at 128.6ms = 7,674s. An index on the four
-- matching rows removes essentially all of it.
CREATE INDEX IF NOT EXISTS idx_payment_submissions_status_pending
  ON public.payment_submissions (status)
  WHERE status IN ('submitted', 'under_review');
COMMENT ON INDEX public.idx_payment_submissions_status_pending IS
  'Serves use-pending-submissions.ts:15 and :47 (the 30s-polled pending count and summary). Added 2026-09-23.';

-- supabase/functions/dashboard-summary/index.ts:171 (.in delivery_status
-- [sent, delivered]) and :172 (.eq delivery_status failed), plus
-- src/pages/Monitoring.tsx:150-153 (remSentCount, .eq delivery_status sent).
--
-- BE PRECISE ABOUT WHAT THIS ONE BUYS, because the column is not selective.
-- reminder_logs holds exactly two values today: 'sent' 15,471 and 'generated'
-- 3,448 of 18,919. So:
--   :172 (failed — 0 rows) IS served. Measured 55,098 calls at 61.9ms = 3,410s
--        over the 191-day pg_stat_statements window; verified Index Only Scan,
--        0.060ms. That is what this index removes.
--   :171 (sent+delivered — 82% of the table) and Monitoring.tsx:152 (sent) are
--        NOT served and should not be: the planner correctly keeps a sequential
--        scan at that selectivity (verified — Seq Scan, 5.8ms). Their 2,874s and
--        847s stay, and an index is the wrong tool for them.
--   :170 (reminderTotalQ) is an unfiltered count. No index can help it.
--   Monitoring.tsx:119 orders by created_at with NO status filter, so the
--        created_at DESC column does not serve it either. That column is for the
--        status-filtered newest-first reads, once a status other than 'sent'
--        becomes common — which is exactly when a delivery failure matters.
CREATE INDEX IF NOT EXISTS idx_reminder_logs_delivery_status_created
  ON public.reminder_logs (delivery_status, created_at DESC);
COMMENT ON INDEX public.idx_reminder_logs_delivery_status_created IS
  'Serves dashboard-summary/index.ts:172 (the failed-delivery count) and any future status-filtered read. The sent/delivered counts are 82%-selective and correctly keep a sequential scan. Added 2026-09-23.';
