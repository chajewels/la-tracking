# Timesheet → Payslips

Owner-confirmed plan 2026-10-26. Migration `supabase/migrations/20270201100000_staff_payslips.sql`.
No edge function. UI: `src/components/timesheet/PayslipsTab.tsx`; rules: `src/lib/payslips.ts`;
tests: `src/test/payslips.test.ts`, `src/test/payslips-tab.test.tsx`, SQL harness `supabase/tests/payslips/`.

## Live status (2026-10-27)

All payslip migrations are applied on the live database and the frontend is released (PR #637, main `09d79b02`,
Firebase deploy green):

| Migration | Feature | Live |
|---|---|---|
| `20270201100000_staff_payslips.sql` | Payslips tab, finalize, payment, PDF/Excel | applied |
| `20270204100000_payslip_bond_payhistory.sql` | Cash advances, employee ID, cash bond, pay history, April–May | applied |
| `20270205100000_payslip_second_proof.sql` | 2nd proof file (payment, cash advances) | applied |
| `20270206100000_payslip_bonuses.sql` | Bonuses (Performance / KPI, Holiday / Christmas) | applied |
| `20270207100000_payslip_edit_figures.sql` | Edit figures + cash bond on salary only | applied 2026-10-27 JST; 17 payslips unchanged |
| `20270208100000_payslip_bond_final_pay_only.sql` | Cash bond released only on Final pay | applied 2026-10-27 JST after release #642; 24 payslips unchanged |

April and May 2026 timesheets loaded 2026-10-27 (207 entries); with the release, April totals ₱79,020.55 and
May ₱74,541.48. The "NOT applied" notes in the sections below describe each migration at the time it was written.

## Owner decisions (locked)

- **Who:** admin, or a timesheet user flagged `timesheet_profiles.can_view_all` (today only Brenda). This is
  the Cost Master gate (`canViewCost = isAdmin || canViewAll`). **Staff never see their own payslip** through
  this feature, because the tables are readable only through the gate. Brenda is inside the gate, so she
  can see and issue her own. That follows from the gate and was accepted.
- **Freeze on finalize:** the figures and the staff details (name, address, date of birth, job title,
  template) are copied into the payslip when it is finalized and never change. If a figure changes later,
  the tab warns, and the payslip is voided and issued again. It is never edited.
- **Actual remittance rate:** the payment records the yen actually sent and the pesos actually received.
  The rate stored is `php_per_jpy = round(php_received / jpy_sent, 6)`. It is not the Hub rate. The yen to
  send is pre-filled from **today's market rate** fetched in the browser, `Math.round(total_php / rate)`
  (dividing, per the CLAUDE.md currency standard). It is never pre-filled from `system_settings.php_jpy_rate`
  (owner 2026-10-26; see Follow-ups).
- **One .xlsx per staff member per month**, made from the STORED figures only.
- **Staff details live on the tab** (the "Staff details" editor), not in Team or Assignments.

## Tables

- `staff_payroll_details`: `user_id` PK (= auth uid = `timesheet_profiles.user_id`), `address` (trimmed,
  1–500 characters, or null), `date_of_birth` (≥ 1900-01-01, or null; the RPC also refuses future dates),
  `updated_by`, `updated_at`.
- `payslips`: `id`; `user_id`; `pay_month` (first of month); `status` `finalized | paid | void`;
  snapshot `staff_name`, `address`, `date_of_birth`, `job_title`, `template_type`; `timesheet` and
  `commission` (jsonb breakdowns, known keys only); `timesheet_net_php`, `commission_php`, `total_php`
  (CHECK `total = timesheet + commission`); payment `jpy_sent` (integer), `php_received`, `php_per_jpy`,
  `paid_on`, `proof_path`, `paid_by/at`; `finalized_by/at`; `voided_by/at`, `void_reason`; `created_at`.
  Partial UNIQUE `(user_id, pay_month) WHERE status <> 'void'`.

Breakdown keys:

| | keys |
|---|---|
| CSR timesheet | `days_worked` (in-month rows with pay > 0), `total_hours`, `daily_pay_sum` (gross before cap), `basic_salary`, `capped_gross`, `monthly_allowance`, `forfeited_weeks`, `allowance_paid`, `net` |
| Live Admin timesheet | `days_at_500`, `days_at_300`, `total_hours`, `net` (= 500 × days_at_500 + 300 × days_at_300; the day counts span the 31-row window, because every row counts toward pay) |
| Commission | `role_won` (label or null), `earnings`, `top_sales_tier` (0/1/2), `top_sales_bonus`, `total` (= earnings + bonus) |

## Locks

- No write policies. INSERT/UPDATE/DELETE/TRUNCATE are revoked from PUBLIC, anon and authenticated; anon
  has no SELECT. The read policy on both tables is `can_manage_payslips(auth.uid())`.
- `payslips_before_write` (row trigger) allows INSERT only as `finalized` with no payment or void
  fields. It allows only two kinds of UPDATE: `finalized → paid`, where only the payment fields may
  change, and `finalized | paid → void`, where only the void fields may change. It refuses every other
  UPDATE and every DELETE, whoever runs them, including a privileged SQL session.
  `payslips_refuse_truncate` (statement trigger) refuses TRUNCATE.

## The gate

`public.can_manage_payslips(p_uid)` (SECURITY DEFINER, STABLE) is true only when `p_uid = auth.uid()`
AND (`has_role(p_uid,'admin')` OR `timesheet_can_view_all(p_uid)`). It only ever answers for the caller,
so nobody can use it to probe other users.

## RPCs

Each RPC checks the gate first (`permission_denied`) and returns `{ok: true, …}` or `{error: <code>}`.
Raw database errors never reach the browser, and the UI turns every code into plain English
(`payslipRefusal`).

| RPC | does | refusals |
|---|---|---|
| `get_payslip_book(p_pay_month)` | every payslip of the month (all statuses), details of every active timesheet profile, the peso rate, `can_manage` | `permission_denied`, `invalid_month` |
| `save_staff_payroll_details(p_user_id, p_address, p_date_of_birth)` | upsert; empty address or null date clears that field; a save that changes nothing writes nothing | `staff_not_found` (no timesheet profile), `invalid_address`, `invalid_date_of_birth` |
| `finalize_payslip(p_user_id, p_pay_month, p_payload)` | copies name (`profiles.full_name`), job title + template (`timesheet_profiles`), address + date of birth (`staff_payroll_details`) server-side; rebuilds both breakdowns from known keys; numbers must be plain decimals ≥ 0 (≤ 2 decimals; counts whole); inserts `finalized` | `invalid_month` (not first-of-month, before 2026-06, after this month Japan time), `staff_not_found`, `already_issued`, `name_missing`, `details_missing`, `invalid_figures`, `invalid_totals` |
| `record_payslip_payment(p_id, p_jpy_sent, p_php_received, p_paid_on, p_proof_path)` | `finalized → paid`; stores `php_per_jpy` | `not_found`, `not_finalized`, `invalid_jpy_sent`, `invalid_php_received`, `invalid_paid_on` (after today Japan time or before the pay month), `proof_required`, `invalid_proof_path` (must be `<id>/<file>`, no `..`), `proof_missing` (not in the bucket) |
| `void_payslip(p_id, p_reason)` | `finalized | paid → void` (reason 3–500 characters); a new payslip can then be issued | `reason_required`, `not_found`, `already_void` |

**Audit:** every write inserts one `audit_logs` row. `entity_type` is `payslip` (entity_id = the payslip
id) or `staff_payroll_details` (entity_id = the staff user id). The rows carry **no money figures, no
address and no date of birth**. The details audit lists only which fields changed. This is because
`audit_logs` is readable by the finance role, which is a wider group than the payslip gate. The figures
live on the payslip row itself, which never changes.

## Storage

Private bucket `payslip-proofs`: 10 MB; JPG, PNG, WebP, HEIC/HEIF and PDF. Read needs the gate. Upload
needs the gate AND the first folder must be an existing **finalized** payslip id AND a file name must
follow (no `..`). There is no update and no delete. A failed save leaves its upload in the bucket. The
Hub opens a proof with a 10-minute signed URL.

## Screens

Timesheet → **Payslips** tab (visible and reachable only with `canViewCost`; anyone else who opens
`?tab=payslips` is redirected to their default tab).

- Month picker (the page's month control), "Staff details" editor (address + date of birth per active
  staff member).
- Table: one row per active timesheet profile, showing name, type, timesheet net ₱, commission ₱,
  total ₱, status (Not issued / Finalized / Paid / Void) and View. An issued row shows the stored figures,
  with a warning icon when the live total differs.
- Live figures (the draft):
  - **Timesheet:** `timesheetEngine.computeMonth` over the page's 31-row entries window.
  - **Commission:** `commissionEngine.computeMonth` over the month's `sales_log` (paged with `.range()`,
    as Commissions.tsx does), `commission_splits` and `commission_agents`. The agent is matched by
    `commission_agents.user_id`. An unlinked agent, or one with no result, shows ₱0 and "No commission
    this month".
- Payslip view: "Ｃｈａ　Ｊｅｗｅｌｓ株式会社", "Payslip — September 2026", staff details, timesheet and
  commission sections, Total ₱. Once paid it adds "September 2026 salary ¥x → ₱y", the rate used, the
  paid-on date, "Difference vs payslip total" when the pesos differ, and the proof link.
- Buttons:
  - **Finalize payslip** asks for confirmation first. It is disabled with "Add address and date of birth
    first" when details are missing, and disabled before June 2026.
  - **Record payment:** yen pre-filled `Math.round(total / market rate)` (see Follow-ups), pesos pre-filled with the total,
    paid-on defaulting to today in Japan time, and a proof file is required. It uploads first, then calls
    the RPC; if the RPC fails it says to try again.
  - **Void** asks for a reason.
  - **Download Excel** (finalized or paid). The file is `Payslip_<Name>_<YYYY-MM>.xlsx`, with the name
    reduced to letters, digits and `_`.
- Amber warning on a finalized or paid payslip whose live total differs: "Figures changed after this
  payslip was finalized — void and re-issue to update."
- Before the migration is applied: "Waiting for the database update".

## Follow-ups (2026-10-26, owner 19:24–19:30)

Frontend only — no migration, no edge function. `pdf-lib` 1.17.1 added by the owner-approved deps PR
(owner option B; the first sanctioned dependency change, docs/GIT-WORKFLOW.md).

- **Yen pre-fill from today's market rate** (`src/lib/marketRate.ts`). Record payment fetches ¥→₱ in
  the browser: primary `open.er-api.com/v6/latest/JPY` (`rates.PHP`, as of `time_last_update_utc`),
  fallback `api.frankfurter.dev/v1/latest?from=JPY&to=PHP` (`rates.PHP`, as of `date`). Each has an 8 s
  timeout; only 0.2 < rate < 1.0 is accepted; react-query caches it for 10 minutes; nothing is stored.
  Yen sent = `Math.round(total ÷ market rate)`, filled only while the field is untouched. The dialog shows
  "Market rate today: ¥1 = ₱… (source, as of)", or "Market rate unavailable — enter the yen sent from the
  proof." with the field left empty. It **never** falls back to `system_settings.php_jpy_rate` (0.42).
  This is the one exception to the ONE PESO RATE rule (CLAUDE.md). The rate stored on the payslip is still
  the actual one, `php_received ÷ jpy_sent`. `get_payslip_book` still returns `php_jpy_rate`; the dialog
  no longer reads it.
- **Edit details per row:** every row has "Edit details" (a one-person editor; the top "Staff details"
  button still edits everyone). A payslip blocked by "Add address and date of birth first" shows the same
  button next to the message. Saving refreshes the book.
- **Download PDF** (`src/lib/payslipPdf.ts`, finalized and paid payslips): `Payslip_<Name>_<YYYY-MM>.pdf`.
  Page 1 is the payslip from its STORED figures (corporate layout since 2026-10-27, see "Corporate PDF"
  below; it no longer copies the Excel rows). It is
  drawn on an offscreen A4 canvas at 2.5× with system fonts, because pdf-lib's standard fonts cannot encode
  ₱ or Japanese, then embedded as a PNG. A paid payslip adds the proof after page 1, downloaded through a
  10-minute signed URL:
  - **PDF proof:** every page is copied in.
  - **JPG / PNG proof:** embedded on one A4 page with the caption "Proof of payment — <file> — paid on
    <date>".
  - **WebP / HEIC proof:** decoded by the browser into JPEG first.
  - **Proof that can't be fetched or decoded** (e.g. HEIC on a browser that cannot read it, an encrypted
    PDF): the PDF is still delivered, with a page reading "Proof of payment could not be included — open it
    from the Hub: <file>", and the same note appears as a toast.

  An unpaid payslip is page 1 only, with "Not paid yet". The PDF is built in the browser only; nothing is
  uploaded or stored.
- **Download proof:** a paid payslip downloads the original proof file under its own name, through a
  10-minute signed URL.
- **Excel / PDF rows:** the Payment block now opens with "<Month YYYY> salary ¥x → ₱y" and, after
  "Paid on", has "Proof of payment" with the file name (the part of `proof_path` after the first `/`).

## Corporate PDF (owner 2026-10-27)

The owner found page 1 "too generic, no logo". Only **page 1 of Download PDF** changed. The on-screen
payslip view and the Excel file are unchanged. Frontend only: no migration, no edge function, no package change.

- **Where:** drawing in `renderPayslipPage` (`src/lib/payslipPdf.ts`). The layout rules are pure functions in
  `src/lib/payslipPdfLayout.ts` (`payslipNumber`, `periodLabel`, `headerDetails`, `rightBlockLayout`,
  `earningsRows`, `paymentBlock`, `paymentNote`, `signatureBlock`, `footer`, `proofCaption`). Tests:
  `src/test/payslip-pdf-layout.test.ts`. The canvas is now 3× (`PAGE1_SCALE = 3`), and branding appears on the PDF only.
- **Badge:** `src/assets/brand/cha-jewels-badge-512.webp`, copied unchanged from cha-jewels-web
  `public/images/brand/logo-badge-512.webp` (gold circular "Cha Jewels 株式会社"). It is imported as a Vite
  asset, so it is same-origin and the canvas is never tainted. If the browser cannot decode it, no logo is
  drawn and the PDF is still made. The Hub's `src/assets/cha-jewels-logo.jpeg` reads "Japan Gold", which breaks the gold-terminology rule.
  It is NOT used here. The sidebar still uses it and is untouched.
- **Company constants:** `src/lib/companyInfo.ts` is the single source, copied from cha-jewels-web
  `lib/content/legal.ts` and owner records:
  - `LEGAL_NAME_JA` = Ｃｈａ　Ｊｅｗｅｌｓ株式会社 (full-width, with an ideographic space). `payslips.ts`
    `COMPANY_NAME` now imports it; it was byte-identical.
  - `NAME_EN`, `ADDRESS_EN`, `PHONE`, `EMAIL`, `CORPORATE_NO`, `REPRESENTATIVE`.
- **Layout (A4 portrait, top to bottom):**
  1. **Letterhead band:**
     - Left: badge (64 pt), then five fixed lines (owner review 2026-10-27; nothing wraps inside an item):
       1. Cha Jewels Co., Ltd. (serif, gold-dark)
       2. The Japanese legal name
       3. The address
       4. "Tel · email"
       5. "Corporate No. …"

       Lines 3–5 share one font size: the largest from 8.5 pt down to 8 pt (0.25 pt steps, measured
       with `ctx.measureText`) at which each fits on one line between the badge and the right block.
       Only if the address is still too wide at 8 pt is it broken at the comma before "Tokyo". It is
       never broken inside a number. See `letterheadLines`, `fitFontSize` and `letterheadSmallLines`.
       With the Hub's fonts in Chromium, the address takes the Tokyo break.
     - Right: "PAYSLIP" and the details block (Pay period, Payslip no., Issued, Status; Paid in green).
     - The band is as tall as the taller side, and both sides are top-aligned.
  2. A 2 pt gold rule.
  3. **Two boxes:**
     - **PAID TO:** name, job title only (no engagement label), address, date of birth. These come
       from the stored snapshot.
     - **PAYMENT:**
       - Paid: paid on, yen sent, pesos received, and the rate used. "Difference vs payslip total"
         is added only when the pesos differ from the total.
       - Finalized: "Not paid yet".
  4. **Earnings table** (Earnings | Details | Amount ₱), from the stored breakdowns:
     - CSR: daily pay earned, then the basic salary cap (a negative row when capped, or "— not
       reached"), then the allowance.
     - Live Admin: full days × ₱500, half days × ₱300, and total hours.
     - Commission (only when its total is above 0): the commission, then the Top Sales bonus (only
       when the tier is above 0).
     - **The rows must add up to `total_php` to the centavo.** `assertEarningsMatch` refuses to draw
       a page that does not.
  5. **NET PAY band:** charcoal, with pale-gold text, right-aligned to the amount column.
  6. **Paid only:** "<Month YYYY> salary ¥x → ₱y · Proof of payment attached (page 2)", or "… could
     not be included" when the fallback page is used.
  7. **Signatures**, three equal columns:
     - Prepared by: the finalizer's `profiles.full_name`, via the tab's name map. It is blank when
       unknown, never an id.
     - Approved by: the representative.
     - Received by: "Staff signature and date".
  8. **Footer:** a 1 pt gold rule, "Confidential — for the named recipient only." on the left, and
     "Page 1 of N" on the right.
     - **There is no "Generated by …" line anywhere** (removed by the owner).
     - N is final because the proof is loaded and appended first. Page 1 is rendered last and
       inserted in front.
- **Header alignment rule** (the owner flagged the misalignment):
  - "PAYSLIP" is drawn glyph by glyph, with letter-spacing only BETWEEN glyphs, so its last glyph
    ends exactly at the right content edge. No trailing spacing pushes it left.
  - In the details block, the values all start at one x, set by the widest value, so the block ends
    on the same right edge. The labels are right-aligned a fixed 10 pt gap to the left of the values.
    Lines are equally spaced.
  - `rightBlockLayout` holds this math and is unit-tested.
- **Payslip number:** `PS-YYYY-MM-XXXXXX`, made of the pay month and the first 6 hex characters of the
  payslip id, uppercase. It is shown in the header and in the image-proof caption.
- **Pay period:** the month ("September 2026"). It is never a 1–31 range, because the sheet is a 31-row window.
- **Issued:** `finalized_at` as DD Mon YYYY in Japan time.
- **Proof pages:** unchanged, except the image-proof caption, which is now "Cha Jewels Co., Ltd. — Proof
  of payment — PS-… — <file> — paid on <date>" (WinAnsi-safe).

## Verification (2026-10-26, before the PR)

- `supabase/tests/payslips/run.sh` on a local PostgreSQL 16, with the migration applied twice, against
  stand-ins for auth, roles, `has_role` and `timesheet_can_view_all` (verbatim from the baseline),
  profiles, `timesheet_profiles`, `system_settings`, `audit_logs` and storage. 14 groups passed:
  - shape
  - permission (admin yes; can_view_all yes; CSR, finance, staff, Live Admin and no identity no; anon refused)
  - details validation and field-only audit
  - finalize (month rules, `details_missing`, `name_missing`, `already_issued`, `invalid_figures`,
    `invalid_totals`, unknown keys dropped, snapshot copied server-side)
  - Live Admin keys
  - payment validation (path prefix, `..`, missing file, `php_per_jpy`, paid twice)
  - other staff see nothing; a CSR cannot upload
  - void then re-issue
  - row locks (figure edits, snapshot edits, mixed updates, un-void, DELETE, TRUNCATE, insert-as-paid)
  - direct writes refused
  - audit rows (one per write, real uuids, no figures or personal details)
- Applied on live (see "Live status").

## Cash advances, employee ID, cash bond and April–May (owner 2026-10-27)

Owner-confirmed 2026-10-27 12:05–12:20. Migration `supabase/migrations/20270204100000_payslip_bond_payhistory.sql`
(applied on live — see "Live status"). No edge
function. Pay settings history and the timesheet side: docs/TIMESHEET-SPEC.md "Pay settings history" and
"Inactive staff in past months".

### Owner decisions (locked)

- **A. Cash advances are DEDUCTED:** total earnings (`total_php`) − total cash advances = **net pay**.
- **B.** Several advances per staff member per month, each with its own date and note.
- **C.** Each advance may carry its OWN optional proof (photo or PDF).
- **D. Employee ID:** typed in Edit details; REQUIRED before Finalize; unique ignoring case; 1–30 letters,
  digits and hyphens.
- **E.** Advances can be added and voided any time BEFORE the month's payslip is finalized. They are locked
  once a non-void payslip exists for staff + month (void the payslip and re-issue to change them). Mistakes
  are voided with a reason, never deleted.
- **F.** Gate = `public.can_manage_payslips` (admin, or Brenda's `can_view_all`). Timesheet corrections keep
  `can_correct_timesheet`.
- **G. Hire date:** in Edit details, OPTIONAL (existing staff need none). The pay month containing it is
  the staff member's FIRST pay month.
- **H. Cash bond:** the first-month payslip holds HALF OF NET PAY (after advances):
  `cash_bond_held_php = floor((net_pay_php / 2) to the centavo)`, so an odd centavo stays in the paid half.
  Nothing is held when the payslip is ticked **"Final pay (staff leaving)"**.
- **I. Release:** ONLY on a payslip ticked "Final pay (staff leaving)" (owner 2026-10-27 17:54,
  migration 20270208100000). Until then the bond stays held, month after month. (Before that migration it
  was released on the second month's payslip — retired.)
- **J. Paying in arrears:** a month's work is paid the following month (September's work → the September
  payslip → paid on in October). Already supported (`paid_on ≥ pay_month`).
- **K. Pay settings history:** each month uses the CSR basic salary and allowance IN FORCE for that month
  (docs/TIMESHEET-SPEC.md). Owner fact, loaded separately after apply (not seeded): Brenda's and Kaila's
  allowance was ₱4,000 in April–May 2026 and ₱6,000 from 1 June 2026.
- **L. April–May 2026 are part of the Hub:** payslips, cash advances and timesheet corrections are allowed
  from 2026-04-01 (was 2026-06-01).
- **M. Inactive staff** with timesheet entries in a month (e.g. Cris, who left) appear for that month in
  Consolidation, Cost Master, Full Summary and Payslips, labelled "(inactive)". They are read-only for
  punching and corrections, and a payslip can still be issued for them.

### Release order and feature detection

The frontend ships BEFORE the migration. After the migration `get_payslip_book` returns
`"features": {"cash_advances": true, "employee_id": true, "cash_bond": true, "pay_history": true, "from_april": true}`.
Until then the key is absent, every new control is hidden, and the tab behaves exactly as before:
- finalize uses the 3-argument call;
- details are saved with the 3-argument call;
- payslips start in June 2026.

The timesheet engine falls back to the profile's basic/allowance whenever `timesheet_pay_settings` cannot
be read.

### Tables and columns

- `staff_payroll_details`:
  - `employee_id`: CHECK `^[A-Za-z0-9-]{1,30}$`, plus a UNIQUE index on `upper(employee_id)`.
  - `hire_date`: CHECK `≥ 2020-01-01`.
- `payslips` (existing rows are not updated; `ADD COLUMN` fires no row trigger):
  - Snapshot: `employee_id`, `hire_date`.
  - Advances: `cash_advances` (jsonb array of `{id, advance_date, amount_php, note, proof_path}`) and
    `cash_advance_php` (0 ≤ x ≤ `total_php`).
  - `net_pay_php`, GENERATED as `total_php − cash_advance_php`.
  - `is_final_pay`.
  - Cash bond: `cash_bond_held_php` (0 ≤ x ≤ net pay), `cash_bond_released_php` and
    `cash_bond_source_payslip_id` (FK; set exactly when something is released).
  - `amount_due_php`, GENERATED as `total_php − cash_advance_php − cash_bond_held_php + cash_bond_released_php`.
  - `total_php` still means gross earnings.
  - A partial UNIQUE index allows one live (non-void) release per source payslip.
  - Existing rows read: advances `[]` and 0, bond 0, `net_pay_php = amount_due_php = total_php`.
- **`payslips_before_write` freezes every new column.** It compares the whole row minus the payment
  (or void) fields. It now also leaves out the two GENERATED columns, because in a BEFORE UPDATE trigger
  they read as NULL in `NEW` and every payment and void would otherwise be refused. Both are computed
  only from frozen columns. (Verified on PG 16; harness Q1b and Q1c.)
- `payslip_cash_advances` (new):
  - Columns: `id`, `user_id`, `pay_month` (1st of month), `advance_date`, `amount_php > 0`, `note`
    (1–200, trimmed), `proof_path`, `status` (`active | void`), `void_reason`, `created_by/at`,
    `voided_by/at`, `payslip_id`.
  - `proof_path` is NULL or `advances/<id>/…`.
  - Index on `(user_id, pay_month)`.
  - Read RLS is the payslip gate. There are no write policies, and writes are revoked from PUBLIC, anon
    and authenticated.
  - Row trigger:
    - DELETE is refused.
    - INSERT only as active with no payslip.
    - UPDATE only on an active row, and only one of: proof `NULL → set`, `active → void` (void fields
      only), or `payslip_id` set (by finalize).
  - TRUNCATE is refused.

### RPCs (gate first; jsonb `{ok}` / `{error}`; audit rows carry no amounts, notes or personal values)

| RPC | does | refusals |
|---|---|---|
| `save_staff_payroll_details(p_user_id, p_address, p_date_of_birth, p_employee_id, p_hire_date)` (new 5-argument overload; the 3-argument one is unchanged and never touches the new columns) | upsert incl. employee ID (trimmed, empty → null) and hire date; audit lists changed field names | the 3-argument ones + `invalid_employee_id`, `employee_id_taken`, `invalid_hire_date` (before 2020 or more than a year after today, Japan time) |
| `add_cash_advance(p_user_id, p_pay_month, p_advance_date, p_amount_php, p_note)` | one active advance (staff with a timesheet profile, active or not) | `staff_not_found`, `invalid_month` (2026-04 .. this month, Japan time), `invalid_date` (before the 1st of LAST month or after today, Japan time — both bounds are relative to today), `invalid_amount` (≤ 0, > 2 decimals), `note_required`, `note_too_long`, `month_finalized` (same advisory lock as finalize) |
| `attach_cash_advance_proof(p_id, p_path)` | sets the proof once | `not_found`, `advance_void`, `proof_already_attached`, `month_finalized`, `proof_required`, `invalid_proof_path` (must be `advances/<p_id>/<file>`, no sub-folder, no `..`), `proof_missing` (not in the bucket) |
| `void_cash_advance(p_id, p_reason)` | active → void (reason 3–500) | `reason_required`, `not_found`, `already_void`, `month_finalized` |
| `get_payslip_book(p_pay_month)` | every existing key, plus `features`, `cash_advances` (month, all statuses, newest first), `pay_settings` (all rows for the staff listed), `details` also for INACTIVE profiles with entries in the 31-row window, and per details entry `employee_id`, `hire_date`, `active`, `first_month_issued`, `cash_bond_pending {source_payslip_id, pay_month, amount}`; each payslip carries `cash_bond_source_month` | unchanged |
| `finalize_payslip(p_user_id, p_pay_month, p_payload, p_is_final_pay)` (new 4-argument) | see below | the old ones + `details_missing` now also when the employee ID is missing, `pay_settings_mismatch`, `cash_bond_order`, `advance_exceeds_pay` |
| `finalize_payslip(p_user_id, p_pay_month, p_payload)` | thin wrapper: the 4-argument call with `false` (the frontend released before the migration keeps working) | same |

**Deviation from the prompt:** the 4th argument has **no `DEFAULT false`**. In PostgreSQL a 3-argument
call matching both `f(a,b,c)` and `f(a,b,c,d DEFAULT …)` fails with "function … is not unique", for
positional and named calls alike (PostgREST included). That would break the old frontend. Verified on
PG 16. The new frontend always passes all four.

**finalize_payslip (4 arguments), in order:**
1. The month floor is 2026-04-01. An inactive profile is accepted.
2. A per-staff bond lock, then the month lock.
3. The employee ID is required (`details_missing`).
4. `cash_bond_order` when the hire month is from 2026-04, this month is later, and no non-void hire-month
   payslip exists.
5. For a CSR, the payload's `basic_salary` / `monthly_allowance` must equal the settings in force for the
   month: the latest `timesheet_pay_settings` row with `effective_from ≤ the 1st`, each field falling back
   to the profile (`pay_settings_mismatch`).
6. The ACTIVE advances are read SERVER-SIDE, ordered by date, into `cash_advances`, and
   `cash_advance_php` is their sum (`advance_exceeds_pay` when it is above `total_php`).
7. The bond is decided:
   - In the hire month and not final pay: `held = floor((total − advances) × 50) / 100`.
   - Otherwise: the latest non-void payslip with `held > 0` and no non-void payslip releasing it is
     released ONLY when final pay is ticked (migration 20270208100000; the month + 1 release is retired).
8. `employee_id`, `hire_date` and `is_final_pay` are snapshotted, and `payslip_id` is set on the advances.
   One audit row records `is_final_pay`, the number of advances and the bond kind (no amounts).

Voiding the first-month payslip removes its bond (nothing pending). Voiding the releasing payslip makes
the bond pending again, and a re-issue releases it again. Voiding a first-month payslip AFTER its bond was
released leaves the release on the final-pay payslip, so void that one too and re-issue both.

### Storage

New INSERT policy "Payslip managers can upload cash advance proofs". It allows `payslip-proofs` objects
at `advances/<id>/<file>` only when all of these hold:
- the caller passes the gate;
- `<id>` is an ACTIVE advance with no proof;
- that advance's month has no non-void payslip;
- there is a file name, no sub-folder and no `..`.

There is no update or delete policy. The existing read policy (the gate) covers the folder, and the Hub
opens proofs with 10-minute signed URLs.

### Screens

- **Edit details:** "Employee ID (required to finalize)" and "Hire date (optional)". The finalize
  block reads "Add employee ID, address and date of birth first".
- **Row button "Cash advances"**, with the active count. It opens "Cash advances — <Name>, <Month YYYY>":
  - The list shows date, amount, note, the proof link, Active/Void plus reason, Void (asks for a reason)
    and Attach proof.
  - "Add advance": date (default today in Japan time; from the 1st of last month), amount ₱, note, and
    an optional proof (JPG/PNG/WebP/HEIC/PDF, ≤ 10 MB). It saves the advance, then uploads, then
    attaches. If the upload or attach fails, the advance stays and the toast says to use Attach proof.
  - Read-only once the month is finalized: "This month's payslip is finalized — void it to change
    advances".
- **Payslip view:**
  - Staff box: adds Employee ID.
  - After commission: one row per advance, "Less: Cash advance — <DD Mon YYYY> · <note>"; then "Total
    earnings", "Total cash advances", "Net pay"; then "Less: Cash bond — first-month pay (50% held)" or
    "Cash bond released — <Month YYYY>"; then "Amount due" (finalized) or "Amount paid" (paid), which is
    `amount_due_php`.
  - The draft computes the same from live data. When the hire date falls in the month it adds the note
    "First pay month — 50% held as cash bond".
  - Older payslips keep "Total".
- **Finalize dialog:** "Final pay (staff leaving)" with "Releases any cash bond on this payslip; no bond
  is held." and the bond held or released.
- **Record payment:**
  - Pesos are pre-filled with `amount_due_php` (falling back to `net_pay_php`, then `total_php`).
  - Yen = that ÷ today's market rate.
  - The difference line compares the pesos with the amount due ("Difference vs amount due"; older
    payslips keep "Difference vs payslip total").
- **Excel:** an "Employee ID" row; the advance rows, "Total earnings", "Total cash advances", "Net pay",
  the cash bond row and "Amount due" / "Amount paid" (older payslips keep "Total").

### PDF (page order and labels)

- **PAID TO:** adds "Employee ID: …", omitted when null (older payslips).
- **After the earnings table:**
  - one row per advance: "Less: Cash advance — <DD Mon YYYY> · <note>" (negative);
  - "Total earnings / Total cash advances / Net pay";
  - the cash bond row;
  - the dark band: **AMOUNT DUE** (finalized) or **AMOUNT PAID** (paid), equal to `amount_due_php`.
    Older payslips keep **NET PAY** = `total_php`.
- **Checks:** the earnings rows must still add up to `total_php`, and earnings − advances − held +
  released must equal `amount_due_php` (`assertDeductionsMatch`). Otherwise the page is not drawn.
- **Pages:** 1, the payslip; then the payday proof (paid only); then each advance proof that exists, in
  advance-date order:
  - a PDF proof's pages are copied in;
  - an image gets one page with the caption "Cha Jewels Co., Ltd. — Cash advance — <DD Mon YYYY> —
    <file name>";
  - an unreadable proof gets the page "Cash advance proof could not be included — open it from the Hub:
    <file>", plus a toast.
- **Paid line:** "<Month YYYY> salary paid on <DD Mon YYYY>: ¥x → ₱y · Proof of payment attached (page 2)",
  plus ", cash advance proofs pages a–b" when there are any. An unpaid payslip with advance proofs reads
  "Cash advance proofs attached (pages a–b)".
- **Footer:** "Page 1 of N". There is no "Generated by" line.

### Tests

- **SQL** (local PostgreSQL 16, stand-ins only; never a Lovable database):
  - `supabase/tests/payslips/run.sh` phase 2: 20270201, 20270202, a seed of payslips issued the old
    way, then 20270204 applied twice. The groups are Q1–Q8:
    - shape, and existing rows unchanged;
    - payment and void through the patched trigger; the new columns frozen;
    - the pay settings RPC: admin only, month rules, `not_csr`, amounts, `payslips_issued`, profile sync,
      audit without amounts, never deleted, read audience;
    - employee ID and hire date, and the old 3-argument save keeping them;
    - the April floor, inactive staff, `pay_settings_mismatch`, `details_missing`, the old 3-argument
      finalize, book features and inactive listing;
    - advances: every refusal, proof path and storage rules, void, month lock, snapshot, relink after
      void + re-issue, `advance_exceeds_pay`, row locks, direct writes, read gate;
    - cash bond: held with the odd centavo, release on month + 1, void + re-issue, first-and-final,
      `cash_bond_order`, no release at month + 2, an early release on final pay;
    - corrections from April;
    - audit.
  - `supabase/tests/timesheet-corrections/run.sh` phase 2 (T11): March refused, 1 April and 31 May
    allowed, the other rules unchanged.
- **Vitest:**
  - `src/test/payslip-advances-bond.test.ts`: the bond preview, breakdown and amount-due logic, Excel,
    feature detection, forms and refusals, PDF rows, the paid line, and page counts with 0/1/2 advance
    proofs plus the fallback;
  - `src/test/payslips-tab-advances.test.tsx`: the screens;
  - `src/test/timesheet-pay-history.test.tsx`: the engine, the fixtures, inactive staff, month options
    and the Assignments flow;
  - fixtures: `src/test/fixtures/april-2026-cholita.json` and `may-2026-cris-midnight.json` (synthetic;
    no live data).

## Second proof file (owner 2026-10-27 13:15)

Migration `20270205100000_payslip_second_proof.sql`. The owner asked for two attachments where there was one,
on both the proof of payment and each cash advance, and chose that a forgotten 2nd payment file can be added
after the payment is recorded.

### Owner decisions (locked)

- Up to **2** files on the proof of payment and up to **2** on each cash advance.
- **Payment:** the 2nd file can be added together with the payment ("Proof of payment (2nd file, optional)"
  in Record payment), or later on the paid payslip ("Add 2nd proof"), once. Nothing else on a paid payslip
  can change.
- **Cash advance:** the 2nd file can be added with the advance or later ("Attach 2nd proof"), only while the
  month has no non-void payslip (the same lock as before).

### Database

- **Columns:** `payslips.proof_path_2` and `payslip_cash_advances.proof_path_2`, both optional.
  - Each needs the 1st proof and must differ from it.
  - Paths: `<payslip_id>/<file>` for payments, `advances/<advance id>/<file>` for advances.
- **`record_payslip_payment`:**
  - New 6-argument version `(…, p_proof_path text, p_proof_path_2 text)`; the 2nd file may be null or empty.
  - It is checked like the 1st (shape, not the same file, uploaded).
  - The 5-argument version is a thin SQL wrapper that passes null. Neither has a default, so no call is
    ambiguous.
- **`attach_payslip_proof(p_id, p_path)`:** adds the 2nd file to a **paid** payslip with none. Refuses
  `permission_denied`, `not_found`, `not_paid`, `second_proof_attached`, `proof_required`,
  `invalid_proof_path` (wrong shape or the 1st file), `proof_missing`.
- **`attach_cash_advance_proof`:** fills slot 1, then slot 2. A 3rd file is refused with
  `proof_already_attached`; the 1st file again with `invalid_proof_path`. The audit row names the slot.
- **`payslips_before_write`:** `proof_path_2` is a payment field, set while recording the payment. It also
  allows **paid → paid** with exactly one change: `proof_path_2` from empty to set. Replacing or removing
  it, or any other edit of a paid payslip, is refused.
- **`payslip_cash_advances_before_write`:** also allows `proof_path_2` from empty to set, once the 1st proof
  is set, nothing else.
- **`finalize_payslip`:** the `cash_advances` snapshot carries `proof_path_2` (the only change).
- **`get_payslip_book`:** `features.second_proof = true` (the only change).
- **Storage upload policies (replaced):**
  - Payment proofs: also while the payslip is paid and has no 2nd file.
  - Advance proofs: while either slot is empty.

### Release order

Frontend first: the 2nd pickers, "Add 2nd proof" and "Attach 2nd proof" appear only when the book reports
`features.second_proof`. Before that, Record payment uses the 5-argument call and advances stop at one proof.
Then the migration is applied (guarded: each replaced function must still match its live md5 or this
migration's version).

### Screens, Excel, PDF

- **Payslip view (paid):**
  - One line per file: "Open proof of payment (1 of 2)" and "Download proof (1 of 2)". A single file keeps
    the old labels.
  - "Add 2nd proof" while the 2nd file is empty.
- **Cash advances:**
  - The add form has "2nd proof (optional)".
  - Each row shows "Open proof 1 / 2", or "Attach proof" / "Attach 2nd proof" while a slot is free.
- **Excel:** "Proof of payment (2nd file)" under "Proof of payment".
- **PDF:**
  - The payment proof files follow page 1 in order, captioned "Proof of payment (1 of 2)" and "(2 of 2)".
  - Each advance's files follow in order (1st, then 2nd).
  - Page 1 names the real proof pages ("Proof of payment attached (pages 2–3)").
  - A file that cannot be included gets its own fallback page and its own warning.

### Tests

- SQL harness phase 3 (`supabase/tests/payslips/test_second_proof.sql`, after phase 2 and the `pre5_*`
  snapshots; the migration applied twice), groups S1–S7:
  - S1: existing rows unchanged, overloads, policies;
  - S2: two files at payment, with every refusal;
  - S3: one file, then the 2nd later, plus void;
  - S4: the gate;
  - S5: direct writes;
  - S6: advance slots 1/2/never 3, storage and the finalize snapshot;
  - S7: audit.
- Vitest `src/test/payslip-second-proof.test.tsx` (16): Record payment with 1 or 2 files and before the
  update, Add 2nd proof, two-file view, advance slots, helpers, refusals, Excel, PDF pages and fallback.

## Bonuses (owner 2026-10-27 14:04)

Migration `20270206100000_payslip_bonuses.sql`.

### Owner decisions (locked)

- **Categories:**
  - **Performance / KPI bonus** (`performance`)
  - **Holiday / Christmas bonus** (`holiday`)

  The commission **Top Sales bonus** stays as it is: automatic, from the commission.
- **Entry:** typed per month, like cash advances. Admin or Brenda enter each bonus on the Payslips tab before
  Finalize, with a category, date, amount and note. A month can have several. A mistake is voided with a
  reason, never deleted. Bonuses lock once the month's payslip is finalized.
- **Earnings:** bonuses are earnings. Total earnings = timesheet pay + commission + bonuses.
  Net pay = total earnings − cash advances.
- **Cash bond:** a new hire's first-month cash bond is half of that net pay, so it **includes** bonuses.
- **Proof:** each bonus has up to **2** optional proof or approval files (photo or PDF). They are added to the
  payslip PDF.

### Database

- **`payslip_bonuses`:**
  - Columns: `category`, `bonus_date` (2026-04-01 .. today Japan time), `amount_php` (> 0, 2 decimals),
    `note` (1–200), `proof_path`/`proof_path_2` (`bonuses/<id>/<file>`), `active | void`, `payslip_id`.
  - The before-write trigger allows only a proof slot being filled, void, or linking to a payslip. DELETE
    and TRUNCATE are refused.
  - Read RLS = `can_manage_payslips`; there are no write policies.
- **`payslips`:**
  - New columns: `bonuses` (the frozen snapshot) and `bonus_php`.
  - **`payslips_total` is replaced** with `total_php = timesheet_net_php + commission_php + bonus_php`.
    Every existing row has `bonus_php = 0`.
  - `payslips_before_write` is unchanged: the new columns are snapshot columns, so they stay frozen.
- **RPCs:**
  - `add_payslip_bonus(p_user_id, p_pay_month, p_bonus_date, p_category, p_amount_php, p_note)`.
  - `attach_payslip_bonus_proof(p_id, p_path)`: slot 1, then slot 2.
  - `void_payslip_bonus(p_id, p_reason)`.
  - Refusals:
    - adding: `invalid_bonus_date`, `invalid_category`, `bonus_note_required`;
    - month and status: `bonus_month_finalized`, `bonus_void`, `bonus_already_void`;
    - proofs: `bonus_proofs_full`;
    - the same codes as cash advances for the gate, amount, note length, month and proof path.
  - Audit rows carry no amounts or notes.
- **`finalize_payslip` (4-argument):**
  - It sums the month's **active** bonuses on the server. The client payload still carries timesheet +
    commission only.
  - It stores `total_php` = payload total + bonuses, `bonus_php` and the snapshot, and links the bonuses.
  - `advance_exceeds_pay` and the first-month cash bond use earnings including bonuses.
- **`get_payslip_book`:** the month's `bonuses` (all statuses) and `features.bonuses`.
- **Storage:** the policy "Payslip managers can upload bonus proofs" allows an upload while the bonus is
  active, a slot is free and the month is open.

### Screens, Excel, PDF

- **Payslips tab:**
  - Each row has a **Bonuses** button with the active count.
  - The dialog has a list (Open proof 1/2, Attach proof / Attach 2nd proof, Void with a reason) and an
    **Add bonus** form: category, date, amount, note, proof and 2nd proof.
  - A row's draft total includes its active bonuses.
- **Payslip view:**
  - Each bonus appears as "Add: Performance / KPI bonus — 30 Sep 2026 · note" in "Bonuses, deductions and
    cash bond", and Total earnings includes it.
  - The "figures changed" warning compares live timesheet + commission with `total_php − bonus_php`
    (`storedFiguresTotal`).
- **Excel:** the same "Add: …" rows.
- **PDF:**
  - Each bonus is an earnings row (category, then "date · note", then the amount).
  - Bonus proofs follow the cash advance proofs, captioned with the category and date.
  - The page note names "bonus proofs pages x–y".
  - A file that cannot be included gets a fallback page and a warning.

### Release order

Frontend first: the Bonuses button appears only when the book reports `features.bonuses`. Then the migration
is applied (guarded by the live md5s of `finalize_payslip` (4-argument) and `get_payslip_book`).

### Tests

- SQL harness phase 4 (`supabase/tests/payslips/test_bonuses.sql`, after phase 3 and the `pre6_*` snapshots;
  the migration applied twice), groups B1–B9:
  - B1: shape, with existing rows unchanged;
  - B2: add, every refusal, and void;
  - B3: proof slots, paths and storage;
  - B4: the gate and RLS;
  - B5: finalize with bonuses, the month lock, and void + re-issue relinking;
  - B6: the cash bond including bonuses (odd centavo);
  - B7: advances covered by bonuses;
  - B8: direct writes;
  - B9: audit.
- Vitest `src/test/payslip-bonuses.test.tsx` (11): the row button, count and draft total; add with 2 proofs;
  void; the draft view; a finalized payslip (no false "changed", locked); helpers; Excel; PDF rows, pages
  and note; form rules and refusals.

## Cash bond release: Final pay only (owner 2026-10-27 17:54)

Migration `supabase/migrations/20270208100000_payslip_bond_final_pay_only.sql`. No edge function.

- **Rule:** the hire-month bond stays held while the staff member works. It is added back ONLY on her last
  salary — the payslip ticked **"Final pay (staff leaving)"**. It is never released automatically in the
  month after the hire month.
- **Database:** one line in `payslip_issue` (the release condition becomes `IF FOUND AND v_final`); the
  COMMENTs of `payslip_issue` and `finalize_payslip` (4 arguments) reworded. Guarded by the live prosrc md5
  of `payslip_issue` (`333273fbbe594689dc7c1127e238772b`). Existing payslips are not touched.
- **Screen:** `bondPreview` (src/lib/payslips.ts) shows "Cash bond released" only when Final pay is ticked.
- **Unchanged:** hire-month hold (half of the timesheet net), typed bond (Edit figures), `bond_exceeds_pay`,
  `bond_already_released`, `cash_bond_pending` in the book.
- **Live data at the change (2026-10-27):** Gay Marie June Paid holds ₱7,778 (both July payslips Void);
  Richell Rivera June Paid holds ₱9,000, July Paid with nothing released. Both bonds stay held until Final pay.
- **Tests:** vitest `payslip-advances-bond` ("released ONLY on Final pay"); SQL harness phase 6
  `test_bond_final_pay.sql` (F1 shape + rows unchanged, F2 no automatic release, F3 final pay releases).

## Edit figures and the cash bond (owner 2026-10-27 15:20–15:32)

Migration `supabase/migrations/20270207100000_payslip_edit_figures.sql` (frontend first; gated by
`get_payslip_book` `features.edit_figures`). This **replaces the locked "never edited — void and re-issue"
rule** for figures: the payslip row itself still never changes, but Edit figures voids it and issues the
corrected one in one step.

### Owner decisions (locked)

- **Edit figures:** every pay line can be typed by hand — days, hours, sum of daily pay, basic salary cap,
  allowance, weeks forfeited, Live Admin ₱500/₱300 days, commission earnings and top-sales bonus, and the
  cash bond. A reason (3–500 characters) is required. Totals recalculate as the engines do. The payslip
  view, Excel and PDF show "Manually corrected (replaces payslip no. PS-…) — <reason>".
- **On a Finalized or Paid payslip, Edit = automatic void + re-issue:** the old one becomes Void
  ("Corrected: <reason>"), the corrected one is issued in its place; history stays.
- **A Paid payslip keeps its payment:** yen, pesos, rate, paid-on, paid by/at and both proof files are copied,
  so the corrected payslip is Paid.
- **Cash bond = half of the salary (timesheet net pay) only:** salary ₱10,000 → bond ₱5,000. Commission and
  bonuses are excluded; cash advances are not taken off first. The bond can be typed in Edit figures (not on
  final pay). It can never be more than the pay left after advances (`bond_exceeds_pay`).

### Database

- `payslips.correction_reason` (null, or trimmed 3–500) and `payslips.corrected_from_payslip_id` (the voided
  one; needs a reason). Both are snapshot columns set on INSERT; `payslips_before_write` is unchanged.
- The proof CHECKs are now by shape (`<uuid>/<file>`, no `..`): a copied proof stays in the folder of the
  payslip it was uploaded for. `record_payslip_payment` and `attach_payslip_proof` still require `<own id>/`.
- `payslip_issue(...)` (internal, not executable by clients) is the one issuing path. `finalize_payslip`
  (3 and 4 arguments) is unchanged for callers; new **5-argument** `finalize_payslip(…, p_correction_reason)`
  = finalize with typed figures (the pay-settings match is skipped, arithmetic checks stay, the payload may
  carry `cash_bond_held_php`).
- New `correct_payslip(p_id, p_payload, p_is_final_pay, p_reason)`: one transaction; refuses
  `reason_required`, `not_found`, `already_void`, `bond_already_released` (its bond was released on a later
  payslip — correct that one first) and every finalize refusal; on any refusal nothing changes. The month's
  advances and bonuses move to the corrected payslip. Audit: the void row and a `correct_payslip` row
  (`manual`, `corrected_from`; no figures).

### Screens

- Payslip view: **Edit figures** on the draft (next to Finalize) and on Finalized / Paid payslips (next to
  Void). The dialog shows every line, the recalculated totals (earnings, advances, bond held/released,
  amount due), "Final pay", the cash bond field ("Use half of salary"), and the reason. Save: "Save and
  finalize" (draft) or "Save and re-issue".
- A corrected payslip shows the "Manually corrected …" note; the held-bond line reads "Less: Cash bond held"
  (not "50% held") on corrected payslips.
- The "figures changed" warning and the Finalize confirmation point to Edit figures once the feature is on.

### Tests

- SQL harness phase 5 (`test_edit_figures.sql`, `pre7_*` snapshots, migration applied twice), E1–E9: shape
  and existing rows unchanged; bond = half of timesheet pay and its release; 5-argument finalize (reason,
  typed basic, typed bond, refusals); correct a Finalized payslip (one transaction, refusal rolls back,
  advances move, audit); correct a Paid payslip twice (payment and both proofs from two folders copied, 2nd
  proof still addable); bond already released; gate; book; direct writes.
- Vitest `src/test/payslip-edit-figures.test.tsx` (12): recalculation (CSR, Live Admin), validation, payload,
  salary-only bond preview, labels on screen/Excel/PDF, refusals, hidden before the migration, draft
  finalize with a reason, paid correction with a typed bond, refusal toast, corrected view.
