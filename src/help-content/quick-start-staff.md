# For Staff — Quick Start

Welcome to the Cha Jewels HUB. This guide covers your daily workflow — creating customers, opening accounts, recording payments, and submitting them for review. For deep feature documentation, see the **HUB Reference** sections.

## Sign in

1. Go to `https://app.chajewelsjp.com`
2. Sign in with your staff email and password
3. You'll land on the Dashboard

![Cha Jewels Hub sign-in page](Signin_Page)

---

## Your daily checklist

Scan these four places every morning to catch anything that needs your attention:

| Check | Where to look | What you're looking for |
|---|---|---|
| **Walk-ins and new customer registrations** | Customers → New Customer | Anyone signing up today |
| **Payments to record** | Customer messages, walk-ins, bank deposit notifications | Cash or transfers to log |
| **Your pending submissions** | Finance → Documentation → Submissions | Payments you submitted that are awaiting confirmation or marked "Clarify" |
| **Customer status inquiries** | Customers → search | Balance checks, payment history lookups |

---

## Common staff tasks

### 1. Create a new customer

1. Click **Customers** in the sidebar → **New Customer**
2. Fill in the customer's full name, mobile number, email, and country
3. Click **Create**

The new customer appears in the Customers list and is ready to be linked to a layaway account or cash order.

![New Customer form](New_Customer_form)

---

### 2. Create a new layaway account

1. From the customer's detail page (or Customers → Layaway → New Account), click **New Layaway Account**
2. Choose plan tier (3, 6, 8, 10, or 12 months), enter total amount, set downpayment amount
3. Choose currency (PHP or JPY) and start date
4. Add any services (optional)
5. **Product Amount (JPY)** — enter the bare item value in JPY, excluding shipping, service fees, and insurance. Required if the customer is a loyalty member (used to calculate their loyalty points; not shown to the customer)
6. If this order is part of the **Trade Program**, toggle the Trade Program checkbox — the box turns amber when active
7. Click **Create**

The account is created in `active` status with a generated installment schedule. The downpayment is NOT yet marked paid — that happens only after a payment submission is reviewed and confirmed by admin or finance.

![New Layaway Account form](New_Layaway_Account_form)

---

### 3. Create a new cash order

For immediate purchases or cash-on-delivery orders that don't follow a layaway schedule.

1. Click **Customers → Cash → New Cash Order**
2. Select the customer, enter total amount and currency
3. Choose payment method
4. **Product Amount (JPY)** — enter the bare item value in JPY, excluding shipping, service fees, and insurance. Required if the customer is a loyalty member (used to calculate their loyalty points; not shown to the customer)
5. If this order is part of the **Trade Program**, toggle the Trade Program checkbox
6. Click **Create**

![New Cash Order form](New_Cash_Order_form)

---

### 4. Record a single-account payment

When a customer pays for ONE account.

1. Open the account
2. Click **Record Payment**
3. Enter amount, payment method (bank transfer, cash, COD, etc.), payment date, and reference number
4. Upload proof of payment (bank receipt, transfer screenshot)
5. Click **Submit**

The submission appears in the Submissions queue with status "Submitted". Admin or finance will review and confirm — your job ends at submitting; you don't confirm your own payments.

![Record Payment dialog](RecordPaymentDialog_single)

---

### 5. Record a split payment across multiple accounts

When a customer pays a single amount that covers TWO OR MORE of their accounts at once.

1. From any of the customer's accounts, open the **Multi-Invoice Payment** dialog
2. Select which accounts the payment covers
3. Allocate the total amount across each selected account
4. Upload one proof of payment that covers the full transaction
5. Click **Submit**

Each account receives its allocated portion as a separate submission for review.

![Multi-invoice split payment dialog](MultiInvoicePaymentDialog_split)

---

### 6. Add a note to an account

For leaving context that other staff or admins should see — customer requests, payment delays, agreement notes, etc.

1. Open the account
2. Scroll to the **Account Notes** section (below Payment History)
3. Type the note (max 1000 characters)
4. Click **Add Note**

⚠️ Notes are immutable once saved — no edit, no delete. Be thoughtful and accurate.

![AccountDetail with Account Notes section](AccountDetail_notes)

---

### 7. Look up a customer's account history

1. Click **Customers** in the sidebar
2. Search by name, email, or invoice number
3. Click the customer row to open their detail view
4. The customer's accounts are listed — click any account to see full payment history

![Customer detail view showing account list](Customerdetail_Accountlist)

---

### 8. File a waiver request

When a customer asks for a penalty to be forgiven (illness, late paycheck, hardship, etc.), staff can file a waiver request on the customer's behalf. Admin or finance reviews and decides.

1. Open the account
2. Scroll to the **Penalty** section — you'll see the active penalties for the account along with a Request Waiver button on each penalty row

![Penalty section on AccountDetail showing the Request Waiver button](Penaltysection)

3. Click **Request Waiver** on the relevant penalty
4. Enter the reason for the request (be specific — admin reviews this)
5. Click **Submit Request**

The request goes to Finance → Documentation → Waivers for admin review. The penalty remains active until the decision is made.

![Waiver request submission flow](RequestWaivePenalty)

---

## What you can't access

These areas are not visible to your role. If you need any of the below, escalate to an admin or finance team member:

| Restricted area | Note |
|---|---|
| Settings | Not available to your role |
| Admin Audit | Not available to your role |
| Bulk Import | Not available to your role |
| Executive Dashboard | Not available to your role |
| Payment Vault (under Finance) | Not available to your role |
| Loyalty → Adjust Points | Not available to your role |
| Confirm / Reject / Clarify a payment submission | Your submissions are reviewed by management |
| Approve a waiver request | You submit; admin or finance decides |
| Waive a penalty directly | Not available — file a waiver request instead |
| Grant a forfeiture extension | Not available to your role |
| Run "Check Health" on an account | Not available to your role |
| Run "Run System Audit" | Not available to your role |

---

## Where to go next

For deep detail on any feature, see the corresponding section in **HUB Reference**:

- Layaway lifecycle and account anatomy → **Layaway Accounts**
- Payment methods + the submission flow → **Payments**, **Submissions**
- How penalties work + the waiver process → **Penalties**, **Waivers**
- Customer detail and notes → **Customers**, **Account Notes**

If you can't find what you need, ask an admin.
