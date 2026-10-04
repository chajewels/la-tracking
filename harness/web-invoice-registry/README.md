# Harness — 20261105100000_web_invoice_numbers_respect_registry.sql

`PSQL="psql -h /tmp -p 5499 -U postgres" ./run.sh` — 23 tests (S1–S5 helper and quote
trigger, R1–R16 registry, G1–G2 grants and no nextval left).

- `02_live_reserve_trigger.sql` and `03_live_register.sql` are the LIVE bodies, byte-exact
  (pg_get_functiondef read 2026-10-05; run.sh prints their md5s, which must be
  99144148… and 420f6280…).
- The three website writers (create_web_draft_atomic, create_web_layaway_atomic,
  create_web_order_atomic) need the whole checkout schema, so run.sh filters their rows
  out of the migration's VALUES list. Their patch was proven READ-ONLY on the live bytes
  on 2026-10-05: md5 equals the guard, the nextval site count is 2 / 1 / 1, the reverse
  replace returns the live md5 (replay is a no-op), and no other public function uses
  the sequence. On apply, CREATE OR REPLACE compiles them against the real schema; a
  failure rolls the whole migration back.
- The migration is applied twice (replay = no-op NOTICEs).
