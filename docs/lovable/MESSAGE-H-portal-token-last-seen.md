# Lovable message H — apply both migrations, then deploy eleven functions

Status: **SENT 2026-09-15, once, by Claude Code.** PR #69 merged as `e6a5002c`;
all 22 pattern assertions plus 5 line counts were RE-DERIVED against
`main@e6a5002c` before sending (the draft was written pre-merge, when the tip
was `e847768f`) and every one held. One sender: Claude Code, from the session
that drafted this. The queue was checked before sending; a transport timeout is
not a failure and is never answered with a resend.

All 22 source assertions below passed the comment-strip test: each count is
identical after every comment line is removed from the file, and each differs
from the pre-release `main`. Three earlier candidates were REJECTED by that test
and replaced — `"Website layaway placed"` (2 raw / 1 stripped),
`"paid in full"` (2/1), and `"portal_tokens_expiring"` in the edge function
(2/1). Their replacements carry quotes and punctuation only code has.

---

## THE MESSAGE

Two migrations and eleven function deploys. Please do **all** of it, in the
order below, and report the actual output rather than "done".

### Background, so the changes read correctly

**Migration 1** fixes a staff notification. A web layaway's arrival showed
"Account created · Inv #TEST-900012 created by Unknown" — no reference, no
amount, no currency, no deadline, attributed to nobody because the storefront
created it, not a person. The cash-order notifier already had a web branch; the
layaway one never got it.

**Migration 2 plus the function deploys** start recording portal use. Until now
NOTHING recorded a portal authentication anywhere, so "does this customer use
the portal" could only be inferred from customers taking an action that left a
row — a read-only visit to check a balance wrote nothing. That is why 447 of 632
portal tokens reached 30 days from expiry with nobody knowing, and why the
mint-versus-use expiry decision is being deferred rather than guessed.

---

### STEP 0 — assert the source BEFORE doing anything

Work from `main` at commit `e6a5002c` (the PR #69 squash). If `HEAD` is not
that commit, check whether `e6a5002c` is an ancestor and say what the delta is
before continuing. Run every assertion. **If any
count differs, STOP and report it — do not apply, do not deploy, and do not
"fix" the source.** A mismatch means your mirror is not serving the merged
commit, which is exactly the lag that shipped a stale build once before.

**A. `supabase/migrations/20260915050000_web_order_arrival_notification.sql`**

```
wc -l                                                            -> 189
grep -c "'Website layaway placed',"                              -> 1
grep -c "' paid in full · '"                                     -> 1
grep -cE "^CREATE OR REPLACE FUNCTION public\.notify_money_label"        -> 1
grep -cE "^CREATE OR REPLACE FUNCTION public\.notify_deadline_label"     -> 1
grep -cE "^CREATE OR REPLACE FUNCTION public\.notify_account_created"    -> 1
grep -cE "^CREATE OR REPLACE FUNCTION public\.notify_cash_order_created" -> 1
grep -cE "notify_deadline_label\(NEW.transfer_due_at\)"          -> 2
```

**B. `supabase/migrations/20260915120000_portal_token_last_seen_and_expiry_report.sql`**

```
wc -l                                                            -> 280
grep -c "ADD COLUMN IF NOT EXISTS last_used_at timestamptz"      -> 1
grep -c "ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0" -> 1
grep -c "ADD COLUMN IF NOT EXISTS portal_last_seen_at timestamptz"      -> 1
grep -cE "^CREATE OR REPLACE FUNCTION public\.record_portal_seen"        -> 1
grep -cE "^CREATE OR REPLACE FUNCTION public\.portal_token_expiry_report" -> 1
grep -cE "^CREATE OR REPLACE FUNCTION public\.portal_tokens_expiring_list" -> 1
grep -cE "use_count = use_count \+ 1"                            -> 1
grep -cE "cron.schedule\('portal-token-check'"                   -> 1
grep -c "tokens_with_any_last_seen"                              -> 1
grep -c "GRANT EXECUTE ON FUNCTION public.record_portal_seen"    -> 1
```

Neither file exists on the pre-release `main`, so its presence is itself the
first check.

**C. `supabase/functions/_shared/portal-auth.ts`** — the changed shared helper

```
wc -l                            -> 233   (was 173)
grep -c "recordPortalSeen"       -> 4     (was 0)
grep -c "record_portal_seen"     -> 1     (was 0)
```

**D. `supabase/functions/portal-token-check/index.ts`** — new

```
wc -l                                                    -> 130
grep -c "portal_token_expiry_report"                     -> 1
grep -cE '^const ALERT_TYPE = "portal_tokens_expiring"'  -> 1
```

**E. `supabase/config.toml`**

```
wc -l                                          -> 180  (was 178)
grep -cE "\[functions\.portal-token-check\]"   -> 1    (was 0)
```

---

### STEP 1 — apply migration `20260915050000`

The web-order arrival notification. Every non-web branch is byte-for-byte
unchanged, and both notification bodies stay inside the existing
`BEGIN … EXCEPTION WHEN OTHERS THEN NULL` wrapper, so a failure in the
notification is swallowed and the order INSERT still commits.

#### Report, with the actual output

```sql
-- 1a. both notifiers carry their web branch. Expect true/true on both rows.
SELECT proname,
       pg_get_functiondef(oid) LIKE '%Website layaway placed%' AS has_layaway_web,
       pg_get_functiondef(oid) LIKE '%paid in full%'           AS has_cash_web
  FROM pg_proc
 WHERE proname IN ('notify_account_created','notify_cash_order_created')
 ORDER BY proname;

-- 1b. the two helpers, exercised. Expect: ₱29,754 | ¥679,980 | a PHT
--     timestamp ending ' PHT' | no deposit deadline set
SELECT public.notify_money_label(29754, 'PHP')    AS php,
       public.notify_money_label(679980, 'JPY')   AS jpy,
       public.notify_deadline_label(now() + interval '72 hours') AS deadline,
       public.notify_deadline_label(NULL)         AS no_deadline;

-- 1c. both triggers still attached, exactly once each. Expect 2 rows.
SELECT tgname, tgrelid::regclass AS on_table
  FROM pg_trigger
 WHERE tgname IN ('trg_notify_account_created','trg_notify_cash_order_created')
 ORDER BY tgname;
```

---

### STEP 2 — apply migration `20260915120000`

Adds two columns to `customer_portal_tokens`, one to `customers`, three
functions, one index and one cron job. **It changes no existing value** — the
new columns start NULL (and `use_count` 0) on every row.

#### Report, with the actual output

```sql
-- 2a. the three new columns. Expect exactly 3 rows:
--     customer_portal_tokens.last_used_at        timestamptz  YES  (null default)
--     customer_portal_tokens.use_count           integer      NO   default 0
--     customers.portal_last_seen_at              timestamptz  YES  (null default)
SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (   (table_name = 'customer_portal_tokens' AND column_name IN ('last_used_at','use_count'))
        OR (table_name = 'customers'              AND column_name = 'portal_last_seen_at'))
 ORDER BY table_name, column_name;

-- 2b. the three functions exist with the right signatures. Expect 3 rows.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns, p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('record_portal_seen','portal_token_expiry_report','portal_tokens_expiring_list')
 ORDER BY p.proname;

-- 2c. record_portal_seen is service_role only — NOT authenticated, NOT anon.
SELECT grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public' AND routine_name = 'record_portal_seen'
 ORDER BY grantee;

-- 2d. the cron job, registered EXACTLY ONCE. Expect one row, '55 0 * * *'.
--     If this returns two rows the migration was applied twice — say so.
SELECT jobid, jobname, schedule, active
  FROM cron.job WHERE jobname = 'portal-token-check';

-- 2e. THE REPORT RUNS. Expect status "ok", peak_day "2027-03-19",
--     peak_day_count 195, active_tokens 632, and
--     tokens_with_any_last_seen 0 — zero is CORRECT right now, because
--     nothing has authenticated since the columns came into existence.
SELECT jsonb_pretty(public.portal_token_expiry_report(60));

-- 2f. the worklist RPC is callable. Expect 632 over a 400-day window.
SELECT count(*) AS rows_returned FROM public.portal_tokens_expiring_list(400);

-- 2g. the index. Expect idx_customer_portal_tokens_last_used, partial on is_active.
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'customer_portal_tokens'
   AND indexname = 'idx_customer_portal_tokens_last_used';
```

**If 2e returns a `peak_day` other than 2027-03-19, or a count other than 195,
stop and paste what it returned** — the tokens were extended on 2026-09-15 and
those two figures are what the extension produced.

---

### STEP 3 — deploy eleven functions

One new function, plus every function that imports the changed
`_shared/portal-auth.ts`. **The ten importers are not optional and not
"changed files":** a function left on the old helper still authenticates
correctly but records nothing, and it fails silently — which is the exact
failure shape this whole change exists to remove.

```
1.  portal-token-check          (NEW — the daily check)
2.  customer-portal
3.  verify-portal-pin
4.  submit-payment
5.  submit-cash-payment
6.  edit-payment-submission
7.  upload-proof
8.  request-extension
9.  join-loyalty-program
10. process-loyalty-redemption
11. mark-loyalty-notification-read
```

That list is the import graph, taken two ways that agree exactly: the files
importing `portal-auth` and the files calling `resolvePortalAuth(` are the same
ten, and no other `_shared` module imports `portal-auth.ts`, so there is no
transitive caller. (`setup-customer-account` mentions `resolvePortalAuth` only
in a comment saying it is independent of it — do NOT include it.)

`portal-token-check` runs behind `verify_jwt = true`, already set in
`config.toml`.

#### Report, with evidence the DEPLOYED code is the new code

1. The deploy result for each of the eleven, with its new version number and
   updated-at timestamp.
2. Read back the **deployed** body of `portal-token-check` and of **any two** of
   the ten importers, and re-run these against what is actually running, not
   against the repo file:
   - `portal-token-check`: `grep -c "portal_token_expiry_report"` → 1
   - each importer: `grep -c "recordPortalSeen"` → **at least 1**

That is what "serving" means here that you can prove on your own. Please do
**not** try to synthesise a customer portal session to test the recorder — that
needs a real token and a real PIN, and the owner does it herself in step 4.

---

### STEP 4 — the owner proves the recorder writes (not you)

Once steps 1–3 report clean, Cynthia opens the customer portal once as a real
customer. Then these three queries decide whether the recorder actually works:

```sql
-- 4a. the token that just authenticated. Expect last_used_at within minutes
--     of now and use_count >= 1.
SELECT id, customer_id, last_used_at, use_count
  FROM public.customer_portal_tokens
 WHERE last_used_at IS NOT NULL
 ORDER BY last_used_at DESC LIMIT 5;

-- 4b. the same customer, from the other column. Expect portal_last_seen_at set.
SELECT customer_code, full_name, portal_last_seen_at
  FROM public.customers
 WHERE portal_last_seen_at IS NOT NULL
 ORDER BY portal_last_seen_at DESC LIMIT 5;

-- 4c. the report's own self-check. Expect 1 or more — NOT 0.
SELECT (public.portal_token_expiry_report(60) ->> 'tokens_with_any_last_seen') AS seen_ever;
```

**`tokens_with_any_last_seen` still 0 after a real portal visit is a FAILURE,
not a pass.** The write is deliberately fire-and-forget so it can never cost a
customer their portal, which means a broken write is silent — so this is the
only thing that distinguishes "working" from "quietly recording nothing". If it
stays 0, the next thing to read is the `customer-portal` function log for a
`Failed to record portal last-seen` line.

Note that the throttle is one write per hour per token: a second visit within
the hour will NOT move `use_count` again, and that is correct.

---

### What NOT to do

- Do not apply only one migration. Both, in the order given.
- Do not deploy only the new function. All eleven, or the importers you skip
  record nothing.
- Do not include `setup-customer-account` — it does not use the helper.
- Do not hand-edit `src/integrations/supabase/types.ts`. It regenerates.
- Do not change any existing row. Neither migration does, and neither should
  you: the new columns are meant to start empty.
- Do not run the cron by hand to "test" it before step 4 — it only reads.
- If any Step 0 assertion fails, stop and report. Do not reconcile the source.
