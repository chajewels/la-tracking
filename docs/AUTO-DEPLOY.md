> ARCHIVED 2026-07-05: the workflow this document describes was removed after investigation proved it never deployed anything (secrets never existed under Lovable Cloud). Edge functions deploy via Lovable IDE only. Retained for history.

## AUTO-DEPLOY RULES (updated 2026-05-13)

  ⚠️ DEPLOYMENT MODEL (updated
     2026-05-10):

     Edge function deployments are
     handled by Lovable inside their
     environment via direct Supabase
     tooling access. Lovable owns
     Supabase Dashboard access;
     Cynthia does not.

     Cynthia has NO direct deployment
     access — `npx supabase functions
     deploy` from Cloud Shell is NOT
     an option. If a function appears
     stale or a recent commit has not
     deployed, escalate to Lovable;
     they redeploy via Supabase
     Dashboard tooling.

     GitHub Actions auto-deploy
     workflow EXISTS but has never
     been functional — missing repo
     secrets SUPABASE_PROJECT_REF
     and SUPABASE_ACCESS_TOKEN.
     Adding them requires Supabase
     Dashboard access (Lovable-owned)
     to generate an access token.

     The workflow file and its
     path-filter logic (last fixed
     2026-05-08 commit 44e62a3)
     remain valid preventive
     infrastructure for if/when
     GitHub Actions auto-deploy
     gets enabled.

GitHub Actions auto-deploys on every push to main:

FRONTEND: Firebase Hosting — every push to main triggers
.github/workflows/firebase-deploy.yml. Builds with npm on Node 22
(actions/setup-node@v5): `npm install` + `npm run build`, then
`firebase deploy --only hosting`. The oven-sh/setup-bun + bun steps
were REMOVED 2026-05-26 (codeload outage made that action
undownloadable — see FIXED-BUGS #158); no third-party action
dependency remains for the build step.

SUPABASE EDGE FUNCTIONS — these auto-deploy when their files change.
Source of truth: .github/workflows/supabase-functions-deploy.yml.
Always re-check the workflow file before assuming a function is or
isn't auto-deployed; this list reflects the workflow as of 2026-05-13:

- accept-underpayment
- add-service
- append-cash-receipt
- auto-expire-cash-orders
- auto-forfeit-settlement
- award-loyalty-points
- bulk-import
- bulk-send-setup-invites
- carry-over
- cleanup-loyalty-images
- create-cash-order
- customer-portal
- daily-reconciliation
- dashboard-summary
- edit-payment-submission
- generate-invoice
- get-page365-order
- join-loyalty-program
- loyalty-inactivity-check
- manual-forfeit
- mark-loyalty-notification-read
- preview-transactional-email
- process-loyalty-notification-queue
- process-loyalty-redemption
- recalculate-penalties (DISABLED — returns 410)
- redeem-portal-token
- reconcile-account
- record-multi-payment
- record-payment
- review-payment-submission
- restore-cash-payment
- restore-loyalty-points
- revoke-loyalty-points
- send-loyalty-notification
- send-reminders
- send-transactional-email
- set-portal-pin
- setup-customer-account
- submit-cash-payment
- submit-payment
- sync-loyalty-to-sheet
- verify-portal-pin
- void-cash-payment

Note: _shared/** changes trigger redeploy of
send-transactional-email and preview-transactional-email,
so registry/template edits fan out to the dispatcher and
the Lovable preview UI without a follow-up touch.

Note: _shared/cash-receipt.ts is consumed by both
append-cash-receipt and generate-invoice — changes to it
require redeploying both functions.

Note (updated 2026-05-11): _shared/cash-receipt.ts is
imported directly by append-cash-receipt and generate-invoice.
review-payment-submission does NOT import it — it triggers
append-cash-receipt via fire-and-forget HTTP POST per the
Ship 2B pattern. Changes to _shared/cash-receipt.ts therefore
only require redeploying append-cash-receipt + generate-invoice.

All other edge functions still require manual deploy via Cloud Shell.
Always check .github/workflows/supabase-functions-deploy.yml
before adding new functions.

### review-payment-submission deploy verification

review-payment-submission: verify version in Supabase logs
after every deploy. If the deployed version does not match
the latest commit, escalate to Lovable to redeploy via
Supabase Dashboard tooling — Cynthia cannot run
`npx supabase functions deploy` from Cloud Shell.

### IMPORTANT — STALE EDGE FUNCTION DEPLOYS

Edge function deploys handled by Lovable can occasionally
lag behind the latest commit, leaving the production
function stale. Confirmed twice:
- Cash KPI deploy (2026-04-28)
- D3 reminder count fix — commit 0fe7517
  (2026-04-29). Auto-deploy job reported green
  but Dashboard kept showing the capped 200
  value until a manual redeploy was issued.

After ANY dashboard-summary change, verify the
fix actually shipped (compare Supabase function
version + spot-check a metric). If the metric
looks stale, escalate to Lovable to redeploy via
Supabase Dashboard tooling — Cynthia cannot run
`npx supabase functions deploy` from Cloud Shell.

Same pattern applies to any other edge function
whose effect is observable in the UI — if you
cannot see the fix, escalate redeploy to Lovable
before assuming the code is wrong.

### Known broken: GitHub Actions auto-deploy (as of 2026-05-15)

SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF repo secrets are NOT
configured in the GitHub Actions environment. Empirical evidence:

- Push events: workflow runs in ~7-14s, every deploy step silently skips
  (status "-")
- workflow_dispatch: workflow fails at first deploy step with
  "flag needs an argument: --project-ref"
- Conclusion: no edge function actually deploys via the workflow as of this date

Workaround: every edge function deploy must go through Lovable until secrets
are added.

Fix: add SUPABASE_ACCESS_TOKEN (generate at supabase.com/dashboard/account/tokens)
and SUPABASE_PROJECT_REF (value: pfoicalpzdcmyxzvwyhz) at
github.com/chajewels/la-tracking/settings/secrets/actions.

### Shared template registry coupling

The _shared/transactional-email-templates/registry.ts is bundled into every
edge function that imports it. send-transactional-email is the primary consumer
and performs all template lookups for transactional emails.

When a new template is added to _shared/transactional-email-templates/:

- The producing function (e.g. restore-loyalty-points referencing the new
template) must be deployed
- send-transactional-email MUST ALSO be deployed, or the call fails silently
with "Template not found in registry" at runtime. This is NOT optional.
- Any other consumer of the registry must be redeployed too

Empirical proof from Bug #103: deploying restore-loyalty-points alone was
insufficient — send-transactional-email needed a separate deploy to pick up
the new loyalty-tier-restored template entry. The auto-deploy workflow's
_shared/** path filter is designed to handle this automatically but is currently
disabled by the secrets issue (see Known broken above).

