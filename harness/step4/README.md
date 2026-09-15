# Step-4 rule harness

A local Postgres that runs the **real** step-4 functions against **realistic** fixtures, so
the rules can be exercised without anyone clicking through the Hub and without writing a row
to the live database.

It was built on 2026-09-15 because every remaining acceptance row needed a state change, and
the only person able to make one was the owner. In one pass it exercised 13 rules, ran
INVARIANT 12 for the first time since it was written, and found three defects the acceptance
script had no row for. Keep it. Extend it rather than starting over.

---

## What is real here

**The functions under test are the live bodies, byte for byte.** `00_verify_fidelity.sql`
checks each one's `md5(prosrc)` against the hash measured on the live database, and
`build.sh` runs it on every rebuild. If it prints DRIFT, stop — the harness is exercising
something production does not run, and its results mean nothing until you find out why.

| function | md5 | measured |
|---|---|---|
| `create_web_layaway_atomic` | `678e6811b2e205a65f6b119bdf1b983e` | 2026-09-15 |
| `create_web_order_atomic` | `fbd3766066f014271d7cf3b8dd7b1d14` | 2026-09-15 (pre-fix) |
| `expire_web_layaway_atomic` | `e64328138d08626a12cbf54950ad43ec` | 2026-09-15 |
| `layaway_quote` | `ad4606c0da7511e7070138520d8d7907` | 2026-09-15 |
| `replace_customer_addresses` | `8a5345b7b07f0c9a6d671a1af6e65775` | 2026-09-15 (pre-fix) |
| `set_account_deadlines` | `cd65923b9852b72aee362645e12b7006` | 2026-09-15 (pre-fix) |

The three marked **pre-fix** are the bodies as production ran them when the
defect was found. That is deliberate: `build.sh` loads the baseline, so a
scenario run straight after a rebuild REPRODUCES the bug, and the same scenario
run with the fix migration loaded on top shows it gone. Do not "update" them to
a fixed hash — update them when LIVE changes, in the commit that explains why.

Everything else is drawn from the same place:

- **Schema** (`01_schema.sql`) generated from live `pg_attribute` / `pg_attrdef` / `pg_enum`.
  `layaway_accounts` has no `settlement_due_at` here, exactly as live.
- **Triggers** (`02`–`04`) are the live `pg_get_triggerdef` output for every table these
  functions touch, with bodies copied verbatim from `pg_get_functiondef` — including the ones
  that can change an answer: `enforce_test_invoice_prefix`, `enforce_plan_minimum_amount`,
  `validate_schedule_chronology`, `note_account_status_change`, `log_admin_table_change`,
  `sync_web_order_payment_status`, `clear_cash_order_expiry_on_complete`.
- **Fixtures** (`06_fixtures.sql`) are the pre-flight state measured in
  `docs/STEP4-ACCEPTANCE.md` §0: Test Customer with `is_test = true`, R7828 / N4020 / R3341 at
  their real prices, the five live `plan_configurations` rows, `php_jpy_rate` 0.42.

## What it does NOT prove

Read this before quoting a result as evidence.

- **No edge function runs.** Anything enforced in TypeScript is outside the harness entirely:
  the `reason_required` 400, the `deadline_required` 400, the `edit_account` permission check,
  every email. A rule proven here is proven at the SQL layer and nowhere else.
- **`auth.uid()` is a GUC**, not a request JWT. It returns whatever `harness.uid` is set to,
  and NULL otherwise — which is what a service-role RPC call sees in production, but it is a
  stand-in, so nothing about RLS or the real auth path is tested.
- **`net.http_post` and `vault.decrypted_secrets` are stand-ins**, so
  `notify_website_revalidate` runs to completion and posts nothing. No revalidation is tested.
- **`mk_quote()` and `sweep()` MIRROR the real code, they are not it.** `mk_quote` reproduces
  the `website` function's `POST /checkout/quote` insert; `sweep` reproduces the web-layaway
  half of `auto-expire-cash-orders`. Both cite the file and line they were copied from in
  `07_helpers.sql`. They are faithful to the code as written on 2026-09-15 — and they will go
  stale silently if that code changes, because nothing checks them the way the md5s check the
  functions. **If you change either edge function, change the mirror in the same commit.**
- **`replace_customer_addresses` is the only address route modelled.** The
  `website` function's PUT `/me/addresses` handler, its auth, and the storefront
  that calls it are all outside the harness — `T_ADDR.sql` calls the RPC
  directly, which is exactly the hole the fix closes at the RPC layer, and
  nothing here proves the HTTP layer was redeployed.
- **No loyalty, no payments allocation, no penalties.** `allocate_payment_atomic`,
  `award-loyalty-points` and the penalty engine are not loaded. A "deposit confirmed" in these
  scripts is an INSERT into `payments` plus a `total_paid` update — the shape the RPCs read,
  not the real confirmation path.
- **The UI is not tested at all.** Findings 1 and 2 concern `DeadlinesCard.tsx`; the harness
  proved the *state* those findings rest on, and the card was read by eye.

## Running it

Stand up a cluster once (anywhere you like — this is throwaway state, not project files):

    initdb -D /var/lib/postgresql/chaharness/data -U harness --auth=trust --locale=C
    pg_ctl -D /var/lib/postgresql/chaharness/data -o '-p 55432 -c timezone=UTC' -l pg.log start

Then:

    ./build.sh          # drops and rebuilds chaharness from 01..07, then checks fidelity
    psql -d chaharness -f T_ALL.sql    # all 13 scenarios, one verdict table
    psql -d chaharness -f T07.sql      # …or any single scenario, with full detail

`build.sh` honours `PGHOST` / `PGPORT` / `PGUSER` (defaults `127.0.0.1` / `55432` /
`harness`).

To exercise a **fix** rather than the pre-fix body, load its migration on top of a fresh
build — `build.sh` deliberately does not, so the baseline stays reproducible:

    ./build.sh
    psql -d chaharness -f ../../supabase/migrations/20260915140000_deadline_never_silently_cleared.sql
    psql -d chaharness -f T_PRA.sql

`T_ADDR.sql` is written to be run BOTH ways and compared — all three properties
FAIL on the baseline and PASS with `20260915160000` loaded:

    ./build.sh && psql -d chaharness -f T_ADDR.sql
    ./build.sh \
      && psql -d chaharness -f ../../supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql \
      && psql -d chaharness -f T_ADDR.sql

## The scripts

| file | what it exercises |
|---|---|
| `T01` | `set_account_deadlines` on a live unpaid plan — the audit row's shape |
| `T02` | a plan whose **deposit is already confirmed** (finding 1) |
| `T03` | a cancelled plan (`not_live`); a backdated date; a null date (finding 3) |
| `T05` | a web cash order — `transfer_due_at` and `expires_at` moving together |
| `T06` | no reason at all, straight at the RPC — where that guard really lives |
| `T07` | the expiry: every column that moves, plus idempotency |
| `T09` | a confirmed payment, and INVARIANT 12 — `submitted`, `under_review`, then rejected |
| `T11` | deposit paid, instalments overdue — the sweep must not touch it |
| `T12` | a downgraded term reaching the writer (`below_plan_minimum`) |
| `T13` | a peso plan — `loyalty_jpy_amount` must stay the **yen** product subtotal |
| `T14` | a Hub-created plan past its deadline — nothing sweeps it (finding 2) |
| `T_ALL` | all of the above in one deterministic run, as a verdict table |
| `T_PRA` | the finding-3 and observation-A fixes, after loading `20260915140000` |
| `T_PRB` | finding 1 — a deadline is spent once the deposit is confirmed |
| `T_ADDR` | the address book: the three properties the checkout fix must hold |
| `T_BACKFILL` / `T_BACKFILL_CHECK` | the `ship_to_snapshot` backfill, before and after |

## Adding a scenario

Write a `T*.sql` that sets up its own state and prints before/after. Prefer printing the
**actual** value next to the expected one over asserting — the point of this harness is to
report what happens, not to agree with what someone hoped would happen. That is how all three
defects surfaced: each one returned `ok: true`.

If your scenario needs a table or trigger the harness does not have yet, copy it from live
(`pg_get_functiondef`, `pg_get_triggerdef`) rather than writing a stub, and say in
`01_schema.sql`/`02_trigger_functions.sql` where it came from.
