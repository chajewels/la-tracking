# Live vs repo — exact, line-level findings

**2026-09-17, read-only.** Nothing was changed, nothing deployed, no function executed.
Companion to `DRIFT-REPORT.md`, which gave the counts. This gives the hunks.

Every function below has a `<name>.sql` (live body, `pg_get_functiondef`, md5 in its
header) and a `<name>.diff` beside it.

## Method, and one correction to DRIFT-REPORT.md

Two normalisations are used, deliberately:

- **The diff** (`<name>.diff`) is line-preserving: per line, internal whitespace
  collapsed and trimmed, blank lines dropped. The drift audit's md5 collapsed the
  *whole body* to one line, which makes `diff -u` useless.
- **The classification** strips `--` comments (outside string literals) and then
  removes whitespace entirely. Two bodies equal under that test differ only in
  comments and layout; anything else is a LOGIC difference.

The second test matters because `notify_website_revalidate` is stored live as a
single line, so its line-diff shows the whole body as one hunk and looks
catastrophic. It is comment-and-whitespace only.

> **DRIFT-REPORT.md said of the negative-Δ functions: "the repo is *ahead of* live.
> Either the migration was never applied, or it was applied and live has since been
> edited down. This is the opposite risk and is arguably more urgent, because it
> means a shipped migration may not be running."**
>
> **That reading was wrong, and this pass corrects it.** The negative Δ is comments.
> Every migration checked here IS applied — all their sibling objects are live. Where
> logic differs at all, **live is AHEAD of the repo, never behind.** Nothing shipped
> is missing from live. The real exposure is the one #280 already named, three more
> times over: live carries changes the repo has never seen.

## 1. The five "repo ahead of live" functions — none of them were

| function | hunks | verdict |
|---|---|---|
| `notify_website_revalidate` | 1 comment, 1 whitespace | **live matches the repo's behaviour** |
| `reactivate_web_layaway_atomic` | comments only | **live matches the repo's behaviour** |
| `create_web_order_atomic` | 1 LOGIC + 3 comment | **live is AHEAD — a live-only change the repo lacks** |
| `create_web_layaway_atomic` | 1 LOGIC + comments | **live is AHEAD — a live-only change the repo lacks** |
| `terminate_web_order_atomic` | 1 LOGIC | **live is AHEAD — a live-only change the repo lacks** |

### The LOGIC hunks

**`create_web_order_atomic` and `create_web_layaway_atomic` — the deposit deadline.**

```diff
-v_due timestamptz := now() + interval '72 hours';
+v_due timestamptz := now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id));
```

Live computes the deposit deadline per customer. The repo still hardcodes 72 hours.
Live is running the newer rule described in CLAUDE.md WEB LAYAWAY.

**`terminate_web_order_atomic` — the recorded cancellation reason.**

```diff
-v_reason := COALESCE(NULLIF(btrim(p_reason), ''), 'Bank transfer not received within 72 hours (auto-expired)');
+v_reason := COALESCE(NULLIF(btrim(p_reason), ''), 'Bank transfer not received by the deadline (auto-expired)');
```

Customer- and staff-visible text on an auto-expiry. Live no longer promises 72 hours,
which is correct now that the deadline is a field; the repo still does.

### (d) Which migration introduced each repo-only LOGIC hunk

**There are no repo-only LOGIC hunks.** Every LOGIC hunk is live-only, so the question
inverts: which migration *should* have carried the live change, and did the rest of it land?

`web_deposit_deadline_hours` was added by
`20260916060000_deposit_deadline_follows_the_customer.sql`. That migration creates
**exactly one object** — the function itself:

```
CREATE OR REPLACE FUNCTION public.web_deposit_deadline_hours
```

It does **not** redefine `create_web_order_atomic`, `create_web_layaway_atomic` or
`terminate_web_order_atomic` (grep count: 0). Yet live has two of them calling it:

```
live callers of web_deposit_deadline_hours: create_web_layaway_atomic, create_web_order_atomic
```

So the function shipped as a migration and **the rewiring of its callers did not** — it
was applied in the SQL Editor and never committed. The same for the
`terminate_web_order_atomic` reason string. Three more functions in the Bug #280 trap:
rebuild any of them "verbatim from the repo" and the per-customer deadline silently
reverts to a hardcoded 72 hours.

**Sibling objects of every migration involved are live** (read-only checks):

| migration | siblings | live? |
|---|---|---|
| `20260916060000_deposit_deadline_follows_the_customer` | `web_deposit_deadline_hours` | ✅ 1/1 |
| `20260915160000_checkout_never_destroys_the_address_book` | `address_snapshot`, `upsert_customer_addresses`, `replace_customer_addresses` | ✅ 3/3; `replace_…` is the 68-char forwarding alias, as specified |
| | `cash_orders.ship_to_snapshot`, `layaway_accounts.ship_to_snapshot` | ✅ 2/2 |
| `20260914130802_…` (Bug #265) | `delete_account_atomic`, `delete_cash_order_atomic`, `loyalty_integrity_report`, `loyalty_order_spend_basis`, `revoke_loyalty_points` | ✅ 5/5 |
| `20260916180000_reactivate_expired_web_layaway` | `reactivate_web_layaway_atomic` | ✅ live = repo behaviour |

No migration is unapplied. The address-book protection, the Bug #265 work and the
reactivation RPC are all running.

## 2. `restore_loyalty_points` — the misplaced block, with line numbers

Snapshot: `restore_loyalty_points.sql`. **Not executed.** This is a static reading.

The idempotency early-exit, verbatim (lines 43–67 of the snapshot file):

```
43:  -- Idempotency check
44:  SELECT id INTO v_new_tx_id FROM loyalty_transactions
45:   WHERE member_id = v_revoke.member_id
46:     AND transaction_type = 'earned'
47:     AND notes LIKE '%Restored from revoke ' || p_revoke_transaction_id::text || '%'
48:   LIMIT 1;
49:  IF FOUND THEN
50:    RAISE NOTICE 'restore: already done as transaction %', v_new_tx_id;
51:    IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN
52:    INSERT INTO public.loyalty_transactions (
53:      member_id, transaction_type, points_amount, spend_amount_jpy,
54:      tier_at_time, account_id, cash_order_id, invoice_number, notes, created_by_user_id
55:    ) VALUES (
56:      v_revoke.member_id, 'tier_changed', 0, NULL,
57:      (SELECT name FROM public.loyalty_tiers WHERE id = v_new_tier_id),
58:      v_revoke.account_id, v_revoke.cash_order_id, v_revoke.invoice_number,
59:      'Tier restored: '
60:        || (SELECT name FROM public.loyalty_tiers WHERE id = v_member.current_tier_id)
61:        || ' → ' || (SELECT name FROM public.loyalty_tiers WHERE id = v_new_tier_id)
62:        || ' — points restored',
63:      p_created_by_user_id
64:    );
65:  END IF;
66:  RETURN v_new_tx_id;
67:  END IF;
```

**Neither variable is assigned before that block.**

| variable | first assigned | referenced at |
|---|---|---|
| `v_member` | **line 71** — `SELECT m.*, t.name AS tier_name INTO v_member …` | lines 51, 60 |
| `v_new_tier_id` | **line 129** — `SELECT id INTO v_new_tier_id …` | lines 51, 57, 61 |

Both references are 20 and 78 lines *ahead* of their assignments. `v_new_tier_id` is
simply NULL there; `v_member` is an **unassigned RECORD**, and referencing a field of
one raises `record "v_member" is not assigned yet` (SQLSTATE 55000).

The baseline has no such block — it reads `RAISE NOTICE …; RETURN v_new_tx_id; END IF;`
and nothing between. The text is a character-for-character copy of the legitimate
`tier_changed` insert near the end of the function, pasted into the wrong branch. It is
live-only and has **no record** in FIXED-BUGS or SYSTEM-STATUS.

Consequence, if the reading is right: a **second** restore of the same revoke
transaction raises instead of returning the existing transaction id — the idempotency
guard is the one path that cannot complete. A first restore is unaffected. Worth
reproducing deliberately against a test member before anyone changes it.

## 3. Positive drift, baseline-only — all four have a record, none was committed

| function | LOGIC hunk (live has, repo lacks) | record |
|---|---|---|
| `audit_account` | `v_dp_allocated` / `v_dp_overpaid` declared; `v_dp_allocated` summed from `payment_allocations` over DP payments; `v_sum_pending := v_sum_pending - GREATEST(0, GREATEST(0, v_dp_paid - downpayment_amount) - v_dp_allocated)` | **Bug #233** (2026-06-19) — CHECK-10 false positive on DP overpayment. The entry itself says *"SQL-Editor-only change"*. The `v_dp_allocated` term is a later refinement with **no separate record** |
| `allocate_payment_atomic` | DP-excess computation rewritten: `v_dp_required` / `v_dp_paid_before` / `v_dp_excess`, `least(round(p_amount_paid,2), greatest(round((v_dp_paid_before + p_amount_paid) …)))`, and the waterfall guard gains `(NOT p_is_downpayment) OR …` | **Bug #250** (2026-07-06) — DP overage waterfalls into installments; CLAUDE.md INVARIANT 11 |
| `get_recent_qualifying_order` | cash branch gains `OR co.loyalty_jpy_amount IS NULL` | **Bug #256** (2026-08-16) — cash orders excluded from retroactive enrollment award. Its sibling `derive_cash_order_loyalty_jpy` is in DRIFT-REPORT's **live-only** list, so the whole fix was SQL-Editor-only |
| `admin_update_schedule_base` | whole `DECLARE v_account_id / v_allocated / v_total_due / v_status` block; `RETURNING … INTO`; null guard; `SELECT COALESCE(SUM(pa.allocated_amount),0) INTO v_allocated …`; status recompute | **Bug #254** (2026-08-03) — schedule rows stuck at `partially_paid` when the denominator changed after allocation |

One documentation mismatch worth noting: CLAUDE.md INVARIANT 11 states *"audit_account no
longer subtracts DP overage from v_sum_pending (the excess now lives in schedule rows and
is already counted)."* Live **does** still subtract — but only the portion of the overage
that is **not** allocated (`overage − v_dp_allocated`, floored at 0). Post-#250 that
normally evaluates to 0, so the outcome matches the doc; the mechanism does not.

## What is not live that should be

**Nothing.** Every migration examined is applied and every sibling object exists. This
list is empty, and that is the headline correction to DRIFT-REPORT.md.

## Live-only logic with no record

Ordered by how much it would cost to lose in a rebuild.

1. **`create_web_order_atomic` + `create_web_layaway_atomic`** — the per-customer deposit
   deadline. Reverting these restores a hardcoded 72 hours for every customer, silently.
2. **`terminate_web_order_atomic`** — the auto-expiry reason string. Reverting reinstates a
   customer-facing promise of 72 hours that the system no longer keeps.
3. **`restore_loyalty_points`** — the misplaced `tier_changed` block (§2). Live-only, and
   this is the one case where the live version is *worse* than the repo's.
4. **`audit_account`** — the `v_dp_allocated` refinement on top of Bug #233.

Items 1–3 sit in exactly the position `approve_redemption_atomic` did before 2026-09-12:
live carries behaviour, the repo does not, and the next person to rebuild one of them
"verbatim from the repo" reverts it with a true-sounding justification. Per CLAUDE.md
*"A SQL EDITOR CHANGE THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD"*, each
needs a record-only migration carrying the live body — captured here, byte-verified,
ready to be committed when someone decides to.

## Reproducing

```sql
SELECT p.proname, md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = '<fn>';
```

Repo side: last `CREATE [OR REPLACE] FUNCTION public.<name>(` across
`supabase/migrations/` in filename order, body taken between the dollar-quote
delimiters. Classification: strip `--` comments outside string literals, remove all
whitespace, compare.
