# For Admins — Quick Start

Welcome, admin. This guide covers your daily workflow on the Cha Jewels HUB. For deep feature documentation, see the **HUB Reference** sections.

## Sign in

1. Go to `https://app.chajewelsjp.com`
2. Sign in with your admin email and password
3. You'll land on the Dashboard

![Cha Jewels Hub sign-in page](Signin_Page)

---

## Your daily dashboard

After signing in you land on the Dashboard — your starting point every morning. The sidebar exposes everything else; badge counts surface anything pending.

![Cha Jewels Hub Dashboard](Landing_page)

---

## Your daily checklist

Scan these five places every morning to surface anything that needs attention:

| Check | Where to look | What you're looking for |
|---|---|---|
| **Pending payment submissions** | Sidebar → Finance (badge) → Documentation → Submissions | Customer + staff payment submissions awaiting your decision |
| **Pending extension requests** | Sidebar → CSR Monitoring → Extensions (badge) | Customers requesting a one-time forfeiture extension |
| **Pending waivers** | Sidebar → Finance → Documentation → Waivers | Penalty waiver requests from staff or customers |
| **New accounts today** | Dashboard card | Sanity-check today's newly-created layaway accounts |
| **Pending loyalty redemptions** | Sidebar → Loyalty → Redemptions (badge) | Customer reward claims awaiting approval |

---

## Common admin tasks

### 1. Review and confirm a payment submission

1. Click **Finance** in the sidebar, then the **Documentation → Submissions** tab
2. Each pending submission is displayed as an inline card with three action buttons
3. Verify: proof-of-payment image (right side of the card), amount, payment method, customer + invoice match
4. Click **Confirm**

The submission moves out of the queue, appears in the Proof of Payment subtab, and the account schedule + totals are updated automatically.

![Sidebar with badge counts highlighting pending submissions](Sidebar_Badge)

---

### 2. Reject or clarify a problem submission

Each submission card has three actions:

- **Confirm** — accept the payment as submitted
- **Reject** — decline the submission with a reason; the submitter is notified
- **Clarify** — ask the submitter for more information without rejecting (e.g. illegible proof, missing reference number)

When a submission has an amount mismatch (over or under), a decision modal appears after clicking Confirm:

- **Underpayment** — choose **Accept as partial**. This records the partial payment and marks the schedule row `partially_paid` with no automatic carry-over. If you want the shortfall to roll forward, use the **Carry Over** button on AccountDetail later (manual staff decision, never automatic).
- **Overpayment** — choose **Keep** to waterfall the surplus to the next pending months, reducing their `total_due_amount`.

---

### 3. Grant a one-time extension

After a customer's account is forfeited, you can grant one rescue extension (typically one month).

1. Open the forfeited account (status: `forfeited`)
2. Click **Grant Extension** (admin only)
3. Set the extension end date (usually 1 month out)
4. Confirm

The account status changes to `extension_active`. If the customer doesn't pay by the end date — or hits the penalty cap during the extension month — status becomes `final_forfeited` (permanent, blocks further negotiation or reactivation).

---

### 4. Run "Check Health" on a single account

For per-account audits — useful when you suspect totals or schedule rows are stale.

1. Open the account
2. Click **Check Health** in the account header
3. The modal runs 12 invariant checks across totals, allocations, schedule rows, penalties, and carry-over
4. All should be green ✅; if any check fails, the panel shows expected vs stored values for investigation

![Per-account Check Health modal showing all 12 checks passing](Account_health)

---

### 5. Run a system-wide audit

For sweeping checks across all accounts — useful after any change to calculation or payment logic.

1. From the Dashboard, click **Run System Audit**
2. The modal runs two summary checks: schema drift detection, and per-account health across every account
3. Toggle between **Failed Only** and **All** to filter results
4. If any accounts fail, open them individually and run **Check Health** for detailed diagnosis

![System Audit modal showing no schema drift and all accounts passing](System_audit)

---

### 6. Waive a penalty

When a customer's penalty should be forgiven (genuine hardship, system error, customer goodwill):

1. Open the account
2. Scroll to the **Penalties & Waivers** section
3. Click **Waive** on the penalty row
4. Enter a reason
5. Submit

The penalty status changes from `unpaid` to `waived` and is excluded from `activePenalties` and `remainingBalance`. The corresponding schedule row's `total_due_amount` is reduced by the waived amount.

⚠️ Already-paid penalties cannot be waived retroactively.

---

## Admin-only features

These areas are gated to the admin role and not visible to other staff:

| Area | Sidebar path | What it does |
|---|---|---|
| **Settings** | Sidebar → Settings | Full settings — General, Team management, Roles, Permission Matrix, Feature toggles |
| **Admin Audit** | Sidebar → Admin Audit | Full system activity log — every action across the app |
| **Bulk Import** | Sidebar → Bulk Import | Import historical payment / account data |
| **Executive Dashboard** | Sidebar → Executive Dashboard | Cross-system KPIs and analytics |
| **Payment Vault** | Sidebar → Finance → Vault | Sensitive payment data, admin only |

---

## Where to go next

For deep detail on any feature, see the corresponding section in **HUB Reference**:

- Layaway lifecycle, payments, penalties → **Layaway Accounts**, **Payments**, **Penalties**
- Forfeiture details (the three paths, final settlement) → **Forfeiture**
- Submissions workflow + underpayment / overpayment modals → **Submissions**
- Audit RPCs and Check Health → **Account Health Check & System Audit**
- Permission system → **Settings**

If you can't find what you need, ping the dev team.
