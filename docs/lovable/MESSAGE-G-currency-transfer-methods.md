# Lovable message G — apply the currency column AND deploy `website`

Status: **SENT 2026-09-15, once, by Claude Code.** PR #65 merged as `aa5ceaa2`;
all 23 assertions re-derived against `main@aa5ceaa2` before sending and every one
was unchanged from the `ee847452` draft. One sender: Claude Code, from the session
that drafted this. The queue was checked before sending; a transport timeout is
not a failure and is never answered with a resend.

---

## THE MESSAGE

Two halves, one job. Please do **both** — do not split this into two messages or
stop after the migration.

Applying the migration alone changes nothing a customer can see: the currently
deployed `website` function still filters transfer methods on `region`, and it
will keep doing so until it is redeployed. Deploying alone fails too, because the
new code selects on a column that would not exist yet. Either half on its own
leaves the blocker in place. Apply, then deploy, then report both.

### Background, so the change reads correctly

A peso-settled layaway plan on a Japanese address was being shown Rakuten Bank —
a yen-only account the customer cannot pay pesos into. The plan could not be
placed at all. The cause: shipping country and payment account were one value.
`transfer_payment_methods` was selected by the shipping address's region, and
nothing recorded which currency each account can actually receive. Those are two
different questions — where the parcel goes, versus what the account can take.

After this change the bank follows the **settlement currency the customer chose**.
`region` is kept (it groups the accounts for staff and describes the destination)
and shipping is untouched.

---

### STEP 0 — assert the source BEFORE doing anything

Work from `main` at commit `aa5ceaa2`. If `HEAD` is not that commit, check whether
`aa5ceaa2` is an ancestor and say what the delta is before continuing.

Run every assertion below. **If any count differs, STOP and report it — do not
apply, do not deploy, and do not "fix" the source.** A mismatch means your mirror
is not serving the commit this message was written against, which is exactly the
lag that shipped a stale build once before.

Each of these was checked to match code and not prose: the counts are identical
after stripping every comment line from the file, and each one differs from the
pre-release `main`, so a passing assertion proves the new code is really there.

**A. The migration** — `supabase/migrations/20260915030000_transfer_method_currency.sql`

```
wc -l                                                                  -> 96
grep -c "ADD COLUMN IF NOT EXISTS currency text"                       -> 1
grep -c "SET currency = 'JPY'"                                         -> 1
grep -c "SET currency = 'PHP'"                                         -> 1
grep -c "ALTER COLUMN currency SET NOT NULL"                           -> 1
grep -c "transfer_payment_methods_currency_check"                      -> 2
grep -cE "CHECK \(currency = ANY"                                      -> 1
grep -c "idx_transfer_payment_methods_currency"                        -> 1
grep -c "RAISE EXCEPTION"                                              -> 1
grep -c "COMMENT ON COLUMN public.transfer_payment_methods.currency"    -> 1
```

This file does not exist on the pre-release `main` at all, so its presence is
itself the first check.

**B. The edge function** — `supabase/functions/website/index.ts`

```
wc -l                                                                  -> 1417   (was 1401)
grep -c "function regionForCurrency"                                   -> 1      (was 0)
grep -cE "^function regionForCountry"                                  -> 0      (was 1)
grep -cE '\.eq\("currency", cur\)'                                     -> 1      (was 0)
grep -cE '\.eq\("region", region\)'                                    -> 0      (was 1)
grep -cE 'transferMethods\(supabase: any, currency: string\)'          -> 1      (was 0)
grep -cE 'transferAvailable\(supabase: any, currency: string\)'        -> 1      (was 0)
grep -cE 'regionForCurrency\('                                         -> 7      (was 0)
grep -c "quoteSettlement"                                              -> 4      (was 0)
grep -c "orderCurrency"                                                -> 3      (was 0)
grep -cE 'transferMethods\(supabase, settlement\)'                     -> 1      (was 0)
grep -c '"mode, settlement_currency"'                                  -> 1      (was 0)
```

Two of those are "expect 0" on purpose — they prove the OLD code is gone, not just
that new code was added. Note that a bare `grep -c "regionForCountry"` returns
**1**, not 0: one mention survives inside an explanatory comment. That is why the
assertion is anchored with `^function`. Do not treat the bare count as a failure.

---

### STEP 1 — apply the migration

Apply `supabase/migrations/20260915030000_transfer_method_currency.sql`.

It adds `transfer_payment_methods.currency`, backfills it from `region`
(`JP → JPY`, `OVERSEAS → PHP`), then makes it `NOT NULL` with a
`CHECK (currency IN ('JPY','PHP'))` and no default. **No default is deliberate** —
a default would let a peso account created without touching the field become yen
silently and be offered to the wrong customers, which is the same class of bug
this removes. If any row is left without a currency the migration raises with a
count rather than failing bare at the `ALTER`; if that happens, report the count
and stop.

#### Report, with the actual output — not "done"

```sql
-- 1a. the two live rows and their currency. Expect exactly two, both active:
--     JP / JPY / Rakuten Bank Ltd (楽天銀行), and OVERSEAS / PHP / Metrobank.
SELECT region, currency, method_type, bank_name, is_active, sort_order
  FROM public.transfer_payment_methods
 ORDER BY currency, sort_order;

-- 1b. expect 0
SELECT count(*) AS null_currency
  FROM public.transfer_payment_methods WHERE currency IS NULL;

-- 1c. the NOT NULL, from the catalog. Expect is_nullable = NO, column_default NULL.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'transfer_payment_methods'
   AND column_name = 'currency';

-- 1d. the CHECK, from the catalog. Expect one row naming JPY and PHP.
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.transfer_payment_methods'::regclass
   AND conname = 'transfer_payment_methods_currency_check';

-- 1e. the index. Expect idx_transfer_payment_methods_currency, partial on is_active.
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename = 'transfer_payment_methods'
   AND indexname = 'idx_transfer_payment_methods_currency';

-- 1f. a refusal proof: this MUST fail with a check-constraint violation.
--     Run it inside a transaction and roll back, then paste the error text.
BEGIN;
  INSERT INTO public.transfer_payment_methods (region, currency, method_type, sort_order, is_active)
  VALUES ('JP', 'USD', 'bank', 999, false);
ROLLBACK;
```

If 1f *succeeds*, the CHECK did not take — say so and stop before deploying.

---

### STEP 2 — deploy the `website` function

Deploy `supabase/functions/website` from `main` at `aa5ceaa2`.

This is the half that actually changes what a customer sees. Six places now pick
the account by the settled currency rather than the destination: the checkout
quote, the pre-order gate, both `/checkout/pay` branches (each of which also
feeds the confirmation email from the same value, so the email cannot disagree
with the screen), `GET /orders/:id`, and `GET /layaway/:id`.

#### Report, with evidence that the DEPLOYED version is the new one

1. The deploy result and the function's new version number / updated-at
   timestamp from the Supabase dashboard.
2. Read back the **deployed** function body and re-run three of the Step 0
   assertions against what is actually running, not against the repo file:
   - `grep -c "function regionForCurrency"` → 1
   - `grep -cE '\.eq\("currency", cur\)'` → 1
   - `grep -cE '^function regionForCountry'` → 0

That is what "serving" means here that you can prove on your own. A full
end-to-end peso quote needs a signed-in customer, a cart and an address, so the
owner does that herself as row 2 of the acceptance run — please do **not** try to
synthesise a customer session for it. With the deployed body confirmed new and
the two rows carrying the right currency (Step 1), the outcome is determined: a
JP-address peso quote resolves `currency = 'PHP'` and returns **Metrobank**.

---

### What NOT to do

- Do not split this message. Apply and deploy both, in that order.
- Do not add a `DEFAULT` to the `currency` column. It is absent on purpose.
- Do not drop or rename `region`, and do not touch `shipping_rates` or
  `shippingFor()`. Shipping still follows the address country.
- Do not edit `src/integrations/supabase/types.ts` by hand. It regenerates.
- Do not change `transfer_payment_methods` row data. The `note_ja` on the
  Metrobank row holds an English sentence — that is a known content nit the owner
  will fix in Settings, not part of this change.
- If any Step 0 assertion fails, stop and report. Do not reconcile the source.
