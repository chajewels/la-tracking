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
