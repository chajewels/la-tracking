# Function drift audit — live vs `supabase/migrations/`

**2026-09-17, read-only.** Nothing was changed. No DB writes, no deploys.

> **RESOLVED the same day.** Every drifted and live-only body found below is now
> recorded in `supabase/migrations/` — `20260917070050_record_live_loyalty_fixes.sql`,
> `20260917070100_record_live_only_functions.sql`,
> `20260917070200_record_live_drifted_functions.sql`, and
> `20260917070300_record_drop_validate_schedule_start_year.sql` for the one
> repo-only leftover. (`expire_transfer_orders`, the other repo-only name, was
> already dropped by `20260913050000`.) Re-running the census afterwards returns
> **zero rows in all three buckets**: 163 functions, digest
> `b6c6d5f1a172f9c3412d220661434861`. The census is now re-runnable —
> `scripts/function-drift-audit`, documented in `docs/SCHEMA-FACTS.md` — and the
> rule it enforces is CLAUDE.md *"FUNCTION CHANGES START FROM LIVE"*.
> One caveat carried forward: `approve_redemption_atomic` and
> `_award_birthday_reward` are defined by
> `20260917070000_relot_wire_redemption_and_birthday.sql` (applied ~06:10), which
> **changed the birthday-lot expiry rule** relative to the hand patch it landed on
> top of — see docs/FIXED-BUGS.md #280.

> **CORRECTED by `DIFF-FINDINGS.md` (same day, same directory).** The section below
> reads the negative-Δ functions as "the repo is ahead of live … a shipped migration
> may not be running". That is wrong. The line-level diffs show the negative Δ is
> **comments**, every migration involved IS applied, and wherever logic differs at all
> **live is ahead of the repo, never behind**. Read DIFF-FINDINGS.md for the hunks.

Prompted by Bug #280: `approve_redemption_atomic` was wired to
`consume_lots_fifo` live in the SQL Editor on 2026-07-05, never committed, and
silently reverted on 2026-09-12 by a migration that rebuilt it "verbatim from
the live baseline … no later migration redefines this function". That sentence
was true and was not evidence. This audit asks how much else is in that state.

## Method, and one deliberate departure from the brief

The brief asked for md5 of `pg_get_functiondef`, whitespace-normalised, on both
sides. **That comparator does not work**, and using it would have reported
near-total drift that means nothing: `pg_get_functiondef` emits a *canonical*
header (` RETURNS jsonb\n LANGUAGE plpgsql\n SET search_path TO 'public'\nAS
$function$`), while a hand-written migration may write the same function as
`RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$`. Identical function, different text. The baseline happens to match because
it was *generated* from `pg_get_functiondef`; every hand-written migration since
would have shown as drift.

So the comparator is the **body** — `pg_proc.prosrc` against the text between
the migration's dollar-quote delimiters — whitespace-collapsed and trimmed on
both sides. Postgres stores the body verbatim, so this compares what actually
differs. Everything below uses it.

Other choices, stated so they can be argued with:

- **Keyed on function name, last definition wins**, in filename order, as the
  brief specifies. Safe here: live has **163 functions and 163 distinct names**
  — no overloads at all — so a name identifies a function unambiguously. Repo
  arg lists could not be matched to `pg_get_function_identity_arguments`
  reliably anyway (`timestamptz` vs `timestamp with time zone`, `DEFAULT`
  clauses), and name-keying sidesteps that.
- Extension-owned functions excluded (`pg_depend.deptype = 'e'`).
- Both `CREATE FUNCTION` and `CREATE OR REPLACE FUNCTION` counted.

## Counts

| | |
|---|---|
| live functions (public, non-extension) | **163** |
| distinct names in `supabase/migrations/` | **150** |
| present on both sides | **148** |
| **(a) body differs** | **14** |
| **(b) live only — no repo definition at all** | **15** |
| **(c) repo only — never applied, or since dropped** | **2** |
| identical | 134 |

## (a) Live body ≠ latest repo body — 14

`Δ` is live length minus repo length, on the normalised body.

| function | Δ | last repo definition | post-baseline migration? |
|---|---:|---|---|
| `admin_update_schedule_base` | +1389 | baseline | no |
| `allocate_payment_atomic` | +19 | baseline | no |
| `audit_account` | +395 | baseline | no |
| **`consume_lots_fifo`** | +28 | baseline | no |
| `create_web_layaway_atomic` | −1902 | `20260915160000_checkout_never_destroys_the_address_book` | yes (6) |
| `create_web_order_atomic` | −437 | `20260915160000_checkout_never_destroys_the_address_book` | yes (8) |
| `get_recent_qualifying_order` | +35 | baseline | no |
| **`insert_lot_and_extend`** | +17 | baseline | no |
| `notify_website_revalidate` | −73 | `20260908120000_website_catalog_metals_fx_collections` | yes (2) |
| `reactivate_web_layaway_atomic` | −1950 | `20260916180000_reactivate_expired_web_layaway` | yes (1) |
| **`restore_loyalty_points`** | +1330 | baseline | no |
| `terminate_web_order_atomic` | ±0 | `20260914130802_4643ccda…` | yes (4) |
| `upsert_customer_addresses` | −331 | `20260915160000_checkout_never_destroys_the_address_book` | yes (2) |
| **`void_redemption_atomic`** | +740 | baseline | no |

**Eight of the fourteen have no post-baseline migration at all.** Those are the
ones in exactly the #265 trap: the newest thing the repo knows about them is the
baseline, so anyone who rebuilds one "from the baseline" ships the pre-2026-07-05
body and silently reverts whatever live has been running since. That is not a
hypothetical — it is precisely what happened to `approve_redemption_atomic`.

**`approve_redemption_atomic` does not appear in this table**, and that is the
most important line in the report. Its live body now matches the repo exactly,
because the revert made it match. **A drift audit cannot see #265-style damage
after the fact — only before.** This audit would have flagged it every day
between 2026-07-05 and 2026-09-11, and says nothing about it today.

### The four loyalty-lot functions — exact diffs

All four were changed in the same 2026-07-05 SQL Editor session. None was
committed. One (`approve_redemption_atomic`) has already been destroyed by a
rebuild; these three are still live and still uncommitted.

**`consume_lots_fifo`** — one line, and it is the entire fix for Bug #244:

```diff
      WHERE lots.member_id        = p_member_id
        AND lots.remaining_amount > 0
+       AND lots.revoked_at   IS NULL
        AND lots.expired_at IS NULL
```

Without it the FIFO scan consumes from **revoked** lots — deducting the member's
counter while the open-lot sum is unchanged, violating the lot invariant on
every redemption. `docs/FIXED-BUGS.md` #244 records this as fixed on 2026-07-05.
**It is fixed in live only.** Rebuild this function from the baseline and Bug
#244 comes back.

**`insert_lot_and_extend`** — the expiry rule. The brief's observation is
correct: the baseline says 12 months, live says 180 days.

```diff
     CASE p_source_type
-      WHEN 'order_earn' THEN p_earned_at + INTERVAL '12 months'
+      WHEN 'order_earn' THEN p_earned_at + INTERVAL '180 days'
       ELSE NULL  -- birthday/promo/admin_adjust set explicit expires_at
     END);
...
   IF p_source_type = 'order_earn' THEN
     UPDATE public.loyalty_point_lots AS lots
-       SET expires_at = p_earned_at + INTERVAL '12 months',
+       SET expires_at = p_earned_at + INTERVAL '180 days',
      WHERE lots.member_id   = p_member_id
-       AND lots.source_type = 'order_earn'
+       AND lots.source_type IN ('order_earn', 'admin_adjust')
```

Two substantive changes, not one. Live also rolls the extension over
`admin_adjust` lots (the migrated Google-Sheets lots), which the baseline does
not. The live expiry rule, authoritative as of this capture:

| `source_type` | expiry when caller passes none | rolled forward by a later `order_earn`? |
|---|---|---|
| `order_earn` | `earned_at + 180 days` | yes |
| `admin_adjust` | **none — NULL, never expires** | yes |
| `birthday_bonus` | **none — NULL, never expires** | no |
| `promo_bonus` | **none — NULL, never expires** | no |
| `refund_restoration` | **none — NULL, never expires** | no |

The `ELSE NULL` branch is worth sitting with: any lot that is not `order_earn`
and whose caller does not pass `p_expires_at` **never expires**. Four live lots
currently have `expires_at IS NULL`, all `admin_adjust`.

**`void_redemption_atomic`** — 14 lines live, absent from the baseline. This is
the restore block and the synthetic top-up the brief asked to see quoted:

```sql
  -- Restore consumed lots from the ledger (wired 2026-07-05). Redemptions
  -- approved before lot-wiring have no ledger rows and restore 0; top up
  -- the shortfall with a synthetic lot so the lot/counter invariant holds.
  v_lots_restored := public.restore_lots_for_redemption(p_redemption_id);
  IF v_lots_restored < v_pts::integer THEN
    INSERT INTO public.loyalty_point_lots
      (member_id, source_type, source_reference, original_amount, remaining_amount, earned_at, expires_at, notes)
    VALUES
      (m.id, 'admin_adjust'::loyalty_lot_source_type, 'VOID-TOPUP-' || p_redemption_id::text,
       v_pts::integer - v_lots_restored, v_pts::integer - v_lots_restored, now(), NULL,
       'Synthetic lot: void of pre-lot-wiring redemption');
  END IF;
```

plus `v_lots_restored integer;` in the DECLARE. Note `expires_at` is passed
`NULL` here, so a top-up lot never expires — consistent with the table above,
and a deliberate choice for a lot created to repair an invariant.

**This is why the asymmetry exists.** `void_redemption_atomic` still restores
lots and `approve_redemption_atomic` no longer consumes them, because a
migration rebuilt approve from the baseline and nothing ever rebuilt void. The
survivor is the proof of the mechanism — and it is a live trap: rebuilding
`void_redemption_atomic` from the baseline next would drop this block too.

### `restore_loyalty_points` — a live-only change that looks like an accident

Live is 1,330 characters longer than the baseline, and the extra text is a
`tier_changed` INSERT block wedged **inside the idempotency early-exit**:

```
  IF FOUND THEN
    RAISE NOTICE 'restore: already done as transaction %', v_new_tx_id;
    IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN     ← live only
    INSERT INTO public.loyalty_transactions (... 'tier_changed' ...);   ← live only
  END IF;                                                              ← live only
  RETURN v_new_tx_id;
  END IF;
```

The baseline has `RAISE NOTICE …; RETURN v_new_tx_id; END IF;` and nothing
between. The block appears to be a copy of the identical one near the end of the
function, pasted into the wrong branch. At that point in execution `v_member` has
not been loaded and `v_new_tier_id` has not been assigned, so on the
already-restored path plpgsql should raise *"record v_member is not assigned
yet"* rather than returning the existing transaction id.

**Read statically, not executed.** I did not run it — this is an investigation,
not a fix. Filed for someone to reproduce deliberately against a test member.
It only fires on a *repeat* restore of the same revoke transaction.

### The other nine

`upsert_customer_addresses` (−331): the differences located are **comment text
only** — the repo version carries longer explanatory comments ("…not as an
error: the customer's address should still save", "default decided below, in one
pass", the three-line "No unambiguous request" note). Every logic line compared
matches: the two-step default handling, the `invalid_text_representation`
handler, the insert column list. Compared by inspection of the differing
comments, not by a full mechanical diff — treat as "probably comments" rather
than proven equivalent.

For `admin_update_schedule_base`, `allocate_payment_atomic`, `audit_account`,
`get_recent_qualifying_order`, `create_web_layaway_atomic`,
`create_web_order_atomic`, `notify_website_revalidate`,
`reactivate_web_layaway_atomic` and `terminate_web_order_atomic` the **exact
diff was not computed** — each needs its full live body pulled and diffed, and
that is a bigger job than this pass. What the numbers say:

- **Δ positive with no post-baseline migration** (`admin_update_schedule_base`
  +1389, `audit_account` +395, `allocate_payment_atomic` +19,
  `get_recent_qualifying_order` +35) — live has grown past the baseline through
  uncommitted SQL Editor work. Same shape as the loyalty four. `audit_account`
  and `allocate_payment_atomic` are load-bearing enough to be worth doing next.
- **Δ negative with a post-baseline migration** — ~~(`create_web_layaway_atomic`
  −1902, `reactivate_web_layaway_atomic` −1950, `create_web_order_atomic` −437,
  `notify_website_revalidate` −73) — the repo is *ahead of* live. Either the
  migration was never applied, or it was applied and live has since been edited
  down. This is the opposite risk and is arguably more urgent, because it means
  a shipped migration may not be running.~~
  **WRONG — corrected by DIFF-FINDINGS.md.** The negative Δ is comments. All four
  migrations are applied and every sibling object is live. Where logic differs,
  live is AHEAD of the repo.
- `terminate_web_order_atomic` differs at **identical normalised length** — a
  substitution of equal size, which is the signature of a small edit rather than
  an added or removed block.

## (b) Live only — 15 functions the repo has never seen

No migration defines these at all. They exist only in the database; if the repo
were replayed into a fresh project, they would not be there.

`auto_waive_same_day_penalties`, `cancel_cash_order_atomic`,
`consume_store_credit_for_shopify_atomic`, `derive_cash_order_loyalty_jpy`,
`get_daily_cash_orders`, `get_daily_cash_orders_last_month`,
`issue_store_credit_atomic`, `note_account_status_change`,
`note_extension_request`, `note_loyalty_transaction`, `note_penalty_waiver`,
`redeem_store_credit_atomic`, `rename_invoice_number_atomic`,
`revert_auto_waive_on_rejection`, `void_store_credit_lot_atomic`

Four of the five store-credit RPCs are in this list — the feature CLAUDE.md
calls a locked, non-negotiable policy exists in the repo only as edge-function
code and prose. Four of the `note_*` account-trail triggers are here too.

These cannot be *reverted* by a baseline rebuild, because there is nothing in
the repo to rebuild them from. Their risk is the other one: they are absent from
the in-repo source of truth entirely, so a fresh rebuild is silently incomplete.

## (c) Repo only — 2

- **`expire_transfer_orders`** — expected. CLAUDE.md records it as deliberately
  removed on 2026-09-13 ("the SQL cron `expire_transfer_orders()` is gone");
  `auto-expire-cash-orders` is the only expiry path now. The repo still carries
  its `CREATE`. Not drift, history.
- **`validate_schedule_start_year`** — defined in the baseline, not live.
  Dropped at some point with no migration recording it.

## What this does not cover

Triggers, views, RLS policies, indexes, grants and cron entries were **not**
compared. The baseline captures all of them, and the same failure mode applies
to every one — a policy or trigger changed in the SQL Editor is just as
invisible to a rebuild as a function body. A follow-up pass should extend this
comparator to `pg_get_triggerdef`, `pg_policies` and `pg_indexes`.

## Reproducing this

```sql
-- live side
SELECT p.proname,
       md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) AS body_md5,
       length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) AS body_len
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
 ORDER BY 1;
```

Repo side: for each migration in filename order, extract the text between the
dollar-quote delimiters of every `CREATE [OR REPLACE] FUNCTION public.<name>(`,
keep the last per name, normalise identically, md5.

The six loyalty-lot function bodies as captured are in this directory, each with
its own `pg_get_functiondef` md5 in the header so the capture can be re-verified
against live at any time.
