-- Live had ~13,500 cron runs in the last 7 days; the migration refuses outside 1,000–100,000.
INSERT INTO cron.job_run_details(jobid, status, start_time, end_time)
SELECT 1, 'succeeded', now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval
FROM generate_series(1, 2000) g;
