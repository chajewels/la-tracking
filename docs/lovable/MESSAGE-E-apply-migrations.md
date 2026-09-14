# Lovable message E — APPLY MIGRATIONS ONLY (DRAFT — NOT SENT)

**Do not send until PR #58 is merged and `<MAIN_SHA>` is replaced with `main`'s
post-merge SHA.** One sender: Claude Code, from this session, after Cynthia's OK.
Check the Lovable message queue before sending. A transport timeout is not a failure —
never resend on a timeout.

**This message applies migrations. It deploys nothing.** Edge functions are message F.

---

Apply four migrations to the Supabase database for project
`5be237e2-d98a-4ee7-97f0-cf83faeed2ba`.

## 0. SOURCE ASSERTIONS — run these FIRST and STOP if any fails

Your repo mirror can lag GitHub. Confirm you are looking at `main` at
`<MAIN_SHA>` before you apply anything. If any count below differs, **stop and report
what you actually see** — do not apply, do not "fix" the file, do not proceed.

```bash
git rev-parse HEAD          # expect <MAIN_SHA>

wc -l supabase/migrations/20260914100000_layaway_quote_v2.sql                        # expect 176
grep -c "make_interval(months => n)" supabase/migrations/20260914100000_layaway_quote_v2.sql   # expect 1
grep -c "layaway_quote"              supabase/migrations/20260914100000_layaway_quote_v2.sql   # expect 6
grep -c "plan_configurations"        supabase/migrations/20260914100000_layaway_quote_v2.sql   # expect 6

wc -l supabase/migrations/20260914110000_web_layaway_schema.sql                      # expect 175
grep -c "layaway_account_items"      supabase/migrations/20260914110000_web_layaway_schema.sql # expect 11
grep -c "prevent_web_layaway_delete" supabase/migrations/20260914110000_web_layaway_schema.sql # expect 4
grep -c "settlement_due_at"          supabase/migrations/20260914110000_web_layaway_schema.sql # expect 2

wc -l supabase/migrations/20260914120000_web_layaway_rpcs.sql                        # expect 425
grep -c "create_web_layaway_atomic"  supabase/migrations/20260914120000_web_layaway_rpcs.sql   # expect 4
grep -c "expire_web_layaway_atomic"  supabase/migrations/20260914120000_web_layaway_rpcs.sql   # expect 4
grep -c "set_account_deadlines"      supabase/migrations/20260914120000_web_layaway_rpcs.sql   # expect 4
grep -c "submission_pending"         supabase/migrations/20260914120000_web_layaway_rpcs.sql   # expect 1

wc -l supabase/migrations/20260914130000_loyalty_spend_reversal_from_order_basis.sql # expect 842
grep -c "loyalty_order_spend_basis"  supabase/migrations/20260914130000_loyalty_spend_reversal_from_order_basis.sql  # expect 10
grep -c "loyalty_reversal_unsourced" supabase/migrations/20260914130000_loyalty_spend_reversal_from_order_basis.sql  # expect 3
grep -c "spend_baseline_jpy"         supabase/migrations/20260914130000_loyalty_spend_reversal_from_order_basis.sql  # expect 6
grep -c "DROP FUNCTION IF EXISTS public.revoke_loyalty_points" supabase/migrations/20260914130000_loyalty_spend_reversal_from_order_basis.sql  # expect 1
```

## 1. APPLY — in this exact order

Order matters: 3 depends on the columns 2 adds and on the quote 1 rewrites.

1. `20260914100000_layaway_quote_v2.sql`
2. `20260914110000_web_layaway_schema.sql`
3. `20260914120000_web_layaway_rpcs.sql`
4. `20260914130000_loyalty_spend_reversal_from_order_basis.sql`

Apply each as written. Do not edit, reorder, split, or re-run a migration that succeeded.
**None of these creates a cron job** — if you find yourself scheduling anything, stop.

If a migration fails part-way, stop and report the exact SQLSTATE and statement. Do not
attempt a repair or a partial re-run.

## 2. VERIFY — run all of these and paste the full output

### 2a. Schema — the new layaway columns and table

```sql
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='layaway_accounts'
   AND column_name IN ('source_channel','web_reference','quote_id','transfer_due_at',
                       'settlement_due_at','customer_lang','expired_at',
                       'fx_rate_used','fx_rate_date')
 ORDER BY column_name;
-- expect 9 rows. source_channel NOT NULL DEFAULT 'hub_manual'.

SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='public' AND table_name='layaway_account_items' ORDER BY ordinal_position;
-- expect the table to exist

SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='checkout_quotes'
   AND column_name IN ('settlement_currency','fx_rate','fx_rate_date');
-- expect 3 rows
```

### 2b. RPCs

```sql
SELECT p.proname, p.pronargs
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public'
   AND p.proname IN ('layaway_quote','create_web_layaway_atomic','expire_web_layaway_atomic',
                     'set_account_deadlines','loyalty_order_spend_basis',
                     'delete_account_atomic','delete_cash_order_atomic',
                     'terminate_web_order_atomic','loyalty_integrity_report')
 ORDER BY p.proname;
-- expect one row per name. Two rows for any single name means an overload survived — report it.
```

### 2c. ⚠️ ONLY ONE `revoke_loyalty_points` MAY SURVIVE

This is the assertion that matters most in this message.

```sql
SELECT p.pronargs, pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='revoke_loyalty_points';
```

**Expect exactly ONE row, `pronargs = 10`.**

**TWO rows means the DROP did not take.** Do not attempt to drop it yourself — stop and
report both signatures. The 9-argument twin carries the pre-fix body, and a nine-argument
call against two overloads fails with `is not unique` inside `delete_account_atomic`.

### 2d. Triggers

```sql
SELECT tgname, tgrelid::regclass AS on_table
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgname IN ('trg_prevent_web_layaway_delete','trg_prevent_paid_layaway_delete',
                  'trg_prevent_paid_cash_order_delete','trg_loyalty_transactions_immutable')
 ORDER BY tgname;
-- expect 4 rows
```

### 2e. Cron — nothing new should have appeared

```sql
SELECT jobid, jobname, schedule FROM cron.job ORDER BY jobid;
-- expect the SAME set as before this message. No new job. auto-expire-cash-orders stays '40 * * * *'.
```

### 2f. Loyalty integrity — and the seven pre-Hub members

```sql
SELECT * FROM loyalty_integrity_report();
```

**Expect ZERO rows.** Any row means ledger, lots, counter and tier disagree for that
member — report the rows and stop; do not repair anything.

The seven pre-Hub migration members (spend seeded before the Hub existed) must **not** be
flagged. The migration stamps `spend_baseline_jpy` for them so the two new predicates
ignore that seeded spend:

```sql
SELECT c.customer_code, c.full_name, m.cumulative_spend_jpy, m.spend_baseline_jpy, m.enrolled_at
  FROM loyalty_members m JOIN customers c ON c.id = m.customer_id
 WHERE m.spend_baseline_jpy IS NOT NULL AND NOT c.is_test
 ORDER BY m.enrolled_at;
-- expect the pre-2026-04-01 members, each with a non-null baseline.
-- Cross-check: none of these customer_codes may appear in the integrity report above.
```

### 2g. Nothing moved that should not have

```sql
SELECT count(*) AS members, sum(cumulative_spend_jpy) AS total_spend,
       sum(remaining_points) AS total_points
  FROM loyalty_members;
-- Record these. They must be UNCHANGED from before this message:
-- the migration adds a column and rewrites functions; it moves no balances.
```

## 3. REPORT BACK

- the output of every source assertion in §0
- which migrations applied, in order, and any that did not
- the full output of every query in §2
- **explicitly: how many rows §2c returned**
- anything you changed that this message did not ask for (expected: nothing)

Do **not** deploy any edge function in this message. That is message F.
