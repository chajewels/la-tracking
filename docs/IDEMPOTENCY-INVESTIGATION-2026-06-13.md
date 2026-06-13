# Idempotency Investigation — review-payment-submission + award-loyalty-points

Date: 2026-06-13. Code state: post-`2910c55`.

Read-only investigation of two idempotency questions. No code modified.

---

## Question 1 — Totals double-increment (invoices 18437, 19090, 2026-06-11)

### Exact call-order in the layaway confirm path

`review-payment-submission/index.ts`, when `action === "confirmed"` and the submission carries an `account_id` (layaway path):

1. **No status idempotency guard.** Cash path has one at L631:
   ```ts
   if (submission.status === "confirmed" && submission.confirmed_payment_id) {
     return new Response(... "Submission already confirmed" ..., 400);
   }
   ```
   **The layaway path does not have an equivalent guard anywhere before the writes.** It proceeds straight to `allocatePaymentToAccount(...)` at L1075 (single-submission DP / installment) or L1157 (multi-account split, per allocation).

2. **`allocatePaymentToAccount` execution order** (`review-payment-submission/index.ts:143-476`):
   - L298–L390 — INSERT into `payments` (the new payment row).
   - L391+ — INSERT `payment_allocations` rows (for installment payments; DP payments skip this per L182).
   - L401+ — UPDATE `penalty_fees.status` for any fully-paid penalties.
   - L411+ — UPDATE `layaway_schedule.paid_amount` and `status` for affected rows.
   - L421–L446 — **Re-derive** totals: `total_paid = SUM(payments.amount_paid WHERE voided_at IS NULL)` (NOT `prev_total + new_amount`); remaining_balance = `total_amount + active penalties − total_paid`.
   - L470–L473 — UPDATE `layaway_accounts.total_paid`, `remaining_balance`, `status`.

3. **After `allocatePaymentToAccount` returns**, the caller at L1075/L1157 UPDATES the `payment_submissions` row to `status = 'confirmed'` and writes the audit log. **This is the FIRST and ONLY status flip — and it happens AFTER the payment INSERT and totals UPDATE.**

### Why totals math itself can't double-increment a single payment

Every site that writes `total_paid` in the entire codebase derives the value from `SUM(payments.amount_paid WHERE voided_at IS NULL)`:

- `review-payment-submission/index.ts:429-430, 446`
- `record-payment/index.ts:326-339` ("SINGLE SOURCE OF TRUTH: derive total_paid from SUM of all confirmed payments (not from stored account.total_paid which may be stale)")
- `fix-account-totals/index.ts:245` ("total_paid = SUM(actual non-voided payments) — INVARIANT 1")
- `fix-account-status/index.ts:151`
- `record-multi-payment/index.ts:269` uses `acct.total_paid + amountForAccount` **for the preview response only** — never written back; the actual write happens via the SUM-derived path.

There is no `total_paid += X` or `UPDATE … SET total_paid = total_paid + X` anywhere in `supabase/functions/`. **A double-increment cannot arise from the totals math itself** — it always re-reads the source of truth.

### The precise interleaving that produces "1 payment + 2× total_paid"

Given the math above, the ONLY mechanism that fits the symptom is **two confirm invocations running concurrently against the same `submission_id`, both passing the (missing) layaway idempotency guard, both reaching the payment INSERT, then ONE of those payments being voided / deleted before the user inspects the rows but AFTER both UPDATEs ran:**

```
T0  Call A: read submission.status='submitted'        (passes — no guard)
T1  Call A: SUM(payments) = T                          (snapshot)
T2  Call A: INSERT payment P1, amount=$X               → 1 payment row
T3  Call A: UPDATE total_paid = T + $X                 (1st increment)
T4  Call B: read submission.status='submitted'        (still 'submitted'; A hasn't flipped yet)
T5  Call B: SUM(payments) = T + $X                     (sees P1 now)
T6  Call B: INSERT payment P2, amount=$X               → 2 payment rows
T7  Call A: UPDATE submission.status='confirmed'      ← here is when the flip lands
T8  Call B: UPDATE total_paid = T + 2$X                (2nd increment)
T9  Call B: UPDATE submission.status='confirmed'      (idempotent overwrite, no-op effectively)
T10 [later] One of P1/P2 voided manually or by a sweep → DB now shows 1 payment, total_paid = T + 2$X
```

There is no `UNIQUE (payment_submission_id)` or similar constraint on `payments` that would block step T6. The submission-status flip at T7 is the only thing that would have stopped B if it had been checked again — but B's status read happened at T4 before T7.

**For the symptom to manifest as "ONE payment", a manual void/delete had to follow the race.** If no manual cleanup happened, the symptom is "TWO payments + 2× total_paid" and they would have shown up identically in pre-aaca9cd Payment Vault. Worth confirming on 18437 / 19090: are there two payment rows for that submission with the same `submitted_amount` / `date_paid`, one of which is voided? If yes, the interleaving above is the explanation.

### Could the same submission be confirmed twice by retry / timeout?

Yes — there is no protection. Specifically:

- The reviewer can click "Confirm" twice before the first response arrives.
- A network timeout on the reviewer's side can trigger a retry while the first invocation is still mid-execution.
- The Bug #220-era duplicate-submission soft block (now via `insert_payment_submission_guarded` RPC) protects against duplicate **submissions**, not duplicate **confirmations** of the same submission.

### Recommended fix (do not implement here)

Mirror the cash-path guard at the start of the layaway confirm branch:

```ts
if (action === "confirmed" && submission.account_id) {
  if (submission.status === "confirmed" && submission.confirmed_payment_id) {
    return new Response(JSON.stringify({
      error: "Submission already confirmed",
      confirmed_payment_id: submission.confirmed_payment_id,
    }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  // ... rest of layaway confirm flow
}
```

Plus a `payment_submissions.confirmed_payment_id` column on the layaway side (cash has it; layaway uses `confirmedPaymentIds` array in scope but doesn't persist it) — required to make the guard actually catch a duplicate. Or simpler: just check `submission.status !== 'submitted'` and bail if not — that closes the race without needing the column.

Even with the early-return guard, the T0→T4 read window is still race-able. Defense in depth would add a **conditional UPDATE** at the top of the confirm flow:

```ts
const { data: claimed, error: claimErr } = await supabase
  .from("payment_submissions")
  .update({ status: 'under_review' })
  .eq('id', submission_id)
  .eq('status', 'submitted')         // ← row-level CAS guard
  .select('id')
  .maybeSingle();
if (claimErr || !claimed) {
  return new Response(... "Already being reviewed or confirmed" ..., 409);
}
```

This makes the status flip atomic with the read — Postgres serializes the UPDATE, so only ONE of two concurrent calls wins.

---

## Question 2 — Award guard scope (split-DP, 54s apart, invoice 19031)

### Current guard (`award-loyalty-points/index.ts:175-189`)

```ts
{
  let existsQuery = supabase
    .from("loyalty_transactions")
    .select("id")
    .eq("transaction_type", "earned");
  if (sourceKind === "layaway") {
    existsQuery = existsQuery.eq("account_id", account_id!);
  } else {
    existsQuery = existsQuery.eq("cash_order_id", cash_order_id!);
  }
  const { data: existingEarned } = await existsQuery.limit(1).maybeSingle();
  if (existingEarned) {
    return json({ skipped: true, reason: "already_awarded" });
  }
}
```

### Guard scope — KEYED ON `account_id` / `cash_order_id`, NOT on invoice or payment

For layaway: the guard checks whether ANY `loyalty_transactions` row of type `earned` exists for this `account_id`. **One account = one award, period.** Per-payment or per-invoice distinction is irrelevant for the guard — the second invocation against the same account will be blocked.

For cash: same shape, keyed on `cash_order_id`.

### Would the current guard block the 19031 split-DP scenario?

**Yes.** Both DP submissions on invoice 19031 belong to the SAME `account_id` (one layaway account per invoice). So:

- **First confirm at T:** award-loyalty-points called with `{account_id: A}`. `existingEarned` is null → award proceeds, INSERTs an `earned` transaction with `account_id=A`.
- **Second confirm at T+54s:** award-loyalty-points called with `{account_id: A}` again. `existingEarned` finds the row from step 1 → returns `{skipped:true, reason:"already_awarded"}`.

The 54-second gap is plenty for the first transaction to be committed and visible. The guard is effective at this gap. It would even be effective at a much shorter gap, provided the first INSERT commits before the second SELECT executes — which is the normal case.

### Race window remaining

The guard is a SELECT-then-INSERT pair without a transaction or unique constraint. A near-simultaneous double-confirm (sub-millisecond gap, two concurrent invocations) could both pass the SELECT before either INSERT commits, then both INSERT. That window is much narrower than 54 seconds but not zero. Closing it requires either:

- A `UNIQUE` constraint on `loyalty_transactions (account_id, transaction_type)` filtered to `transaction_type='earned'` — PostgreSQL allows partial unique indexes for this.
- Or wrapping the SELECT+INSERT in a transaction with `SERIALIZABLE` isolation.
- Or using `INSERT ... ON CONFLICT DO NOTHING` against the same partial unique index — gives both atomicity and a clean "already awarded" signal without the SELECT round-trip.

### When was the guard introduced

`git log -S"already_awarded" -- supabase/functions/award-loyalty-points/index.ts` shows the first commit introducing the string is **`4833407` (2026-06-07)** — the same security hardening batch that broke Bug #223. The guard was added together with the parseJwtClaims service-role check.

This is significant for the 19031 incident: the double-award on 2026-05-20 happened **BEFORE the guard existed**. The guard would block the same incident today. The historical incident is not a current bug.

### Recommended fix (do not implement here)

The guard works at the 54-second gap reported in the 19031 incident. Two further hardening options for the millisecond-race tail:

1. **Partial unique index (preferred)** — `CREATE UNIQUE INDEX uniq_loyalty_earned_per_account ON loyalty_transactions (account_id) WHERE transaction_type = 'earned' AND account_id IS NOT NULL;` plus the equivalent for `cash_order_id`. Lets PostgreSQL enforce the invariant; INSERT becomes `INSERT … ON CONFLICT DO NOTHING RETURNING id` and the function can detect the no-rows case to return `already_awarded`.

2. **Advisory lock on (account_id, transaction_type)** at the top of the function — bracket the entire award flow inside `pg_advisory_xact_lock(hashtext('award:layaway:'||account_id::text))` so concurrent invocations serialize through the lock. Pattern matches the `insert_payment_submission_guarded` RPC's lock approach.

Option 1 is structurally stronger (DB-enforced invariant) and survives any future code paths that bypass the function. Option 2 is purely behavioral and only protects this function.

---

## Summary

| Question | Finding | Current state | Recommended |
|---|---|---|---|
| Totals double-increment | No incremental write anywhere; **but no idempotency guard on the layaway confirm path**, unlike cash. Concurrent confirms can both pass the (missing) guard, INSERT two payments, both UPDATE total_paid. The "ONE payment" half of the symptom requires a manual void afterwards. | Layaway path missing the guard the cash path has at L631 | Add a `submission.status !== 'submitted'` early-return guard at the top of the layaway confirm branch, plus a conditional `UPDATE … WHERE status='submitted'` CAS-style claim that closes the read window. |
| Award guard scope (split DP / 54s) | Guard is keyed on `account_id` / `cash_order_id` (not invoice or payment), so the same account can only earn once. The 19031 incident pre-dates the guard (introduced 4833407, 2026-06-07). The guard would now block the same scenario at the 54-second gap and at much shorter gaps. | Working at any human-timescale gap. Millisecond-race window still exists. | Partial unique index on `loyalty_transactions(account_id) WHERE transaction_type='earned'` (and equivalent for cash_order_id), with `INSERT … ON CONFLICT DO NOTHING`. Closes the race at the DB level and survives any future bypass. |

No code modified. No commit beyond this report file.

---

## Follow-up — answering the four specific questions (2026-06-13, post-audit_logs)

### Q1 — Which function/code path writes account totals at SUBMISSION time?

**Answer: none in the repo.** The user's premise that `total_paid = SUM(confirmed payments) + SUM(pending submissions)` is written at submission time does NOT appear in any edge function or committed SQL migration:

- `supabase/functions/submit-payment/index.ts` writes only `payment_submissions` + (for single-payment) `payment_submission_allocations`. Zero `total_paid` mutations. Verified by `grep -n "total_paid\|layaway_accounts" submit-payment/index.ts` — every `.from("layaway_accounts")` call is a SELECT of `invoice_number`, never an UPDATE.
- `supabase/functions/submit-cash-payment/index.ts` — same shape: submission-only writes.
- `supabase/functions/record-payment/index.ts` and `record-multi-payment/index.ts` — POST Bug #219 (commit `b2a7cb1`, universal-submission redesign) the layaway path of both writes ONLY a `payment_submissions` row. No `total_paid` write at submission time.
- `grep -rn "total_paid" supabase/migrations/*.sql` returns 7 files; **none** include `submitted_amount` or `payment_submissions` in the same SQL function/trigger body. No `BEFORE/AFTER INSERT ON payment_submissions` trigger committed to the repo touches `layaway_accounts.total_paid`.

If the audit_log evidence shows `total_paid` going up at submission time, the mechanism is **NOT in this repo**. Most likely culprits to check outside the repo:
- A DB trigger applied directly via the Supabase SQL Editor that was never committed as a migration.
- A SECURITY DEFINER RPC referenced from a code path I haven't found (I greped `supabase.rpc(` in both functions — neither calls any RPC during submission).

**Recommendation before fixing:** dump the live DB triggers on `payment_submissions` and the live functions in `public` to confirm what's actually running. CLAUDE.md "TOOL OWNERSHIP RULES" notes Cynthia owns SQL Editor access; she can run:
```sql
SELECT tgname, tgrelid::regclass, pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgrelid = 'public.payment_submissions'::regclass AND NOT tgisinternal;

SELECT proname, pg_get_functiondef(oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND pg_get_functiondef(oid) ILIKE '%submitted_amount%' AND pg_get_functiondef(oid) ILIKE '%total_paid%';
```

### Q2 — review-payment-submission layaway-confirm order — exact quotes

```
Layer 1: review-payment-submission/index.ts:1075
    const result = await allocatePaymentToAccount(supabase, submission.account_id, ...)

Layer 2 (inside allocatePaymentToAccount, file lines):
    L298+   INSERT into "payments"                            ← new payment row
    L391+   INSERT into "payment_allocations" (installment)
    L401+   UPDATE "penalty_fees".status (per fully-paid fee)
    L411+   UPDATE "layaway_schedule".paid_amount + status
    L424–446  RECOMPUTE: const totalPaidFromPayments =
              SUM(payments.amount_paid WHERE voided_at IS NULL)  ← reads payments
    L470–473  UPDATE "layaway_accounts".total_paid, remaining_balance, status

Layer 3 (back in caller):
    L1248–1252 UPDATE "payment_submissions".status = 'confirmed'   ← FIRST status flip
```

**Confirmed:** the recompute at L424–446 executes BEFORE the submission status flip at L1248. At the moment of the recompute, the `payment_submissions` row IS still in `'submitted'` status. The user's order claim is correct.

**However:** the recompute formula visible at L424–446 reads STRICTLY from `payments WHERE voided_at IS NULL`. It does NOT include `submitted_amount` of pending submissions. So the doubling cannot arise from the edge-function recompute itself.

For the audit-log-observed doubling to occur via the order described in the prompt, an OUTSIDE-THE-REPO mechanism (trigger or RPC) must be applying the "+ SUM(pending submissions)" addition somewhere between the payment INSERT at L298 and the status flip at L1248. The most plausible candidates:

- An `AFTER INSERT ON payments` trigger that recomputes `total_paid = SUM(payments) + SUM(pending submissions)`. Would fire right after L298 and double-count because the submission is still 'submitted'. Q1 above documents how to confirm.
- An `AFTER UPDATE ON payment_allocations` or `AFTER UPDATE ON layaway_schedule` trigger doing the same.
- A SECURITY DEFINER RPC `recompute_account_totals(account_id)` that the trigger or some other code path calls.

### Q3 — Did the ordering or the pending-submission term change in 2026-06-08..2026-06-12?

`git log --since="2026-06-08" --until="2026-06-13" -- review-payment-submission/index.ts submit-payment/index.ts` returns 5 commits:

```
aaca9cd 2026-06-12  loyalty pipeline hardening (Bug #223 hardening — preloadError listener, isCustomerLoyaltyEnrolled trace, lpRes.ok at 3 award sites)
62a049f 2026-06-12  customer name + invoice in award bell notifications
85ff208 2026-06-12  identify customer + invoice on FAILURE notifications
233fefc 2026-06-12  format-proof service-role detection (isServiceRole helper)
5852cc3 2026-06-12  surface 6 matrix keys + normalize 3 edge functions to shared checkPermission
```

Filtering the diffs of all five commits for the strings `total_paid|submitted_amount|pending|SUM.*payment|verifiedTotalPaid|allocate`:

```
git log -p --since="2026-06-08" --until="2026-06-13" -- supabase/functions/review-payment-submission/index.ts \
  | grep -E "^[+-]" | grep -iE "total_paid|submitted_amount|pending|SUM.*payment|verifiedTotalPaid|allocate"
→ (no output)
```

**Zero changes to the layaway totals recompute, the call order, or the pending-submission term in review-payment-submission during this window.** All five 2026-06-12 commits touched only auth, notification bodies, and loyalty hardening — not the totals path. Same for submit-payment: its only ever commit is `4833407 (2026-06-07)` which introduced layaway_accounts SELECT calls (read-only) for the cash-receipt path; it never wrote `total_paid`.

**Implication for the 2026-04/05 vs 2026-06-11 vs 2026-06-12 dating:**

If the edge functions' totals path has been byte-identical across the window, the variable that changed must be DB-side. The most coherent explanation given the user's framing:

- **Pre-2026-06-11 confirms (18437's April/May confirms):** either the alleged DB trigger didn't exist yet, OR it did exist but a subsequent edge-function recompute overwrote its result with the correct SUM(payments)-only value. The latter happens here at L470–473 — UPDATE writes the function's computed value. So even if a trigger had inflated `total_paid` mid-flow, the function's final UPDATE would overwrite it.
- **2026-06-11 18437/19090 doubling:** if a DB trigger was added between the last clean confirm and 2026-06-11, AND the trigger fires AFTER L470–473 (e.g., `AFTER UPDATE ON layaway_accounts` recursing into a pending-submissions term), the function's clean value gets overwritten by the trigger. This fits the observation.
- **2026-06-12 19115/19120 NOT doubling:** either the trigger was reverted between 2026-06-11 and 2026-06-12, OR the condition that caused it to fire stopped firing.

Without DB access I cannot tell which of those happened. The repo shows no change in the edge functions across the entire 2026-06-08..2026-06-13 window that would explain a doubling that started 2026-06-11 and stopped by 2026-06-12.

### Q4 — Minimal-fix recommendation

Three options, in order of structural strength. **All require either DB-side or edge-side action — without confirming the actual writer of the +pending term, the right fix depends on which layer needs the change.**

**Option A — Repo-side enforcement of "SUM(payments) only":**
Add a clear assertion + audit_log entry at the bottom of `allocatePaymentToAccount` that the value being written matches `SUM(payments WHERE voided_at IS NULL)` exactly, AND drop any DB-side mutation that disagrees (after confirming via the Q1 trigger dump). This is the canonical fix per CLAUDE.md INVARIANT 1 ("total_paid source: ONLY SUM(payments.amount_paid WHERE voided_at IS NULL)"). Closes the bug at the data layer.

**Option B — Status flip BEFORE recompute, in one transaction:**
Reorder the layaway confirm path so the `payment_submissions.status='confirmed'` UPDATE runs BEFORE `allocatePaymentToAccount`. That way any +pending-submissions term in a trigger would see this submission as already-confirmed and not double-count. Requires either an RPC that does both writes atomically, OR a careful re-sequencing with rollback on payment INSERT failure (currently the function rolls forward in the cash path — see L759-781 — the layaway path would need analogous protection). Doesn't fix the underlying invariant violation if a trigger is misbehaving.

**Option C — Conditional UPDATE at top of confirm flow (defense in depth, also closes the concurrent-confirm race from Q1 above):**
```ts
const { data: claimed } = await supabase
  .from("payment_submissions")
  .update({ status: 'under_review' })
  .eq('id', submission_id)
  .eq('status', 'submitted')      // ← row-level CAS guard
  .select('id')
  .maybeSingle();
if (!claimed) {
  return new Response(... "Already being reviewed or confirmed" ..., 409);
}
```
Closes the concurrent-confirm race documented earlier in this report regardless of the totals mechanism, and makes any "+pending submissions" term see the submission as not-pending immediately. The cleanest single-edge-function change. Recommended as the **minimum** even if Option A is also adopted.

**Preferred path:** Run the Q1 trigger/function dump → confirm what writes the +pending term → if a trigger exists, drop it (Option A); if no trigger exists, then the doubling must come from a concurrent-confirm race per my earlier report → adopt Option C. Pursue Option B only if there's a long-term reason to keep the alleged trigger.

No code modified.
