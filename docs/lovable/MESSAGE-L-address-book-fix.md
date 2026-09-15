# Message L — apply the address migration, THEN deploy the two functions

**Status:** SENT 2026-09-15 by Claude Code, after PR #82 (`develop` → `main`) was
merged by Cynthia and `main` was merged back into `develop`. One sender, and that
sender is Claude Code (CLAUDE.md). Queue checked before sending: the last message
to this project was message K at 14:47:10Z, so this is not a resend.

The `send_message` call TIMED OUT at 60s (transport only). Per CLAUDE.md it was
NOT resent; the queue was re-read instead, and the message is present exactly
once at 15:56:26Z — one user message containing `a3fa761`. Same transport
behaviour as message K.

**Pinned to:** `main@a3fa761` — "Release: a checkout can no longer destroy the
address book (#82)". All ten assertions below were re-run against `a3fa761`
ITSELF immediately before sending, not against a working branch — a lagging
Lovable mirror is why they exist. Every one passed all three tests.

**Pre-release main for the "must differ" test:** `23d740a`.

---

## The message

One migration to apply, then two edge functions to deploy. **The order is not a
preference — see §1.** Please STOP and report if any assertion in §0 does not match.

### 0. Assertions before you touch anything

Run these against your mirror of `main`. If your mirror is behind they will not
match; pull before applying.

```
grep -c "^CREATE OR REPLACE FUNCTION public.upsert_customer_addresses"  supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql  → 1
grep -c "public.address_snapshot(v_quote.ship_to_address_id)"           supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql  → 2
grep -cE "^ALTER TABLE public.\w+ +ADD COLUMN IF NOT EXISTS ship_to_snapshot jsonb;"  supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql  → 2
wc -l                                                                   supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql  → 726

grep -c 'rpc("upsert_customer_addresses"'   supabase/functions/website/index.ts   → 1
grep -c "^function shipToAddress("          supabase/functions/website/index.ts   → 1
grep -c "ship_to_snapshot: undefined,"      supabase/functions/website/index.ts   → 2
wc -l                                       supabase/functions/website/index.ts   → 1589

grep -c "ship_to_snapshot?.country"  supabase/functions/auto-expire-cash-orders/index.ts  → 2
wc -l                                supabase/functions/auto-expire-cash-orders/index.ts  → 382
```

Each was validated three ways before being written down: re-counted against the
file with comment lines stripped (the count must not move — none did), compared
against pre-release `main@23d740a` (each count must DIFFER, or the file must be
absent there — the migration is new, and all six code counts are 0 on `23d740a`),
and confirmed that the symbol lives in the file being asserted against.

### 1. Apply the migration FIRST. Do not deploy before it.

```
supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql
```

**Why the order is load-bearing, and why this is one task and not two.**

The currently-deployed `website` function calls the RPC `replace_customer_addresses`
**by name**. The new one calls `upsert_customer_addresses`. The migration creates
`upsert_customer_addresses` *and* rewrites `replace_customer_addresses` into a
forwarding alias with no body of its own.

- **Migration first (correct):** the moment it commits, the OLD deployed function
  is already safe — its call forwards to the new non-destructive body. The window
  before the deploy is harmless.
- **Deploy first (breaks):** the new function calls `upsert_customer_addresses`,
  which does not exist yet, so `PUT /me/addresses` fails for every checkout that
  sends an address until the migration lands.

So please do not split these into two runs, and do not deploy while the migration
is unapplied.

The migration is one transaction and self-verifying: its closing `DO` block
`RAISE`s rather than committing if the backfill left any web order without a
snapshot whose address still resolves. If it raises, nothing is written — report
the message and stop.

### 2. Deploy these two edge functions

| function | why |
|---|---|
| `website` | changed directly — `PUT /me/addresses` now calls `upsert_customer_addresses`; order and layaway detail read `ship_to_snapshot` first |
| `auto-expire-cash-orders` | changed directly — takes the expiry email's country from the snapshot |

**How the set was derived:** walked from the import graph, not from a guess. The
release changes exactly two files under `supabase/functions/`, and **no file under
`_shared/`**, so there is no fan-out — nothing else imports anything this release
touched. (Contrast message K, where three shared files pulled five extra functions
into the set.)

### 3. Verification — this is the deliverable, not the deploy

Report the actual output of each. Do not summarise, and do not substitute a
different check: if you cannot run one, say so rather than reporting a pass on
other evidence.

**a. Both functions exist, with exactly ONE signature each, and the old name has no
body of its own.**

```sql
SELECT p.oid::regprocedure AS signature,
       p.prosrc AS body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('upsert_customer_addresses','replace_customer_addresses','address_snapshot')
 ORDER BY 1;
```

Expect exactly **three** rows — one signature each. `replace_customer_addresses`'s
body must be the single forwarding SELECT and must contain **no** `DELETE`.

**TWO ROWS FOR ONE NAME MEANS STOP.** That is the Bug #271 `revoke_loyalty_points`
twin repeating: every call that omits an argument starts failing with "is not
unique". Report both signatures and change nothing else.

**b. The snapshot column is on BOTH order tables.**

```sql
SELECT table_name, data_type
  FROM information_schema.columns
 WHERE table_schema='public' AND column_name='ship_to_snapshot'
 ORDER BY 1;
```

Expect exactly two rows: `cash_orders` and `layaway_accounts`, both `jsonb`.

**c. The six repaired orders show their addresses. List them.**

```sql
SELECT 'cash' AS kind, web_reference, ship_to_snapshot->>'line1' AS line1,
       ship_to_snapshot->>'postal_code' AS postcode, ship_to_snapshot->>'country' AS country
  FROM cash_orders WHERE source_channel='web'
UNION ALL
SELECT 'layaway', web_reference, ship_to_snapshot->>'line1',
       ship_to_snapshot->>'postal_code', ship_to_snapshot->>'country'
  FROM layaway_accounts WHERE source_channel='web'
 ORDER BY 2;
```

Expect **six** rows, none with a null `line1`:
`CJ-W-900008`, `CJ-W-900009`, `CJ-W-900010`, `CJ-W-900011` (cash) and
`CJ-W-900012`, `CJ-W-900013` (layaway). Every one should carry line1 `7-23-11`.
Print the table as returned.

**d. A checkout that re-sends an existing address changes no ids. Prove it on live
data, inside a transaction you roll back.**

This is the whole point of the fix, so please run it against the real rows rather
than reasoning about it. It writes nothing — the `ROLLBACK` is mandatory.

```sql
BEGIN;

WITH c AS (SELECT customer_id FROM public.customer_addresses ORDER BY created_at LIMIT 1)
SELECT id AS id_before, line1 FROM public.customer_addresses
 WHERE customer_id = (SELECT customer_id FROM c) ORDER BY created_at;

-- Exactly what the CURRENTLY DEPLOYED storefront sends: the whole list, each
-- entry carrying its id. Called through the OLD name on purpose — that is what
-- an un-redeployed function reaches, and it must already be safe.
WITH c AS (SELECT customer_id FROM public.customer_addresses ORDER BY created_at LIMIT 1)
SELECT public.replace_customer_addresses(
  (SELECT customer_id FROM c),
  (SELECT jsonb_agg(jsonb_build_object(
       'id', a.id, 'label', a.label, 'recipient_name', a.recipient_name,
       'line1', a.line1, 'line2', a.line2, 'city', a.city, 'region', a.region,
       'postal_code', a.postal_code, 'country', a.country, 'phone', a.phone,
       'is_default', a.is_default))
     FROM public.customer_addresses a WHERE a.customer_id = (SELECT customer_id FROM c))
) AS result;

WITH c AS (SELECT customer_id FROM public.customer_addresses ORDER BY created_at LIMIT 1)
SELECT id AS id_after, line1 FROM public.customer_addresses
 WHERE customer_id = (SELECT customer_id FROM c) ORDER BY created_at;

SELECT count(*) AS web_orders_still_resolving
  FROM public.cash_orders c
 WHERE c.source_channel='web'
   AND EXISTS (SELECT 1 FROM public.customer_addresses a WHERE a.id = c.ship_to_address_id);

ROLLBACK;
```

Expect `result` to carry `ok: true`, `updated: 1`, `inserted: 0`, `count: 1` — read
the keys, not the string; jsonb does not preserve the order they were written in.
And expect **`id_after` identical to `id_before`**, with
`web_orders_still_resolving` = **4**.

This exact block was run both ways in the local harness before this message was
written, on the same fixture, so the contrast is measured rather than asserted:

| | `result` | id | orders resolving |
|---|---|---|---|
| pre-fix body | `{"ok": true, "count": 1}` | **CHANGES** (`e224dd82…` → `3a257699…`) | **0** |
| with the migration | `{"ok": true, "count": 1, "updated": 1, "inserted": 0}` | unchanged | 1 of 1 |

(The harness fixture holds one web order; live holds four, hence the 4 above.)
The `updated` / `inserted` keys exist only in the new body — their presence is
itself the signal that the alias reaches it. **If the id changes, the alias is
still on the old body — stop and report.**

### Not an automated check — the owner's acceptance run

An actual checkout through the storefront needs a signed-in customer session, a
cart and an address, which you have no way to produce. That belongs to Cynthia's
acceptance run and is not being asked of you here. Report (a)–(d) and stop.

---

## What this release is

- The checkout's address write is no longer destructive: `upsert_customer_addresses`
  updates by id, inserts what is new, and leaves unmentioned rows alone.
- Every web order now carries `ship_to_snapshot` — where it was actually sent —
  written from one shared expression, `address_snapshot(uuid)`, so a backfilled
  order and a new one cannot disagree.
- The six existing web orders are repaired in the same migration.
