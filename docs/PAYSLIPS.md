# Timesheet → Payslips

Owner-confirmed plan 2026-10-26. Migration `supabase/migrations/20270201100000_staff_payslips.sql`.
No edge function. UI: `src/components/timesheet/PayslipsTab.tsx`; rules: `src/lib/payslips.ts`;
tests: `src/test/payslips.test.ts`, `src/test/payslips-tab.test.tsx`, SQL harness `supabase/tests/payslips/`.

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
- Not applied to any live database. The owner applies it through the Lovable DB connection after release.
