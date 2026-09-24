<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## LOYALTY GOOGLE SHEET SYNC TAXONOMY — NON-NEGOTIABLE (added 2026-05-16)

Canonical event_type values consumed by sync-loyalty-to-sheet:

  Members tab events:      enrolled, tier_changed, status_changed, admin_edited
  Transactions tab events: earned, bonus, redeemed, expired, adjusted, refunded, revoked, birthday_bonus

Caller responsibilities:
  - join-loyalty-program       → emits enrolled
  - award-loyalty-points       → emits earned + bonus (if promo) + tier_changed (if upgrade)
  - process-loyalty-redemption → emits redeemed (approve), revoked (void)
  - loyalty-inactivity-check   → emits expired, tier_changed (downgrade), status_changed (if wired)

Forbidden:
  - Any caller sending event_type values outside this taxonomy
  - Emission without member_id in the payload
  - Sync calls that block the parent function's return (must remain fire-and-forget)

Sheet ID location: system_settings.loyalty_sheet_id (configured via Loyalty Settings UI).

### Sync function implementation (live as of 2026-05-16)

- sync-loyalty-to-sheet/index.ts writes rows in real-time to the Sheet configured in system_settings.loyalty_sheet_id.
- Sheet tabs: Members (11 cols) and Transactions (13 cols). Column order is locked — see headers in row 1 of each tab.
- Authentication: getServiceAccountAccessToken() from _shared/google-auth.ts (same SA as invoice generator).
- Activity Status (Members tab Col I): derived from last_purchase_at — null or <90 days = "Active", ≥90 days = "Inactive".
- PHT timestamps (Col A both tabs): formatted via Intl.DateTimeFormat with timeZone 'Asia/Manila'.
- Real-time only in v1. loyalty_sheet_sync_frequency setting is informational only; the function ignores it and writes every event immediately.
- Append endpoint: spreadsheets.values.append (NOT batchUpdate) — sheet auto-finds next empty row.
- Graceful skip: if loyalty_sheet_id is empty in system_settings, function returns { disabled: true } without erroring.

Forbidden:
- Modifying sheet column order without coordinated header update in the actual Google Sheet
- Calling sync-loyalty-to-sheet with event_type outside the canonical taxonomy
- Removing the activity_status derivation (Members Col I depends on it)


## SHEET SYNC ARCHITECTURE — NON-NEGOTIABLE (added 2026-06-05)

The Google Sheet backup (configured via `system_settings.loyalty_sheet_id`)
mirrors every `loyalty_transactions` row through two complementary paths.
This architecture exists because Bug #163's catch-up revealed that any
non-fast-path write (SQL RPC backfill, direct INSERT, migration, emission
failure) silently bypassed the sheet — leaving permanent gaps in the
backup that nothing reconciled.

**Fast path — synchronous, ~1 second latency.**
- `award-loyalty-points` (and any future writer to `loyalty_transactions`)
  POSTs to `sync-loyalty-to-sheet` via inter-function HTTP immediately
  after each row insert. On 200 response, the writer marks
  `loyalty_transactions.synced_to_sheet_at = NOW()` on the row it just
  inserted.
- Covers natural awards triggered by `review-payment-submission` (the
  steady-state production path).

**Recovery path — async, hourly catch-up via pg_cron.**
- `loyalty-sheet-reconcile` edge function queries
  `loyalty_transactions WHERE synced_to_sheet_at IS NULL` within a 30-day
  window, fans out to `sync-loyalty-to-sheet` per row, marks synced on
  success. Returns `{processed, succeeded, failed, remaining}` summary.
- Catches: SQL backfills, direct INSERTs, migrations, any emission failure
  in the fast path, future writers that forget to set the marker.
- pg_cron jobid 21, schedule `7 * * * *` (hourly at :07 UTC), Vault-backed
  auth pattern (`email_queue_service_role_key`).

**Locked invariants:**

1. **Every `loyalty_transactions` row eventually reaches the Google Sheet.**
   Within ~1 second for natural awards (fast path), within ~1 hour for
   everything else (recovery path).

2. **`synced_to_sheet_at` is write-once.** NULL → timestamp; never flips
   back to NULL. Resync requires deliberate operator action (UPDATE the
   column to NULL on specific rows to force re-emission).

3. **`loyalty-sheet-reconcile` is intentionally unauthenticated.** Matches
   `sync-loyalty-to-sheet`'s pattern (the function it fans out to). Risk
   surface is minimal: only emits already-existing data and writes a
   metadata column. Strong auth (env-equality, JWT decode) would break
   the Vault-backed cron pattern because Supabase's `sb_secret_*`
   key-format rollout produces a runtime env value that diverges from any
   Dashboard- or Vault-stored copy.

4. **`award-loyalty-points` retains strict env-equality + admin/finance
   user-fallback auth.** It modifies customer point balances — different
   risk profile than the read-mostly reconciler. The auth pattern there
   stays per Bug #163.

5. **Schema:** `loyalty_transactions.synced_to_sheet_at timestamptz`,
   nullable, no default. Partial btree index
   `idx_loyalty_transactions_unsynced` on `(created_at) WHERE
   synced_to_sheet_at IS NULL` keeps the unsynced lookup tiny in
   steady-state.

6. **Event-type routing in the reconciler** mirrors
   `sync-loyalty-to-sheet`'s canonical taxonomy:
   - Transactions-tab events (8): `earned`, `bonus`, `redeemed`, `expired`,
     `adjusted`, `refunded`, `revoked`, `birthday_bonus`
   - Members-tab events sourced from `loyalty_transactions` (2):
     `tier_changed`, `enrolled`
   - Members-tab events NOT in `loyalty_transactions` (`status_changed`,
     `admin_edited`): out of scope for this reconciler. Phase 2 if needed.

**Operator references:**
- Reconciler source: `supabase/functions/loyalty-sheet-reconcile/index.ts`
- Cron entry: `cron.job WHERE jobname = 'loyalty-sheet-reconcile'`
- Manual trigger via SQL Editor uses the same Vault pattern as the cron
  (see `docs/LOYALTY-LIFECYCLE.md` for the snippet, once that doc is
  updated)
- Incident context: see `docs/FIXED-BUGS.md` Bug #163 entry, including
  the architecture rationale in the Resolution & catch-up notes

