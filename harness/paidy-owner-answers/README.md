# Paidy owner-answers harness (2026-10-04)

Runs `supabase/migrations/20261104110000_paidy_owner_answers.sql` on a local Postgres
against the **live** `reassign_order_owner_atomic` body and the shipped
`cash_order_payment_lock`, then 29 checks.

- `01_stubs.sql` — minimal copies of the tables both functions touch (column types read
  from live `information_schema`, 2026-10-04).
- `02_live_reassign.sql` — `pg_get_functiondef` of live `reassign_order_owner_atomic`,
  byte for byte. `run.sh` refuses to continue unless its md5 is
  `31956f1eea17e17c742d367bb8ef04f0` (the live value the migration guards on).
- `04_tests.sql` — R1–R6 (Reassign Owner refuses any Paidy history, layaway untouched,
  an order without Paidy still moves) and G1–G19 (no store credit, loyalty discount,
  manual payment or un-void while Paidy holds the order; Paidy's own recording, voiding,
  and everything after a Reject still work).

```bash
PSQL="psql -h /tmp -p 5499 -U postgres" harness/paidy-owner-answers/run.sh
```

Expected last line: `29 | 0`. Also checked by hand: a drifted live body makes the
migration stop with "has moved on live" and create nothing.
