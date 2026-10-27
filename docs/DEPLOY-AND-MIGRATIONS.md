# Deploy Verification & Migrations

Moved verbatim from CLAUDE.md on 2026-10-28 (Option A split); CLAUDE.md keeps a one-line pointer and every money rule.

## GENERATED FILES & DEPLOY VERIFICATION — NON-NEGOTIABLE

  - src/integrations/supabase/types.ts is SUPABASE-AUTO-GENERATED. Lovable
    regenerates it on every edge-function deploy. NEVER hand-edit it. After a
    schema change the new types arrive on Lovable's next push. Hand-editing it
    caused a CI failure (TS2300/TS2717) this session — if a type is missing, cast
    at the call site instead.
  - LOVABLE'S REPO MIRROR CAN LAG GITHUB. A Lovable "deployed successfully" does
    NOT prove it deployed main's tip. Every edge-function deploy prompt MUST
    assert on SOURCE CONTENT (e.g. `grep -c "<a string unique to the new code>"
    <file>` plus the file's line count) BEFORE deploying, and STOP if it fails. A
    lagging mirror silently shipped a stale build this session.
  - AN ASSERTION MUST TEST CODE, NOT PROSE. Every grep in a Lovable message is
    re-run against the file with all comment lines stripped; if the count moves,
    the pattern is matching an explanatory comment and must be rewritten to a
    form that discriminates (anchor it, e.g. `^function foo`, or include
    punctuation only code has). Three of eleven candidates failed this test on
    2026-09-15 and four did on 2026-09-14. Also require each count to DIFFER from
    the pre-release main: an assertion that passes identically before and after
    proves nothing about the deploy.
  - AN ASSERTION NOBODY CAN SATISFY IS WORSE THAN NO ASSERTION (2026-09-15, third
    occurrence): ask only for what the agent can observe with the access it has
    (the deployed function body, version, timestamp), never a synthesised user
    journey; proof that needs a human in a browser goes to the owner's own
    acceptance run. Full text and the three incidents: docs/LOVABLE-VERIFICATION.md
    "Rules moved from CLAUDE.md".

## Migrations baseline & FUNCTION CHANGES — NON-NEGOTIABLE

  Full text (baseline description, the Bug #280 incident, drift-audit census):
  docs/MIGRATIONS.md (moved verbatim 2026-09-24).

  - supabase/migrations/ holds the 2026-07-05 live-introspected baseline plus
    later migrations; supabase/migrations-archive/ is history only. LIVE is
    authoritative. NEVER push the baseline to live (db push / migration up).
    New schema changes are NEW migration files; never edit the baseline.
  - Every migration version (14-digit prefix) must be unique:
    `ls supabase/migrations | cut -c1-14 | sort | uniq -d` prints nothing.
  - FUNCTION CHANGES START FROM LIVE (Bug #280):
    1. Never rebuild a function body from the repo. Start from
       pg_get_functiondef on live. Prefer an md5-guarded in-place patch; for a
       full replace, reconstruct with your edits reversed and require its md5 to
       equal live before writing the migration.
    2. A SQL Editor change to a function body gets a record-only migration in
       the same session.
    3. Run scripts/function-drift-audit before any migration that redefines a
       function; all three buckets (a_differs, b_live_only, c_repo_only) must
       stay 0.
  - After any DROP + CREATE FUNCTION, re-assert its REVOKE/GRANT in the same
    migration (the default ACL grants PUBLIC; 2026-09-24).
  - RLS policies call auth.uid() / is_staff() / has_role() inside a scalar
    sub-select — (SELECT is_staff((SELECT auth.uid()))) — never bare (a bare
    call runs once per row; 8 s timeouts, 2026-09-29, PR #265).
  - STRUCTURE (2026-10-09, F2): scripts/structure-drift-audit (query on live, replay
    locally, compare) must report 0 on all ten kinds; drift is fixed by a guarded
    RECORD-ONLY migration read from live. docs/MIGRATIONS.md "Structure catch-up".
  - A SECURITY DEFINER function callable by `authenticated` MUST check its caller first
    (`PERFORM public.assert_staff_caller([permission])` or its own guard): customers are
    `authenticated` too (2026-10-09, docs/FIXED-BUGS.md "Staff-only report and allocation functions").
  - Every view in public is created WITH (security_invoker = true); a view
    owned by postgres without it bypasses RLS (schedule_with_actuals leak,
    2026-09-29, PR #266).
