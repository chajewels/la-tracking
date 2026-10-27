# Tool Ownership

Moved verbatim from CLAUDE.md on 2026-10-28 (Option A split); CLAUDE.md keeps a one-line pointer and every money rule.

## TOOL OWNERSHIP RULES (updated 2026-05-10)

  Lovable → src/ AND supabase/functions/ file creation and editing.
            Lovable ALSO handles ALL Supabase edge function
            deployments via direct Supabase Dashboard tooling access.
            Lovable IDE is the ONLY edge-function deploy path; the GitHub
            Actions deploy workflow was removed (it never deployed anything —
            docs/AUTO-DEPLOY.md "Rules moved from CLAUDE.md").
  Claude Code → src/ AND supabase/functions/ editing when explicitly
                directed by Cynthia. Default mode is read-only audit
                and diagnosis. May commit and push to git when asked.
  Cloud Shell → git operations only (pulls, merges, pushes, repo
                audits). Cynthia has NO direct Supabase deployment
                access — NEVER suggest `npx supabase functions deploy`
                from Cloud Shell. If a function appears stale,
                escalate to Lovable to redeploy via Supabase
                Dashboard tooling.
  Supabase SQL Editor → database changes only (pure SQL)

  Practice rules (apply to both Lovable and Claude Code):
  - No prompt written without plan confirmed first.
  - No step executed without explicit go signal from Cynthia.
  - DEPENDENCIES ARE FROZEN: no one, Lovable included, touches package.json,
    bun.lock, drizzle/ or prisma/, not even to "fix preview errors". A change
    is a "deps:" PR updating .github/package-guard.sha256; CI fails all else.
  - SQL changes are applied in the SQL Editor by Cynthia and are NOT
    committed to repo as migrations unless explicitly told to.
    EXCEPTION, and it is not optional: a SQL Editor change that alters a
    FUNCTION BODY is committed as a migration in the same session. Data fixes
    and one-off queries stay uncommitted as before; function bodies do not,
    because the next rebuild from the baseline silently reverts them — see
    "A SQL EDITOR CHANGE THAT IS NEVER COMMITTED…" in docs/MIGRATIONS.md.

  CLAUDE.md is the single source of truth — both Lovable and
  Claude Code must read it before any changes.
