# Git workflow — Hub repo (la-tracking)

Companion to the "Git Workflow — NON-NEGOTIABLE" section of CLAUDE.md, which keeps the rules; this file holds the rationale and history that were moved out of it.

## Rules moved from CLAUDE.md (2026-10-02, verbatim)

Moved out of CLAUDE.md on 2026-10-02 to keep it under 100 KB. Text is verbatim (only the 2-space CLAUDE.md indent removed); CLAUDE.md keeps the one-line rules and a pointer here.

### History — this replaces the previous direct-to-main rule

This replaces the previous rule ("commit and push all changes directly to
main"), which is why `main` used to be edited directly throughout this file's
history. The same workflow is in force on the storefront repo
(`chajewels/cha-jewels-web`); the two now match.

### THE LOVABLE EXCEPTION — why it is accepted

Lovable mirrors `main` and commits its own work to `main`. It does not use
`develop` and cannot be made to. **This is accepted, not a gap**, because
Lovable only touches the repo when Cynthia approves a message — the human
review that a PR would otherwise provide happens before the message is sent,
not after the commit lands. In effect an approved Lovable message *is* the
review.

### MIGRATIONS MUST BE ON main — why

Lovable deploys and applies migrations from its mirror of `main`. A migration
sitting on `develop` is invisible to it, and an apply message naming a file
Lovable cannot see fails its own source assertions — which is the intended
behaviour, not a bug to work around by weakening the assertions.

### ONE SENDER — why this is a rule (2026-09-11 double send)

Why this is a rule: on 2026-09-11 the transfer_payment_methods message went to
Lovable twice — once from Claude chat at 11:34 UTC and once from Claude Code at
12:51 UTC. Both runs were idempotent by construction (CREATE TABLE IF NOT
EXISTS, copy skipped when populated), so nothing broke, but the second run's
report misattributed the two bank rows Cynthia had entered in between to the
migration's copy block, and it cost an hour of untangling. Two senders means
two mirrors of the truth; one sender means one.

### DEPENDENCIES ARE FROZEN — the 2026-10-03 incident (three re-adds in one day)

**What happened.** Lovable's own tooling added `@lovable.dev/email-js` (and companions) to
package.json / bun.lock three times in 24 hours, none from a prompt:
`6aa374ca` (restored by #327), `7ccfe5c9` 09:42 JST (restored by #338 → release #339, which also
removed the drizzle scaffold), and `698ba021` minutes after the verify-portal-pin deploy —
that one came from Lovable's preview-build fixer reacting to a preview error (restored by #344 →
release #345). Each time `npm install` failed with ERESOLVE (`@react-email/render` 2.1.0 vs
email-js peer ≥1.0.0) and CI went red until the files were put back.

**What now stops it.**
1. `.github/workflows/package-guard.yml` + `.github/package-guard.sha256`: CI fails any change to
   package.json / bun.lock / drizzle / prisma unless the PR is a `deps:` PR that updates the hash.
2. CLAUDE.md TOOL OWNERSHIP RULES: "DEPENDENCIES ARE FROZEN".
3. Lovable **project knowledge** (set 2026-10-03, was empty before) carries the same rule in the
   agent's own context, with the explicit instruction to STOP and report a dependency-related
   preview error instead of fixing it.
4. Every Lovable message keeps the line: *do not install, add or change packages, package.json or
   bun.lock — even if the preview errors.* The first message with that wording (the 10-function
   PIN deploy) was the first deploy of the day Lovable did not follow with a package commit.

**Check after every Lovable commit to main:** `git show --stat <sha> | grep -E 'package|bun.lock'`
must print nothing.

**Every migration APPLY does it anyway.** Lovable's `lov_database--migration` tool commits
drizzle-kit / drizzle-orm / postgres to package.json + bun.lock, plus drizzle.config.ts and a
drizzle/ copy of the migration, on every apply — even when the message says not to
(2026-10-03 b558a3ac → reverted aa3645a3 #355/#356; 2026-10-04 bdc42eb8/fc360ab8 → reverted
c78dfbbd). Expect it after every apply: restore package.json + bun.lock from the release
commit (checksums must match .github/package-guard.sha256), `git rm -r drizzle.config.ts
drizzle`, KEEP the regenerated src/integrations/supabase/types.ts, and release the revert in
the same session, after any follow-up deploy has finished.

### A TRANSPORT TIMEOUT IS NOT A LOST MESSAGE (2026-10-03, second duplicate)

The 36-function deploy message of 15:44 JST timed out at the MCP transport after
180 s. The queue was checked (last message was still the 14:44 read-only one),
so it was sent once more with `wait=false` at 15:44:18 — and the "lost" original
then arrived at 15:53:07, nine minutes late, queued behind the completed run.
Lovable's agent recognised it as a duplicate, re-ran the 20 assertions read-only
and refused to redeploy, citing the project-knowledge rule. No harm, but the
rule is now stricter:

- After a transport timeout, WAIT at least 10 minutes and check the queue again
  before any resend. A message can land long after the client gives up.
- Send long Lovable messages with `wait=false` and poll with get_message; a
  36-function deploy takes ~7 minutes, longer than the 180 s transport cap.
- Lovable's mirror lagged main by the whole release (#351): the agent had to
  pull the 34 function files from origin/main before the assertions passed.
  That is the "mirror can lag" rule working as designed — the assertions are
  what made it visible.
