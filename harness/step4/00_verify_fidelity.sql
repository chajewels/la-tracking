-- Fidelity check. Run it after build.sh, against the harness database.
--
-- The harness is only worth anything if the functions it exercises are the ones
-- production runs. These four md5s were taken from the LIVE database on
-- 2026-09-15 (`SELECT md5(prosrc) FROM pg_proc …`). If a row below prints
-- DRIFT, the harness is testing something else and its results mean nothing
-- until you find out why: re-read the live body, update the expected hash here
-- in the same commit that explains the change, and re-run.
--
-- Re-measure the live side with, in the SQL editor:
--   SELECT p.proname, md5(p.prosrc), length(p.prosrc)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('create_web_layaway_atomic','expire_web_layaway_atomic',
--                        'set_account_deadlines','layaway_quote')
--    ORDER BY 1;
\pset pager off
WITH live(proname, md5, measured, note) AS (VALUES
  ('create_web_layaway_atomic', '678e6811b2e205a65f6b119bdf1b983e', '2026-09-15', ''),
  ('expire_web_layaway_atomic', 'e64328138d08626a12cbf54950ad43ec', '2026-09-15', ''),
  ('layaway_quote',             'ad4606c0da7511e7070138520d8d7907', '2026-09-15', ''),
  -- set_account_deadlines is REPLACED by the fixes in migrations 20260915140000
  -- and 20260915150000, which build.sh does NOT load. Load them by hand on top
  -- of a fresh build to exercise the fixed behaviour (see T_PRA.sql / T_PRB.sql);
  -- this hash is the body as it stood when the findings were made.
  ('set_account_deadlines',     'cd65923b9852b72aee362645e12b7006', '2026-09-15',
   'pre-fix baseline; replaced by 20260915140000 / 20260915150000')
)
SELECT l.proname,
       CASE WHEN md5(p.prosrc) = l.md5 THEN 'matches live (' || l.measured || ')'
            WHEN p.oid IS NULL          THEN 'MISSING from the harness'
            ELSE 'DRIFT — harness ' || md5(p.prosrc) || ' vs live ' || l.md5 END AS fidelity,
       l.note
  FROM live l
  LEFT JOIN pg_proc p
    ON p.proname = l.proname
   AND p.pronamespace = 'public'::regnamespace
 ORDER BY 1;
