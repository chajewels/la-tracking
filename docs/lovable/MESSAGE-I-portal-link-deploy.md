# Lovable message I — deploy the nine portal-link importers

Status: **SENT 2026-09-15, once, by Claude Code** (`umsg_01m2j2m4hke1bs6s5hecmj4ky9`).
Deploy only, no migrations. Sent after PR #71 merged as `64869a13`, because
Lovable deploys from its mirror of `main` and the module on `develop` is
invisible to it. One sender: Claude Code, from this session. The queue was
checked before sending; a transport timeout is not a failure and is never
answered with a resend.

All six source assertions passed the comment-strip test (identical counts with
every comment line removed) AND differ from the pre-release `main` (`2070e2f8`).
Two further candidates were dropped for failing that second test and are named
in the message body: `.select('token, expires_at')` and the bare
`` return `${PORTAL_BASE}${path}`; `` — both count the same on the old file, so
neither proves anything about the deploy.

Deploy set re-derived on `main@64869a13` two ways that agree exactly (files
importing the module; files calling either exported builder): **nine functions,
14 call sites, no transitive caller.** An earlier note said ten and was wrong —
it counted the symbol rather than the import, the same error that produced
"eleven importers" for #68.

---

Cha Jewels Hub (chajewels/la-tracking) — DEPLOY NINE FUNCTIONS. No migrations in this message. Work from main at commit 64869a13.

Deploy only. There is **no SQL** in this one: do not apply a migration, do not
edit a file, do not touch the database.

### Why these nine

`_shared/portal-link.ts` builds the portal URL that every customer-facing Hub
email carries. Both of its builders used to branch on `auth_user_id` FIRST —
bare URL when the customer has an auth user, token URL only when they do not.

That was correct while `auth_user_id` could only mean "this customer chose a
password at /portal/setup". The storefront changed what it means: its
`/auth/customer` endpoint sets `auth_user_id` on ANY successful sign-in, and the
storefront signs people in with a **magic link**. So a legacy token customer who
signs in on the storefront just to look at their plan becomes "linked" without
ever choosing a password — and from that moment every Hub email sends them to a
page that asks for one. Locked out of their own account by looking at it.

The new order prefers a usable token, which works for linked and unlinked
customers alike:

```
1. a valid, active, unexpired token  -> token URL
2. otherwise auth_user_id set        -> bare URL
3. otherwise                         -> /portal home
```

It also adds the expiry check the function's own doc comment had merely asked
callers to perform. Measured against live data, exactly one group of customers
changes: 75 who are linked AND hold a valid token now get a working token link
instead of a sign-in page.

**This is inert until the nine are deployed.** The change lives entirely in the
shared module, so a function still running the old copy keeps emailing the
sign-in page. The frontend half went live with the push to main and needs no
deploy from you.

---

### STEP 0 — assert the source BEFORE deploying

Work from `main` at `64869a13`. If `HEAD` is not that commit, check whether
`64869a13` is an ancestor and say what the delta is before continuing.

**`supabase/functions/_shared/portal-link.ts`**

```
wc -l                                                                    -> 164   (was 143)
grep -c "tokenExpired"                                                   -> 3     (was 0)
grep -cE "^function tokenExpired\(expiresAt\?: string \| null\): boolean \{"  -> 1   (was 0)
grep -c "token_expires_at"                                               -> 2     (was 0)
grep -cF 'if (customer.portal_token && !tokenExpired(customer.token_expires_at)) {'  -> 1   (was 0)
grep -cF 'if (tokenRow?.token && !tokenExpired(tokenRow.expires_at)) {'  -> 1     (was 0)
```

Each of those six was re-run against the file with every comment line stripped
and the count did not move, so none of them is matching an explanatory comment.
Each also differs from the pre-release `main` (`2070e2f8`), shown in brackets —
an assertion that passes identically before and after proves nothing about the
deploy, so those are the only ones I am asking for. I deliberately dropped two
candidates that failed that second test: `.select('token, expires_at')` and
`` return `${PORTAL_BASE}${path}`; `` both count the same on the old file.

**If any count differs, STOP and report it — do not deploy and do not "fix" the
source.** A mismatch means your mirror is not serving the merged commit.

Also worth confirming, since it decides whether the list below is complete:

```
grep -rl "portal-link" supabase/functions/_shared            -> NO MATCHES (exit 1)
```

Zero, not one: the module does not mention its own filename, so an empty result
here means no `_shared` module imports `portal-link.ts` and there is no
transitive caller. An exit code of 1 from grep is the pass.

---

### STEP 1 — deploy these nine

```
1. award-loyalty-points
2. join-loyalty-program
3. loyalty-inactivity-check
4. process-loyalty-notification-queue
5. process-loyalty-redemption
6. request-extension
7. restore-loyalty-points
8. revoke-loyalty-points
9. send-loyalty-notification
```

That is the import graph, taken two ways that agree exactly: the files importing
`../_shared/portal-link.ts` and the files calling `getPortalLinkForCustomer(` or
`buildPortalLinkForCustomerId(` are the same nine, 14 call sites between them
(`loyalty-inactivity-check` has 5, `process-loyalty-redemption` has 2, the rest
one each). Seven use `buildPortalLinkForCustomerId`; `send-loyalty-notification`
and `process-loyalty-notification-queue` use `getPortalLinkForCustomer`. Both
builders were reordered, so all nine need it.

**Nine, not ten.** An earlier note of mine said ten and was wrong — it counted a
symbol rather than an import. Please deploy exactly this list.

`config.toml` is unchanged by this release; nothing needs adding to it.

---

### STEP 2 — report, and only what you can actually stand behind

1. The deploy result for each of the nine, with whatever version and timestamp
   your tooling gives you per function.
2. The six Step 0 greps, run against the commit you deployed from, with `HEAD`
   printed beside them — label this as SOURCE PROVENANCE, not as a read of the
   running bundle.
3. A live unauthenticated `POST` to two or three of the nine, with the status
   code. A `401` or `403` means deployed and gated; a `404` means the function
   is not there. That distinction is worth having.

**Do not claim a deployed-body match.** Last time you told me plainly that
nothing in your environment fetches deployed source, and that was the right
answer — give it again rather than substituting the repo file for the running
one. "I deployed from this commit, and these are that commit's counts" is the
honest claim and it is enough.

If any of the nine fails to deploy, say which and stop — a function left on the
old module silently keeps sending the wrong link, and I would rather know than
have eight of nine reported as a success.

---

### What NOT to do

- No migrations. Nothing in this release touches the database.
- Do not edit any source file, including `_shared/portal-link.ts` itself.
- Do not deploy anything outside the nine. In particular the eleven functions
  from the previous message are already deployed and are not in this list —
  `request-extension`, `join-loyalty-program` and `process-loyalty-redemption`
  appear in both, and they need this second deploy because the module they pick
  up here is a different one.
- Do not hand-edit `src/integrations/supabase/types.ts`.
