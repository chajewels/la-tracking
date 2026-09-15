# Message J — apply the settlement_due_at drop AND deploy its three functions

**SENT ONCE** on 2026-09-15 at 12:49:30Z by Claude Code, pinned to `main@95e7616c`
(release PR #74). Lovable message id `main:user#00000000002529#usr:M5CGFU4I`.

The `send_message` call returned a 60s transport timeout. Per CLAUDE.md "ONE SENDER
PER LOVABLE MESSAGE", that is NOT a failure and was NOT resent — the queue was
polled instead and confirmed **exactly one** copy.

## Assertion provenance

Every step-1 count was measured against `main@95e7616c` (not against develop, and
not reused from an earlier draft) and passed all three tests:

1. **comment-strip** — re-counted with comment lines removed; count must not move.
2. **differs from pre-release main** (`ccdc3d4d`) — a count identical before and
   after proves nothing about the deploy.
3. **the symbol lives in the file being asserted against** — no asserting a symbol
   against a file that only uses it, or only mentions it in prose.

Two candidates were REJECTED by those tests and are named in the message so they
are not reintroduced:

| Candidate | File | Why rejected |
|---|---|---|
| `settlement_due_at` (bare) | `create-layaway-account/index.ts` | comment-strip 1 → 0: the surviving reference is a comment |
| `transfer_due_at: transfer_due_at \|\| null,` | `create-layaway-account/index.ts` | 1 → 1: identical before and after |

`create-layaway-account` has **no new code string at all** — its whole change is two
deletions — so the message says so plainly and proves it with two anchored removals
plus an exact line count, rather than inventing a positive that does not exist.

## Deploy set — by import graph, not by guess

`website`, `set-account-deadlines`, `create-layaway-account`. These are the only
three functions whose source changed, and **no file under
`supabase/functions/_shared/` changed** (`git diff --name-only main develop --
supabase/functions/_shared` is empty), so no downstream importer needs redeploying.

## Why it could not be split

`website/index.ts` selects `settlement_due_at` by name. Applying the drop ahead of
the deployed code would 400 every `GET /layaway`. The message says this in its
opening lines and fixes the order: functions first, migration second.

---

# Message J — apply the settlement_due_at drop AND deploy its three functions, together

## READ THIS FIRST: this message is ONE unit. Do not split it.

The migration and the three function deploys must land in the **same pass**.
`supabase/functions/website/index.ts` selects `settlement_due_at` **by name** in
its layaway query. If you apply the migration and stop, every `GET /layaway`
from the storefront returns 400 for a column that no longer exists — a live
customer-facing break. If you deploy the functions and stop, nothing breaks and
the drop simply has not happened yet.

So: **assert → deploy the three functions → apply the migration → verify.**
Functions first, migration second. That order is safe in both directions; the
reverse is not.

If any assertion below fails, **STOP and report** — do not apply, do not deploy,
do not adjust the assertion to make it pass.

---

## Step 1 — assert on source content, before touching anything

Your mirror of `main` can lag GitHub. These counts prove you are looking at the
released code and not a stale copy. Every count below was measured on the merged
tree, and every one of them **differs** from the pre-release `main`
(`ccdc3d4d`) — a count that is the same before and after proves nothing.

### 1a. The migration file — it is new, so on pre-release main it did not exist

```
FILE: supabase/migrations/20260915120000_drop_settlement_due_at.sql

wc -l                                                                          -> 349

grep -c "DROP FUNCTION IF EXISTS public.create_web_layaway_atomic"             -> 1
grep -c "DROP FUNCTION IF EXISTS public.set_account_deadlines"                 -> 1
grep -c "ALTER TABLE public.layaway_accounts DROP COLUMN IF EXISTS settlement_due_at;" -> 1
grep -c "GRANT EXECUTE ON FUNCTION public.set_account_deadlines(text, uuid, timestamptz, text, uuid) TO service_role;" -> 1
```

Note the `DROP FUNCTION` lines are **expected and deliberate** — see step 3.
Do not "improve" them into `CREATE OR REPLACE`.

### 1b. `supabase/functions/set-account-deadlines/index.ts`

```
wc -l                                                    -> 85    (pre-release main: 71)

grep -c "reason_required"                                -> 1     (pre-release main: 0)
grep -c "A reason is required to change a deadline."     -> 1     (pre-release main: 0)
grep -c "p_reason: reason,"                              -> 1     (pre-release main: 0)
grep -c "p_settlement_due_at"                            -> 0     (pre-release main: 1)
```

### 1c. `supabase/functions/website/index.ts`

```
wc -l                                                                -> 1519  (pre-release main: 1520)

grep -c '"order_date, end_date, transfer_due_at, expired_at, "'      -> 1     (pre-release main: 0)
grep -c "p_settlement_due_at"                                        -> 0     (pre-release main: 1)
```

### 1d. `supabase/functions/create-layaway-account/index.ts`

**This file has no new code string to grep, and I am not going to invent one.**
Its entire code change is two deletions, so its proof is two removals that
match only code plus an exact line count:

```
wc -l                                                                -> 418   (pre-release main: 419)

grep -cE "^[[:space:]]+settlement_due_at,$"                          -> 0     (pre-release main: 1)
grep -cE "^[[:space:]]+settlement_due_at: settlement_due_at \|\| null,$" -> 0  (pre-release main: 1)
```

The file still mentions `settlement_due_at` once, **inside a comment** recording
that the field was removed. That is intentional. Do not assert on the bare word
`settlement_due_at` in this file — it matches the comment, not code, and such a
grep would pass on a stale copy too.

---

## Step 2 — deploy exactly these three edge functions

```
website
set-account-deadlines
create-layaway-account
```

That is the complete set, enumerated by walking the import graph rather than by
guessing: these are the only three functions whose source changed in this
release, and **no file under `supabase/functions/_shared/` changed**, so no
other function's build is affected and nothing else needs redeploying. (I
checked: `git diff --name-only main develop -- supabase/functions/_shared` is
empty.)

Do not deploy the rest of the fleet.

---

## Step 3 — apply the migration

`supabase/migrations/20260915120000_drop_settlement_due_at.sql`, exactly as
written, in one transaction.

Two things in it that look surprising and are correct:

1. **Both RPCs are `DROP`ped and recreated, not `CREATE OR REPLACE`d.**
   `p_settlement_due_at` carried a `DEFAULT`, so replacing in place would leave
   the old signature alive beside the new one, and every call that omits the
   argument would then fail with *"function ... is not unique"*. This is the
   same trap as the `revoke_loyalty_points` twin (Bug #271). Because a `DROP`
   takes the ACL with it, the grants are re-applied explicitly at the bottom of
   each block — leave them in.

2. **The column is dropped LAST,** after both functions are recreated, so
   neither function body ever references a column that has already gone
   mid-transaction.

Before this was written I checked the live database: **0 of 1,449**
`layaway_accounts` rows carried a `settlement_due_at` value, and nothing else in
the catalogue referenced it — no view, matview, index, constraint, RLS policy,
trigger or cron command. Nothing is lost by the drop.

---

## Step 4 — VERIFY. This is the deliverable, not the deploy.

Report the actual output of each, not a pass/fail.

### 4a. The column is gone

```sql
SELECT count(*) AS should_be_zero
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND column_name  = 'settlement_due_at';
```
Expect `0`. Any other number means the drop did not run, or ran somewhere else.

### 4b. Each RPC exists with EXACTLY ONE signature

```sql
SELECT p.proname,
       count(*) AS signatures,
       string_agg(pg_get_function_identity_arguments(p.oid), '  ||  ') AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('set_account_deadlines', 'create_web_layaway_atomic')
 GROUP BY p.proname
 ORDER BY p.proname;
```

Expect exactly two rows, each with `signatures = 1`:

| proname | signatures | args |
|---|---|---|
| `create_web_layaway_atomic` | 1 | `p_customer_id uuid, p_quote_id uuid, p_lang text, p_transfer_due_at timestamp with time zone, p_order_date date` |
| `set_account_deadlines` | 1 | `p_entity_type text, p_entity_id uuid, p_transfer_due_at timestamp with time zone, p_reason text, p_user_id uuid` |

**If either says `signatures = 2`, STOP and report both `args` strings.** That
means the drop-and-recreate left a twin behind, and every caller that omits the
last argument is now failing with *"is not unique"*. Do not guess which one to
delete — report it.

Neither signature should contain `p_settlement_due_at`.

### 4c. `GET /layaway` answers rather than 400s

This is the one that would break if the migration were applied without the
deploy, so it is the one that matters most. Call the deployed `website` function's
`GET /layaway` and report the **HTTP status** and whether a body came back.

A signed-in customer session is not needed to prove the column question: an
**unauthenticated** call must come back **401**, not **400** and not a
`column ... does not exist` error. A 401 proves the handler was reached and its
query compiled; a 400 or a 500 naming the column proves it did not.

If you do have a way to make an authenticated call with a real customer, report
the status and the plan count too — but do not synthesise a customer, a cart or
an address to manufacture one. An end-to-end customer journey is the owner's own
acceptance run, not an automated check here.

### 4d. What you deployed

For each of the three functions, report the **deployed version number and
timestamp**, and confirm the deployed body contains the step-1 strings. Read back
what you can actually observe; if you cannot read a deployed body, say so plainly
rather than reporting a match you did not verify.

---

## Do NOT, in this pass

- Do not touch `src/integrations/supabase/types.ts` by hand. It is generated and
  will regenerate on your next push; it still declares the dropped column and
  that is harmless because nothing reads it.
- Do not apply any other migration.
- Do not deploy any other function.
- Do not modify the two earlier step-4 migrations (`20260914110000`,
  `20260914120000`) or their UUID-named duplicates. They are applied history;
  this migration supersedes them.
