## INVOICE GENERATOR — SHIPPED 2026-05-10

  Workstream tracking the JPY-only invoice generator that creates
  Google Sheets in Drive folder Invoice/{YYYY}/{MM}. {Month}/.

  Locked decisions:
    Auth:            Google Service Account JWT (jose@5, RS256)
                     Service account: firebase-deployer@cha-jewels-la-tracking.iam.gserviceaccount.com
    File format:     native Google Sheet (not .xlsx)
    Currency:        JPY only (regardless of account currency)
    Math model:      post-tax discount (NOT D-1a as originally proposed)
                       tax   = round(subtotal_pretax × 0.10)
                       total = max(0, subtotal_pretax + tax − discount + shipping)
                     Matches master template's print-tab formulas.
                     Customer-facing total = DB total, exactly.
    Drive root:      Shared Drive Invoice folder
                       (set via INVOICE_ROOT_FOLDER_ID Supabase secret)
                     Original My Drive folder 1bMiQMq3-avl1sq5_EU3T9sIlmLOQmp7k
                     ABANDONED due to service-account storage quota.
    Master template: 15peyTqLv4q6rne1ois6bxV1cRoMjkXfiPk48XmAVJeo
                       INVOICE_MASTER_TEMPLATE in Shared Drive Invoice folder
                       set via MASTER_INVOICE_TEMPLATE_ID Supabase secret
                     4 tabs: Invoice-Use this (data entry, tax-inclusive prices)
                             InvoiceWithTax-Print this (customer printable)
                             Cash Receipt, Help
                     Function writes to Invoice-Use this only.
                     Print tab pulls via formulas → division by 1.1 to
                     show pretax breakdown.
    Folder convention: Invoice/{YYYY}/{MM}. {Month}/ (auto-create)
    Filename (D-3b): {invoice_number} first;
                     {invoice_number}-v{N+1} on regenerations
                     (count from existing generated_invoices rows).
    UI surface:      shadcn Sheet (slide-out side panel)
    Form state:      plain useState (mirror RecordPaymentDialog pattern)
    Trigger placement:
                     AccountDetail — between RecordPaymentDialog
                       and AddServiceDialog
                     CashOrderDetail — after Record/Submit Payment,
                       before Cancel Order
    Role gating:     admin + finance + staff

  Pre-requisites confirmed 2026-05-09:
    GOOGLE_SERVICE_ACCOUNT_JSON Supabase secret set
    INVOICE_ROOT_FOLDER_ID Supabase secret set (Shared Drive folder)
    MASTER_INVOICE_TEMPLATE_ID Supabase secret set
    Drive API + Sheets API enabled on cha-jewels-la-tracking GCP project
    Service account is Content Manager on Shared Drive
    Drive API calls include supportsAllDrives=true and
      includeItemsFromAllDrives=true for Shared Drive support

  Cell layout (Invoice-Use this tab) — function-locked:
    F5  = Invoice #         H5  = Date
    F7  = Order Type        H7  = Terms
    A12 = Bill To name      F12 = Ship To name
    A14 = Bill To addr 1    F14 = Ship To addr 1  (postal+city+country)
    A15 = Bill To addr 2    F15 = Ship To addr 2  (street/building)
    A16 = Bill To phone     F16 = Ship To phone
    Items rows 21-33 (max 13):
      col A = description    col F = qty
      col G = unit price     col H = amount  (both tax-INCLUSIVE)
    H34 = subtotal (formula — function does NOT write)
    H35 = discount (function writes value)
    H36 = shipping fee (function writes value)
    H37 = final total (formula — function does NOT write)
    Unused item rows beyond items count: A/F/G cleared by function
    to prevent template sample data bleed-through.

  Step 1a — SHIPPED 2026-05-09 (schema + RPC patches):

    Phase α — customers table:
      Added 4 nullable columns: address_line1, city, postal_code, country
      country backfilled from location for all 667 rows
      4 normalizations: Hongkong → Hong Kong, UK → United Kingdom,
        Netherland → Netherlands, Korea → South Korea

    Phase β-1 — generated_invoices table:
      17 columns, RLS enabled with 5 policies, 4 indexes
      Parent FKs: account_id, cash_order_id (both ON DELETE RESTRICT)
      CHECK constraint: exactly_one_parent (XOR on the two FKs)
      Snapshot columns (jsonb): ship_to, bill_to, items
      Totals (numeric(12,0)): discount_jpy, shipping_fee_jpy,
        subtotal_pretax_jpy, tax_jpy, total_jpy
      No void mechanism — regeneration writes a new row,
        latest by generated_at = current

    Phase β-2 — delete_account_atomic patched:
      New step 16 deletes generated_invoices before the account row
      Function comment updated: 16 → 17 explicit DELETEs

    Phase β-3 — audit_delete_cleanup_invariants allowlist:
      Added ('delete-account', 'layaway_accounts',
             'generated_invoices', true, false)

    Phase β-4 — delete-customer/index.ts: NOT patched (intentional)
      Pre-check at lines 67-107 transitively guards generated_invoices
      via accounts/cash_orders blockers.

  Audit baseline post-Step 1a:
    SELECT * FROM audit_delete_cleanup_invariants();
    Expected: 0 critical, 0 warning, 2 info rows
      - cash_payments → cash_orders (existing preventive)
      - generated_invoices.cash_order_id → cash_orders (new preventive)

  Step 1b — SHIPPED 2026-05-09:
    Final commit chain on main:
      3f6d2b1 — initial generate-invoice edge function + workflow
      0556426 — SHEET_NAME = "Invoice-Use this", DWD setup
      69a8338 — cell layout + tax-inclusive item prices
      2486963 — post-tax discount math (final correction)

    File: supabase/functions/generate-invoice/index.ts (~600 lines)
    Deploys: via Lovable IDE only (the former GitHub deploy workflow was inert and removed 2026-07-05); gateway verify_jwt stays ON for this function

    End-to-end test (TEST-004, 13-item payload, ¥5,000 discount,
    ¥1,500 shipping):
      subtotal_pretax_jpy: 313,500
      tax_jpy:              31,350
      total_jpy:           341,350
    DB row matches print tab cell-for-cell.

    Deploy lesson learned (2026-05-09):
      Lovable can report "deployed successfully" while the live
      edge function stays on prior code. After every Lovable code
      change to an edge function, force manual deploy from Cloud Shell:
        npx supabase login   (first time or session expired)
        npx supabase functions deploy <function-name> \
          --project-ref pfoicalpzdcmyxzvwyhz
      Verify by re-running the test invocation and checking values
      of the most-recent affected row.

  Step 1c — SHIPPED 2026-05-10:
    Frontend wiring complete on both surfaces, with count-badge polish.

    Step 1c-1 — SHIPPED 2026-05-09 (commit 91c5ac5):
      New file: src/components/invoices/InvoiceGeneratorSheet.tsx
      Self-contained shadcn Sheet (slide-out) with invoice form.
      Form fields: ship_to + bill_to (with "same as ship to" default ON),
        items array (1-13), discount, shipping fee, terms.
      Edge function call: supabase.functions.invoke('generate-invoice')
      Two-stage UX: form → success (sheet URL + Open in Drive +
        Generate Another + Done).
      Internal role gate: admin / finance / staff (returns null otherwise).
      Live total preview matches Invoice-Use this display math.

    Step 1c-2 — SHIPPED 2026-05-10 (commit f0edac4):
      Wired into src/pages/AccountDetail.tsx between Messenger link
      and AddServiceDialog. Spot A placement — outside the
      payment-eligibility gate, so visible regardless of account
      status (paid, overdue, forfeited, etc.).
      Pre-fills ship_to + bill_to from account.customers (the
      existing useAccount hook already fetches customers(*) — no
      extra query).
      Tested end-to-end on TEST-004:
        13-item payload, ¥5,000 discount, ¥1,500 shipping
        DB row: subtotal_pretax_jpy=313,500, tax_jpy=31,350,
                total_jpy=341,350
        Drive sheet matches print tab cell-for-cell.

    Step 1c-3 — SHIPPED 2026-05-10 (commit d775e16):
      Wired into src/pages/CashOrderDetail.tsx in the action button
      row (Spot B). Sits between the Submit Payment button and
      the Cancel Order button. Outside both canRecordPayment and
      canCancel gates — visible regardless of cash order status.
      Required broadening the existing useCashOrderDetail hook's
      SELECT from customers(id, full_name) to include
      address_line1, city, postal_code, country, mobile_number.
      CashOrderRow.customers type expanded to multi-line shape.
      Tested end-to-end on cash order 18991 (PHP, completed):
        DB row: account_id=NULL, cash_order_id populated,
        subtotal_pretax_jpy=82,709, tax_jpy=8,271, shipping=1,988,
        total_jpy=92,968.
      Confirms exactly_one_parent CHECK constraint working.

    Step 1c-4 — SHIPPED 2026-05-10 (commit 530c039):
      Polish: prior-generation count badge on the trigger button.
      Reads from generated_invoices via useQuery, keyed by parent.
      Auto-bumps on successful generation via
      queryClient.invalidateQueries.
      Hidden when count = 0; shows secondary Badge with count when > 0.
      Provides "wait, was this already invoiced?" signal to staff
      without the cost of a full invoice-history list.

    Final commit chain on main:
      91c5ac5 — 1c-1 InvoiceGeneratorSheet component
      f0edac4 — 1c-2 wire into AccountDetail
      d775e16 — 1c-3 wire into CashOrderDetail
      530c039 — 1c-4 count badge

    Verified working surfaces:
      AccountDetail.tsx — Generate Invoice button visible to
        admin/finance/staff regardless of status; pre-fills from
        customer record; count badge shows prior generations.
      CashOrderDetail.tsx — same behavior; broadened SELECT
        ensures all 6 address fields available for pre-fill.

  Step 1d — SHIPPED 2026-05-10 (commit 154ac2c):
    get-page365-order edge function fetches Page365 order data
    from the latest CSV in the _Page365-Mirror Drive folder
    (PAGE365_MIRROR_FOLDER_ID secret). Reads UTF-16 LE TSV,
    filters by invoice number, returns:
      { found, address?, phone?, shipping_fee?, discount?,
        items?: [{ description, qty, unit_price_with_tax }] }

    Implementation:
      Extracted shared getServiceAccountAccessToken helper into
        supabase/functions/_shared/google-auth.ts (was previously
        inlined in generate-invoice).
      generate-invoice refactored to import the shared helper
        (zero behavior change, pure refactor).
      get-page365-order: 153 lines, single POST handler.

    End-to-end test (invoice 18952, Roselyn Julianda Valenzuela):
      Returns 2 items (necklace + bracelet totaling ¥84,960),
      Saudi Arabia address, phone — all correct.

    Final commit chain on main:
      154ac2c — feat(invoice): get-page365-order edge function +
                extract google-auth helper

  Step 1e — SHIPPED 2026-05-10 (commit 70d8491):
    InvoiceGeneratorSheet pre-fills SHIP TO address, phone,
    items, discount, and shipping fee from get-page365-order
    when the dialog opens. Customer name preserved from
    prefillAddress prop (customers table).

    Implementation:
      useQuery on ['page365-order', parentInvoiceNumber] enabled
        when dialog open + invoice number present + user authorized.
      useEffect on page365Error → toast.error fallback for
        network/Drive failures.
      useEffect on page365Data?.found === true → setShipTo,
        setItems (mapping unit_price_with_tax →
        unit_price_jpy_inclusive), setDiscount, setShipping.
      "Pre-filled from Page365" Badge (variant="secondary")
        shown next to SHIP TO heading when data loaded.
      Page365 wins on conflict: address_line1 = full address
        string, city/postal_code/country cleared (Page365 has
        it all in one field), phone overridden, name preserved
        from customers table.
      found=false → silent fallback (no toast, dialog
        behaves exactly as before).

    End-to-end verified on invoice 18952 in production: dialog
    opened, badge appeared, all fields auto-populated within
    ~1 second. Invoice generated correctly via Google Sheets
    with all pre-filled data.

    Final commit chain on main:
      70d8491 — feat(invoice): wire Page365 pre-fill into
                InvoiceGeneratorSheet

  ### Step 2 — Cash Receipt Auto-Population (SHIPPED 2026-05-11)

  Cash Receipt tab of generated invoices is auto-populated with
  proof-of-payment images and metadata for every confirmed
  payment_submissions entry on the parent account/cash_order.

  Architecture:
  - _shared/cash-receipt.ts — 24-slot canonical cell map + Sheets
    API helpers (buildSlotUpdates, appendOneReceipt,
    appendManyReceipts). Single source of truth for slot positions
    and =IMAGE formula construction.
  - append-cash-receipt edge function — thin HTTP wrapper that
    delegates to appendOneReceipt. Used for incremental writes
    from review-payment-submission and for ad-hoc curl testing.
  - generate-invoice extension — on Sheet creation, queries all
    confirmed receipts for parent (ORDER BY payment_date ASC,
    created_at ASC, LIMIT 24), embeds them in a single Sheets API
    batchUpdate via appendManyReceipts. Persists
    cash_receipt_sheet_id on parent table. Response gains
    embedded_receipt_count field.
  - review-payment-submission extension — on confirm in cash-order
    branch, fires-and-forgets append-cash-receipt with the new
    receipt's slot_index. Same in layaway branch for single-
    allocation submissions only (confirmedPaymentIds.length === 1).

  PHP→JPY conversion: per CLAUDE.md CURRENCY CONVERSION STANDARD,
  amounts are converted PHP ÷ rate before display. Rate fetched
  from system_settings.php_jpy_rate (jsonb scalar). Always
  displays as "{amount} JPY".

  Slot layout: 24 slots in the Cash Receipt tab — 4 columns
  (B, I, P, W) × 6 bands, numbered ROW-MAJOR (left-to-right
  across each band, then down) so printed receipts read in
  chronological sequence.
  Band anchor rows (image/metadata): 5/40, 58/93, 110/145,
  163/198, 216/251, 269/304. Image cell = anchor + 27 rows × 5
  cols; metadata cell = anchor + 5 rows × 5 cols.
  2026-06-04: remapped from 13-slot column-major. Orphan
  W157/W191 block removed from master template. generate-invoice
  receipt query LIMIT 13 → 24. Overflow guard slot_index > 24
  logs and skips.

  Failure isolation: receipt-embed errors caught and logged with
  console.warn, never block invoice generation or payment
  confirmation. Slot overflow (slot_index > 24) logs and skips.

  Schema columns:
  - layaway_accounts.cash_receipt_sheet_id text NULL (added 2026-05-11)
  - cash_orders.cash_receipt_sheet_id text NULL (added 2026-05-11)

  ### Folder logic fix (SHIPPED 2026-05-11, commit 194b13f + 5c9bff2)

  Bug: generate-invoice used `new Date()` for the target Drive
  folder, so backdated regenerations landed in the current month
  instead of the order's month.

  Fix:
  - layaway_accounts and cash_orders SELECTs widened to include
    `order_date`.
  - parentOrderDate captured alongside parentInvoiceNumber.
  - Folder resolution parses parentOrderDate as "YYYY-MM-DD"
    (date type, no tz). MONTH_NAMES[mm - 1] gives "NN. Month".
  - Defensive fallback to current date if order_date is null or
    non-ISO (column is NOT NULL in schema; fallback is insurance).

  Side effect: required hotfix commit 5c9bff2 to restore the
  `const now = new Date();` declaration that was used at line 451
  (CELLS.invoice_date) but accidentally removed in the folder fix.

  ### Currency conversion conditional (SHIPPED 2026-05-11, commit 46fb78f)

  Rule: payment_submissions.submitted_amount is stored in the
  parent account's currency. Cash receipt display always shows
  JPY. So:

  - JPY accounts: submitted_amount used as-is (no conversion)
  - PHP accounts: submitted_amount converted via Math.round(
    amount / php_jpy_rate) — per CLAUDE.md CURRENCY CONVERSION
    STANDARD (JPY = PHP ÷ rate)

  Applies in both generate-invoice (bulk fill) and
  review-payment-submission (cash + layaway branches).

  Widened both function's parent SELECTs to include `currency`.
  Used a ternary: `currency === "JPY" ? amount : Math.round(amount / rate)`.

  ### Cleanup completed (2026-05-11)

  - generated_invoices.drive_folder_path audit returns 0 misfiled
    rows after the folder fix shipped and stale rows were DELETED.
  - The 12 original misfiled rows from before the folder fix were
    cleaned up via:
      DELETE FROM generated_invoices gi USING layaway_accounts la
      WHERE gi.account_id = la.id AND gi.drive_folder_path != ...;
    (and the cash_orders equivalent)
  - Drive files for those 12 invoices marked for staff
    regeneration via the fixed generate-invoice — they'll land in
    correct order_date folders with correct JPY amounts.
  - Buggy 18946 row (sheet_id 1WBlOv6CoszfZxmNP_a6TCDOy2_HWGXphOIWKadZos7s,
    generated 11:13:44 UTC, showed 60,590 JPY) deleted from
    generated_invoices; 18946-v2 at 1erhLngGJ3y6... is the
    canonical correct version (25,448 JPY).


### Dynamic item rows (2026-07-06, Bug #247)

  Invoices with more than 13 items no longer 400: generate-invoice
  inserts the extra rows into the generated per-invoice copy (never
  the master template) on BOTH tabs — insertDimension before the last
  item row (so =SUM auto-expands, formatting inherited) plus a
  copyPaste on the print tab to replicate its per-row formulas with
  self-adjusting references. Discount/shipping footer writes shift
  down by the inserted row count. Safety bound: 100 items
  (SAFETY_MAX_ITEMS; frontend MAX_ITEMS raised to match). The print
  tab title must remain exactly "InvoiceWithTax-Print this" — tab
  resolution is by exact title and fails loudly listing the actual
  tab names if it ever changes.
