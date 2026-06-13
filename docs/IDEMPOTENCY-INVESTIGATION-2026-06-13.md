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
