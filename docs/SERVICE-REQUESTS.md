# Customer service requests

A **service request** is a customer asking for work on a piece — a resize, a
cleaning, a repair, an appraisal. It is raised from the storefront and read
and triaged in the Hub.

A request is **not** a service job:

| | `service_requests` | `service_jobs` |
|---|---|---|
| Raised by | the customer, from the storefront | staff, in the Hub |
| Means | "I would like this done" | "the workshop has this" |
| Carries money | no | `service_fee`, on the job itself |
| Scoped by | `layaway_account_id` / `cash_order_id` (FK) | `invoice_number` |

The two stay separate on purpose. A request is a conversation; a job is the
workshop's record. When a request becomes real work, staff raise a service job
for it — the drawer's **Convert to service job** does that, and it never
creates anything on its own: it opens the job form and a person saves it.

**A service job's `service_fee` is NOT part of the account's `total_amount`.**
That is `account_services`, written by the `add-service` edge function, which
is what CLAUDE.md's SERVICES RULE governs. `service_jobs` is the workshop's own
log, scoped by `invoice_number`, and writing one leaves `total_amount`
untouched. The conversion still goes through a human because the fee is quoted
to a customer and because what work is actually needed is a judgement — not
because the number lands in the account total. It does not.

## Where it lives

- **Services → Requests** (`/services?tab=requests`) — the queue. All + five
  status chips, each with its own count. Rows open a drawer.
- **Sidebar badge** on the Requests child — open requests, 30s poll, via
  `useServiceRequestCount`.
- **AccountDetail / CashOrderDetail** — `ServiceRequestsSection`, read-only,
  beside `ServiceJobsSection`.
- **AccountQuickView** — open requests only, above Penalties.

## Statuses

`SERVICE_REQUEST_STATUSES` matches the table's CHECK constraint:

    requested · received · in_progress · completed · declined

**Open** = `requested`, `received`, `in_progress`. That is what the badge
counts and what the quick view shows.

Kinds: `resize`, `cleaning`, `repair`, `appraisal`, `other`.

## Columns worth knowing

`customer_id`, `cash_order_id`, `layaway_account_id`, `service_job_id`,
`item_title`, `kind`, `details`, `ring_size`, `status`, `staff_note`,
`customer_note`, `created_at`, `updated_at`.

**The FK is `layaway_account_id`, not `layaway_plan_id`.** The storefront calls
the record a plan; the Hub calls it an account; this table is the Hub's.

**`staff_note` is internal. `customer_note` is the reply the customer sees in
their portal.** They are two fields for a reason — never put in `customer_note`
anything you would not want read back to you.

The embeds use the FK constraint names explicitly
(`service_requests_cash_order_id_fkey`,
`service_requests_layaway_account_id_fkey`) — see `SERVICE_REQUEST_SELECT`.

## Rules this feature follows

**Test-customer exclusion is by `customers.is_test`, not the invoice regex.**
Every financial surface filters on `invoice_number ~ '^[0-9]+$'` (CLAUDE.md
TEST ACCOUNT EXCLUSION), but a request can exist with no order and no plan —
a customer asking about a piece they have not bought — so there is no invoice
to test. `is_test` is the DB-enforced flag and the only signal that covers
every row. The sidebar badge is the one exception: a `head: true` count cannot
filter on an embedded column, so it counts rows and the tab does the exclusion.
An occasional off-by-one badge beats a second round trip every 30 seconds.

**Editing is gated on `add_service`** and happens only in the drawer, so there
is one audited path for a status change.

**Every save is one `.update` carrying an explicit `updated_at`.** The column
has no trigger behind it; leaving it to the database would leave the row's age
wrong in the queue, which is the column staff sort on.

**A status change writes an `audit_logs` row** (`entity_type`
`'service_request'`, action `'update_service_request_status'`, old and new
status). A note edit does not — the note is visible in the drawer, whereas a
status move is what other surfaces and the customer's portal react to.

## From request to job

`service_requests.service_job_id` (FK `service_requests_service_job_id_fkey`,
indexed) is the link. It is on the REQUEST side — `service_jobs` knows nothing
about it — so every surface reads the link from `service_requests`.

**Raising one** (drawer → *Convert to service job*) opens `ServiceJobDialog`
with a prefill from `request-to-job.ts`, and on success writes
`service_job_id`, moves the request to `received`, and logs one `audit_logs`
row (`convert_service_request_to_job`).

**The prefill never carries a service description, by construction.** The
dialog derives a Ring Resize fee from a signed size token in the description,
and `ring_size` is the size the customer WANTS, not the delta the workshop will
cut — "7.5" in that field would quote a ¥3,000 resize off a number that was
never a delta. The size and the customer's words go to `notes`. For the same
reason the prefilled service type is set by state rather than through the
dialog's change handler, which would run the fee defaults against a description
that is not there yet. Pinned by
`src/test/request-to-job.test.ts`.

`jobTypeForKind`: `resize` → Ring Resize **only when a ring size came with the
request** (without one, nothing says the piece is a ring and Bracelet Resize is
the other half of that coin), `cleaning` → Polishing, `repair` → Repair,
`appraisal` → Appraisal, anything else → no type plus a hint telling the CSR to
choose.

**After creation the database owns the request's status.** Trigger
`trg_sync_service_request_from_job` on `service_jobs` maps Completed →
`completed` and Process / On-going → `in_progress`; Pending, Cancelled and
Logged leave the request alone. The Hub writes `received` on the way IN and
nothing after — two writers for one column would disagree. The trigger is
recorded in `supabase/migrations/20260921000000_record_request_to_job_link.sql`
and deliberately NOT duplicated in Hub code.

**Both sides show the link.** The queue and `ServiceRequestsSection` carry a
Job column (`LinkedJobCell`); the jobs table carries a "From customer request"
chip. `/services?tab=service-jobs&job=<id>` opens a job, `?tab=requests&open=<id>`
opens a request — each param is consumed once the row it names has loaded.

## `service_requests` is not in the generated types

The table was created live, and `src/integrations/supabase/types.ts` is
Supabase-auto-generated — Lovable regenerates it on its next edge-function
deploy and it is **never hand-edited** (CLAUDE.md GENERATED FILES).

Per that rule the fix is to cast at the call site. This feature makes that cast
**once**, in `serviceRequests()` in
`src/components/services/service-request-types.ts`, and every query goes
through it. The hand-written `ServiceRequestRow` is what the UI reads.

**When types.ts regenerates with the table**: delete `serviceRequests()`, use
`supabase.from('service_requests')` directly, and replace `ServiceRequestRow`
with the generated row type.

## The storefront side

The `website` edge function serves `GET`/`POST /me/service-requests`. Customers
are already creating rows from the storefront — this feature is the Hub
catching up to data that already exists.

Nothing in the Hub writes a request; it only triages one. Per DOMAIN
ARCHITECTURE, customer-facing writes go through the service-role edge function,
never straight to the table.

## Files

    src/components/services/service-request-types.ts   statuses, kinds, labels, the cast
    src/components/services/ServiceRequestsTab.tsx     the queue
    src/components/services/ServiceRequestDrawer.tsx   triage one request
    src/components/services/ServiceRequestsSection.tsx account / order section
    src/components/services/request-to-job.ts          request → job mapping (pure)
    src/components/services/LinkedJobCell.tsx          the Job column, both tables
    src/hooks/useServiceRequestCount.ts                sidebar badge count
    src/test/request-to-job.test.ts                    the prefill guard
