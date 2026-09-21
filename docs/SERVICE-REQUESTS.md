# Customer service requests

A **service request** is a customer asking for work on a piece — a resize, a
cleaning, a repair, an appraisal. It is raised from the storefront and read
and triaged in the Hub.

A request is **not** a service job:

| | `service_requests` | `service_jobs` |
|---|---|---|
| Raised by | the customer, from the storefront | staff, in the Hub |
| Means | "I would like this done" | "the workshop has this" |
| Carries money | no | `service_fee`, inside `total_amount` |
| Scoped by | `layaway_account_id` / `cash_order_id` (FK) | `invoice_number` |

The two stay separate on purpose. A request is a conversation; a job is the
workshop's record. When a request becomes real work, staff raise a service job
for it — nothing in this feature does that automatically, and nothing should:
a job adds to `total_amount` (SERVICES RULE), so it is a money decision a
person makes.

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

`customer_id`, `cash_order_id`, `layaway_account_id`, `item_title`, `kind`,
`details`, `ring_size`, `status`, `staff_note`, `customer_note`, `created_at`,
`updated_at`.

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
    src/hooks/useServiceRequestCount.ts                sidebar badge count
