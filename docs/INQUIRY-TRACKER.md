<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## Active Features

### Product Inquiry Tracker (added 2026-06-12)

- Route: `/inquiries` (sub-item under CSR Monitoring sidebar)
- Tables: `product_inquiries`, `inquiry_dropdown_options`
- Permission keys: `view_inquiries` + `manage_inquiries` (all 4 roles, is_allowed=true)
- 805 rows migrated from Google Sheet on 2026-06-12 (803 initial + 2 multi-category source rows recovered)
- `order_placed` backfilled from source CSV on 2026-06-12 (No 367 / Yes 85 / Joy Mine 3 / null 350)
- Two tabs: Inquiry List (filterable + paginated table, add/edit) + Demand Map (Top 20 bar chart + quadrant scatter)
- All dropdowns configurable via `inquiry_dropdown_options` with inline + Add in form
- Accumulated total: read-only view `product_inquiries_with_accumulated` adds
  `accumulated_inquiry_count` = RUNNING SUM(inquiry_count), partitioned by
  `lower(coalesce(nullif(btrim(item_code),''), nullif(btrim(product_name),'')))`,
  ordered `last_inquired_date ASC NULLS FIRST, created_at ASC, id ASC`, frame
  `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Each row shows the item's
  total AS OF that inquiry; the item's grand total is the value on its MOST
  RECENT row. Explicit ROWS (not default RANGE) so tied dates still increment
  one at a time. Inquiry List reads the VIEW; Demand Map reads the BASE TABLE.
- The view contains a window function and is therefore not auto-updatable — staff
  cannot write the column via PostgREST (SQLSTATE 55000, verified 2026-08-06).
  This is the protection; no guard trigger and no hidden input are involved.
  Never add an INSTEAD OF UPDATE trigger to this view.
- INVARIANT: never SUM or AVG `accumulated_inquiry_count`. It is a running
  cumulative figure, so aggregating it across rows is always meaningless. To get
  an item's grand total, read the value on its most recent row, or aggregate
  `inquiry_count` from the BASE TABLE (which is what the Demand Map does).
- Changed from grand-total to running-total on 2026-08-06 per owner request:
  staff need to see demand accumulating per logged inquiry, not the same figure
  repeated. Verified EM378 runs 1..16 and PND8 runs to 30 across 17 rows.
- Per-row `inquiry_count` remains staff-editable and is the only input to the
  accumulation (860 rows / 937 total counts as of 2026-08-06).
- loadList casts the relation name (`as any`) until types.ts regenerates to
  include the view; remove the cast when it lands under Views.
- No edge functions. No deploys needed.

### Timesheet — BUILT & LIVE (see docs/TIMESHEET-SPEC.md, docs/SYSTEM-STATUS.md)

- Staff monthly timesheet under CSR Operations → Timesheet (`/timesheet`). Pure-TS pay engine + RLS, no edge function.
- Spillover rows count toward the month (NOT display-only) — see docs/TIMESHEET-SPEC.md "31-row grid & spillover".
- Schema + RLS detail: docs/SCHEMA-FACTS.md "Timesheet tables".

