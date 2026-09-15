# Message K — apply both deadline migrations, then deploy the eight functions

**Status:** DRAFT, not sent. Send only after PR #79 and PR #80 are both merged and
`main` carries them. One sender, and that sender is Claude Code (CLAUDE.md).

**Pinned to:** `main` after the #80 squash. Fill the SHA in before sending and
re-run every assertion against that SHA — a lagging Lovable mirror is why these
exist.

---

## The message

Two migrations to apply, then eight edge functions to deploy. Please do them in
that order, and STOP and report if any assertion below does not match.

### 0. Assertions before you touch anything

Run these against your mirror of `main`. Every count is from the merged release;
if your mirror is behind, these will not match and you must pull before applying.

```
grep -c "^export const Panel = ({ gutter, box, children }" supabase/functions/_shared/email-templates/order-shared.tsx   → 1
grep -c "wordBreak: 'break-word' as const"                  supabase/functions/_shared/email-templates/order-shared.tsx   → 2
wc -l                                                       supabase/functions/_shared/email-templates/order-shared.tsx   → 238

grep -c "<Panel gutter="                                    supabase/functions/_shared/email-templates/layaway-shared.tsx → 2
wc -l                                                       supabase/functions/_shared/email-templates/layaway-shared.tsx → 79

grep -c "^export type ImageableLine = {"                    supabase/functions/_shared/item-images.ts                     → 1
grep -c "^  \[key: string\]: any;"                          supabase/functions/_shared/item-images.ts                     → 1
wc -l                                                       supabase/functions/_shared/item-images.ts                     → 70

grep -c 'error: "deadline_required"'                        supabase/functions/set-account-deadlines/index.ts             → 1
wc -l                                                       supabase/functions/set-account-deadlines/index.ts             → 101

grep -c "await resolveItemImages("                          supabase/functions/website/index.ts                           → 2
wc -l                                                       supabase/functions/website/index.ts                           → 1532

grep -c "resolveItemImages("                                supabase/functions/customer-portal/index.ts                   → 2
wc -l                                                       supabase/functions/customer-portal/index.ts                   → 1156

grep -c "'deadline_required'"  supabase/migrations/20260915140000_deadline_never_silently_cleared.sql             → 1
wc -l                          supabase/migrations/20260915140000_deadline_never_silently_cleared.sql             → 113

grep -c "'already_paid'"       supabase/migrations/20260915150000_deadline_refused_once_deposit_confirmed.sql     → 1
grep -c "'payment_exists'"     supabase/migrations/20260915150000_deadline_refused_once_deposit_confirmed.sql     → 1
wc -l                          supabase/migrations/20260915150000_deadline_refused_once_deposit_confirmed.sql     → 131
```

Every one of these was validated three ways before being written down: re-run
against the file with comment lines stripped (the count must not move), compared
against pre-release `main` at `a4b32e0` (the count must DIFFER, or the file must
be absent there), and confirmed that the symbol actually lives in the file being
asserted against. Two earlier candidates failed and were rewritten — a `Panel`
pattern that matched nothing, and a `wordBreak|overflowWrap` pattern that counted
six where only four were code.

### 1. Apply the two migrations, IN FILENAME ORDER

```
supabase/migrations/20260915140000_deadline_never_silently_cleared.sql
supabase/migrations/20260915150000_deadline_refused_once_deposit_confirmed.sql
```

**Order is not cosmetic here.** Both are whole-body `CREATE OR REPLACE` of
`set_account_deadlines`, and `150000`'s body is the superset. Applied `140000`
then `150000`, every guard survives. Applied the other way round, the
`already_paid` refusal is silently dropped — measured, and stated in `150000`'s
own header.

### 2. Deploy these eight edge functions

| function | why it is in the list |
|---|---|
| `website` | changed directly |
| `customer-portal` | changed directly |
| `set-account-deadlines` | changed directly |
| `review-payment-submission` | imports `layaway-payment-received` + `order-payment-received` |
| `auto-expire-cash-orders` | imports `layaway-expired` + `order-expired` |
| `cancel-cash-order` | imports `order-cancelled` |
| `award-loyalty-points` | imports `loyalty-level` |
| `loyalty-inactivity-check` | imports `loyalty-level` |

**How that list was derived — this matters more than the list.** Only THREE
functions were changed by the release. The other five are in it because the
release also changed three shared files, and deploying only the changed files
would leave five functions running the old email panel:

1. Changed shared files: `_shared/email-templates/order-shared.tsx`,
   `_shared/email-templates/layaway-shared.tsx`, `_shared/item-images.ts`.
2. Templates importing those: `layaway-expired`, `layaway-payment-received`,
   `layaway-plan-created`, `layaway-shared`, `loyalty-level`, `order-cancelled`,
   `order-confirmation`, `order-expired`, `order-payment-received`.
3. Functions importing any of those templates, or `item-images` directly, plus
   the three changed functions → the eight above.

`loyalty-level` is the one worth noticing: the loyalty step-down emails import
`order-shared` for its panel, so `award-loyalty-points` and
`loyalty-inactivity-check` are carrying the clipping fix even though nothing in
the loyalty feature changed.

### 3. Verification — this is the deliverable, not the deploy

Report the actual output of each. Do not summarise, and do not substitute a
different check: if you cannot run one, say so rather than reporting a pass on
other evidence.

**a. `set_account_deadlines` exists with exactly ONE signature.**

```sql
SELECT p.oid::regprocedure AS signature
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'set_account_deadlines';
```

Expect exactly **one** row:
`set_account_deadlines(text,uuid,timestamp with time zone,text,uuid)`

**TWO ROWS MEANS STOP.** It means the whole-body replacement left a twin —
the Bug #271 `revoke_loyalty_points` failure repeating. Report both signatures
and change nothing else; every call that omits an argument will be failing with
"function ... is not unique".

**b. A null deadline is refused, not written.** Pick any live web layaway with
an unpaid deposit and note its `transfer_due_at` first.

```sql
SELECT public.set_account_deadlines('layaway', '<account_id>', NULL, 'verification', NULL);
```

Expect `{"error": "deadline_required"}`, the column **unchanged**, and **no**
new `audit_logs` row with action `deadlines_updated` for that account.

**c. A plan with a confirmed deposit returns `already_paid`.** Use
`CJ-W-900013`, whose deposit is confirmed.

```sql
SELECT public.set_account_deadlines('layaway',
       (SELECT id FROM layaway_accounts WHERE web_reference = 'CJ-W-900013'),
       now() + interval '7 days', 'verification', NULL);
```

Expect `{"error": "already_paid", "total_paid": …}`, the column unchanged, and
no audit row. (If it returns `payment_exists` instead, that is also correct —
it means the cached total reads zero while the ledger holds a live payment.)

**d. The two read paths still answer.** Both of these were touched by the image
resolver and both must return 200 with a body, not a 400:

- `GET /website/layaway` for a signed-in storefront customer who has a plan
- the customer portal loading a customer who has a web cash order

Report the status code and whether `items[].image_url` is populated. A 400 from
either is a deploy failure, not a data problem — say so and stop.

---

## What this release is

- **Bug #274** — every storefront email was clipped on the right; a 100%-width
  table cannot be inset with horizontal margin. Worst on payment-received, where
  every schedule row read `₱3,47`.
- **Bug #275** — a web layaway plan's photo never rendered; four surfaces read a
  column nothing writes, including the customer portal's cash lines, blank since
  2026-09-14.
- **Bug #276** — `ImageableLine` was an `interface`, which broke the Deno gate
  and left `develop` red across three merges.
- **Findings 1–3** — the deadline guards this message's migrations install.
