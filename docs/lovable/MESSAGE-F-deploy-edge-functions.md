# Lovable message F — DEPLOY EDGE FUNCTIONS ONLY

**SHA filled: `main` at `8ebe539a`. Send only after message E's verification is clean.** One sender: Claude Code, from this
session, after Cynthia's OK. Check the Lovable message queue before sending. A transport
timeout is not a failure — never resend on a timeout.

**This message deploys edge functions. It applies no migrations and runs no SQL.**

---

Deploy 29 edge functions for project `5be237e2-d98a-4ee7-97f0-cf83faeed2ba` from `main`
at `8ebe539a`.

## 0. SOURCE ASSERTIONS — run these FIRST and STOP if any fails

Your repo mirror can lag GitHub, and a "deployed successfully" against a stale mirror
ships the old code silently. That is exactly how the September email outage stayed hidden
for nine days. If any count differs, **stop and report what you actually see.**

```bash
git rev-parse HEAD          # expect 8ebe539a
```

### 0a. The shared files — assert on EVERY one of these

**These are the reason 11 of the 29 functions are being deployed at all.** A `_shared/`
edit changes nothing in production until every importer is redeployed. Assert the shared
files themselves, not only the functions that have their own diffs.

```bash
# the email log + storefront sender (skip logging)
grep -c "recordEmailAttempt" supabase/functions/_shared/email-log.ts                # expect >= 1
grep -c "skipped"            supabase/functions/_shared/email-log.ts                # expect >= 1
grep -c "recordEmailAttempt" supabase/functions/_shared/storefront-email.ts         # expect >= 1

# the Hub sender + registry + brand
grep -c "recordEmailAttempt" supabase/functions/_shared/transactional-email-templates/send-email.ts   # expect >= 1
grep -c "unsubscribe_token:" supabase/functions/_shared/transactional-email-templates/send-email.ts   # expect 0 (setter form — the bare word appears in comments)
ls supabase/functions/_shared/transactional-email-templates/brand.ts
ls supabase/functions/_shared/transactional-email-templates/registry.ts

# presentation helpers (#55)
ls supabase/functions/_shared/order-reference.ts
ls supabase/functions/_shared/payment-method-label.ts

# the two shared email bases whose edits ripple into five otherwise-unchanged templates
ls supabase/functions/_shared/email-templates/layaway-shared.tsx
ls supabase/functions/_shared/email-templates/order-shared.tsx

# the three step-4 templates
ls supabase/functions/_shared/email-templates/layaway-plan-created.tsx
ls supabase/functions/_shared/email-templates/layaway-payment-received.tsx
ls supabase/functions/_shared/email-templates/layaway-expired.tsx

# 41 shared files changed in this release in total
git diff --name-only 9fb6f8ae..HEAD -- supabase/functions/_shared/ | wc -l   # expect 41
```

### 0b. The functions with their own changes

```bash
grep -c "create_web_layaway_atomic"  supabase/functions/website/index.ts               # expect >= 1
grep -c "below_plan_minimum"         supabase/functions/website/index.ts               # expect >= 1
ls    supabase/functions/set-account-deadlines/index.ts                                # NEW function
grep -c "set_account_deadlines"      supabase/functions/set-account-deadlines/index.ts # expect >= 1
grep -c "expire_web_layaway_atomic"  supabase/functions/auto-expire-cash-orders/index.ts # expect >= 1
grep -c "unsubscribe_token:"         supabase/functions/send-transactional-email/index.ts # expect 0  (setter form; the bare word appears 3x in comments explaining why not to set it)
grep -c "unsubscribe_token:"         supabase/functions/process-email-queue/index.ts    # expect 0  (setter form; bare word appears 2x in comments)
grep -c "order_cancelled"            supabase/functions/revoke-loyalty-points/index.ts  # expect >= 1
grep -c "under_review"               supabase/functions/auto-forfeit-settlement/index.ts # expect 1  (INVARIANT 12 here is a payment_submissions status query, not the RPC's refusal code)

# delete-account no longer calls the revoke edge function — the RPC owns it now
grep -c "revoke-loyalty-points"      supabase/functions/delete-account/index.ts        # expect 0

# the new function must be gated
grep -c "functions.set-account-deadlines" supabase/config.toml                          # expect 1
grep -A1 "functions.set-account-deadlines" supabase/config.toml                         # expect verify_jwt = true
```

## 1. DEPLOY — all 29

### A. Functions with their own changes (18)

```
website
set-account-deadlines          ← NEW function, first deploy, verify_jwt = true
auto-expire-cash-orders
review-payment-submission
send-transactional-email
auto-forfeit-settlement
revoke-loyalty-points
submit-cash-payment
process-email-queue
create-layaway-account
penalty-engine
delete-account
submit-payment
send-reminders
approve-waiver
manual-forfeit
reactivate-account
void-payment
```

### B. ⚠️ No changes of their own — deploy ONLY because they import a changed `_shared` file (11)

**Do not skip these.** They are the whole reason this message asserts on shared files.
Skipped, they keep running the old templates and helpers — silently, with no error
anywhere, until someone notices a customer email looks wrong days later.

```
award-loyalty-points                 ← storefront-email.ts, send-email.ts, loyalty-level.tsx*
loyalty-inactivity-check             ← storefront-email.ts, send-email.ts, loyalty-level.tsx*
cancel-cash-order                    ← storefront-email.ts, order-cancelled.tsx*
preview-transactional-email          ← transactional-email-templates/registry.ts
bulk-send-setup-invites              ← send-email.ts
join-loyalty-program                 ← send-email.ts
process-loyalty-notification-queue   ← send-email.ts
process-loyalty-redemption           ← send-email.ts
request-extension                    ← send-email.ts
restore-loyalty-points               ← send-email.ts
send-loyalty-notification            ← send-email.ts
```

`*` = pulled in **transitively**: the template file itself is unchanged, but it imports
`layaway-shared.tsx` / `order-shared.tsx`, which this release changed. Five templates are
affected this way (`loyalty-level`, `order-cancelled`, `order-confirmation`,
`order-expired`, `order-payment-received`). A "changed files only" list misses every one.

### Deliberately NOT in this set — do not deploy

- `email-health-check` — mentions `_shared/email-log.ts` in two comments but does not
  import it; it reads the RPC.
- `auth-email-hook` — imports only `email-templates/` files this release does not touch.
- `shopify-webhook` — unchanged in this release.

## 2. VERIFY AFTER DEPLOY

For each of the 29, confirm the deploy reported success and report any that did not.
Then, **without sending any email**:

```
GET  <project>/functions/v1/preview-transactional-email?template=payment-confirmed
```

Confirm the rendered HTML shows the canonical gold `#C9A227` and **no** `#D4AF37`, and
that the footer carries no `unsubscribe_token` placeholder. If `preview-transactional-email`
was one that failed to deploy, say so rather than reading a stale preview.

Do **not** send a test email to any real customer address.

## 3. REPORT BACK

- the output of every assertion in §0, including the `wc -l` of 41 shared files
- the deploy result for each of the 29, listed by name, in the two groups above
- any function that failed, with its error
- the preview render check in §2
- anything you changed that this message did not ask for (expected: nothing)

Do **not** apply any migration in this message. That was message E.
