<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## Migrations baseline (2026-07-05)

`supabase/migrations/` now holds a single live-introspected baseline:
`20260705230000_baseline_live_schema.sql`. It was generated on 2026-07-05
directly from the live Postgres catalogs (pg_type/pg_enum, pg_class,
pg_attribute, pg_constraint, pg_proc via `pg_get_functiondef`, pg_trigger via
`pg_get_triggerdef`, pg_indexes, pg_policies, pg_publication_tables, and
`information_schema.routine_privileges`) and captures the full public-schema
DDL: extensions, enums, tables + constraints, foreign keys, functions, views,
triggers, indexes, RLS + policies, function EXECUTE grants, and the realtime
publication. All 12 live cron jobs are captured as cron.schedule() statements (extracted from cron.job via the SQL Editor, 2026-07-05).

The 100 pre-baseline migration files are archived in
`supabase/migrations-archive/` (filenames preserved). They are kept for
historical reference only and are NOT applied by any tooling — Supabase CLI
reads `supabase/migrations/` exclusively.

### A SQL EDITOR CHANGE THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD — NON-NEGOTIABLE (added 2026-09-17, Bug #280)

**Before replacing any function body, diff it against LIVE — `pg_get_functiondef`
— never against the baseline.** "No later migration redefines this function" is
a statement about the repo. It is not evidence about what live runs, because
the SQL Editor is a sanctioned write path (TOOL OWNERSHIP RULES) whose changes
leave no trace in `supabase/migrations/`.

This cost a real customer's points ledger. `approve_redemption_atomic` was
wired to `consume_lots_fifo` in the SQL Editor on 2026-07-05 and never
committed; the baseline generated the same day does not contain it. On
2026-09-12 a migration rebuilt that function "verbatim from the live baseline …
no later migration redefines this function" — true, and wrong — silently
reverting live to a body with no lot consumption and leaving
`consume_lots_fifo` with zero callers. Every redemption after it debited the
counter and left the lots behind. The tell was available the whole time: the
same baseline is also missing `restore_lots_for_redemption` from
`void_redemption_atomic`, yet live void still calls it — because nothing ever
rebuilt void. See docs/FIXED-BUGS.md #280.

The check is one query, and it is cheap:

    SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '<fn>';

Reconstruct the body you are about to ship with your own edits reversed, md5 it,
and require the two to match before you write the migration. Any difference is
live carrying something the repo has never seen — stop and find out what it is.
The corollary: **when a SQL Editor change alters a function body, commit it as a
migration in the same session**, even though the general rule is that SQL is not
committed unless asked. A function body is not data; it is code that the next
rebuild will overwrite.

The LIVE DB remains authoritative. The baseline reflects live state at the
moment of generation but is NOT a replacement for it — NEVER push the
baseline to the live project (`supabase db push`, `supabase migration up`, or
equivalent). Migration-history mismatch against live is expected and
irrelevant. Purpose: faithful fresh rebuilds (local dev, staging bootstrap)
and an in-repo source of truth. Any future schema change to the live DB must
be added as a NEW migration file in `supabase/migrations/` alongside the
baseline (do not edit the baseline in place).

Every migration version (the 14-digit prefix) must be unique. Before adding a
migration, run: `ls supabase/migrations | cut -c1-14 | sort | uniq -d` — it must
print nothing.

### FUNCTION CHANGES START FROM LIVE — NON-NEGOTIABLE (added 2026-09-17, Bug #280)

The repo is a RECORD of the database's functions. It is not the definition of
them. Three rules follow, and none of them is optional.

**1. Never rebuild a function body from the repo.** Not from the
`20260705230000` baseline, not from an earlier migration, not from a snapshot in
`docs/sql/`. Start from what live actually runs:

    SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '<fn>';

Where the change is small, prefer an **md5-guarded in-place patch** over a
`CREATE OR REPLACE` of the whole body: assert the live md5 first and abort if it
has moved, so a body that changed under you stops the patch instead of being
silently overwritten. Where a full replace is unavoidable, reconstruct the
intended body with your own edits reversed, md5 it, and require it to equal live
before writing the migration. Any difference means live carries something the
repo has never seen — stop and find out what.

**2. A SQL Editor change to a function body gets a record-only migration in the
same session.** This is the corollary above, restated because it is the step
that keeps getting skipped. A record-only migration is a plain
`CREATE OR REPLACE` of the body exactly as live has it, headed with the capture
timestamp, the md5 and the reason; replaying it is a no-op. Reference files:
`20260917070050_record_live_loyalty_fixes.sql`,
`20260917070100_record_live_only_functions.sql`,
`20260917070200_record_live_drifted_functions.sql`.

**3. Run the drift audit before writing any migration that redefines a
function.** `scripts/function-drift-audit` prints a read-only SQL query; paste it
into the SQL Editor. Zero rows means live and the repo agree about every
function. Its three buckets:

    a_differs     same name, different body  — the repo will revert live
    b_live_only   live has it, the repo does not — a rebuild loses it entirely
    c_repo_only   the repo has it, live does not — a dropped function still recorded

The comparator is `pg_proc.prosrc` with whitespace collapsed, NOT
`pg_get_functiondef`: the latter canonicalises headers and reports drift on
every hand-written migration. Comment-only differences are real rows and are
worth clearing anyway — a body that differs at all is a body nobody can diff at
a glance.

The full census on 2026-09-17 found **17 (a) + 15 (b) + 2 (c)**. All 32 live
bodies are now recorded and all three buckets are 0. Keep them there.


Known pre-existing quirk (NOT from this work): fc_cohort_timeline.collection_rate
can exceed 100% because actual_collected includes downpayment while
expected_collected excludes it. Drives a noisy quality-degradation alert.
Separate ticket if undesired.

