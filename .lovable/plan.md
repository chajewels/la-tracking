# Security scan — full verbatim findings report (READ-ONLY)

## Scan metadata

- Scanner with findings: `agent_security_v2`, version **1.91**, completion_status **complete**, timestamp **2026-10-03T03:01:33.040406246Z**, **up_to_date: false** (the panel marks this scan as NOT up to date / stale).
- Other scanners ran at the same time and returned **zero findings**: `app_mcp` (v1.0), `app_mcp_deep` (v1.1), `lov_pgscan` (v0.2.1), `supply_chain` (v2.2.0, timestamp 2026-10-03T02:58:09Z). `connector_security_scan` (v1.0) is **incomplete**, last run 2026-06-12T07:00:30Z, zero findings.
- **Total count: the raw result lists 33 findings** (not 14). The earlier "14" figure does not match the current payload.
- The payload carries **no per-finding status field** (no new/open/resolved/ignored marker). Every finding has `"projected_from_verdict": true` and `"lovable/verificationConfirmed/v1": "true"`. Some carry `lovable/previousFindingRecheck` + `lovable/verifiedPreviousResolutionSnapshot` (re-checked from a previous scan); one carries `lovable/unconfirmedRescans/v1: "1"`. These are noted per finding where present.
- Level mapping in the raw data: `error` = Critical-severity row, `warn` = Warning.

---

## Finding 1
- **Title:** Anyone with a portal link can bypass the PIN
- **Level:** error | **Category:** account_security | **ID:** CLIENT_SIDE_AUTH / `lov_finding_1008351ca812d953`
- **Description:** "Anyone with a customer portal link can view account details without the PIN, so customer balances and purchase history are exposed."
- **Details (verbatim):** "Entry: Anyone holding an active customer portal token can supply it as the GET route's token query parameter; the server authenticates the token but does not require PIN verification.\nOperation: Query the token owner's layaway-account records.\nImpact: Customer portal account details and purchase histories are fetched from the database and returned to callers without verifying the PIN on the server.\n\nLocation: Customer portal PIN gate"
- **Points at:** `supabase/functions/customer-portal/index.ts` (entry lines 287, 293; impact line 321–325 `supabase.from("layaway_accounts").select("*").eq("customer_id", customerId)...` and line 1097–1152 the full customer JSON response)
- **Control:** LOV.AUTH.SERVER_ENFORCED_SHARED_PASSWORD.V1 — "Shared-password gates are enforced on the server"
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** none (no new/open/resolved field); fingerprint includes `lovable/unconfirmedRescans/v1: "1"`

## Finding 2
- **Title:** Anyone can trigger loyalty image deletion
- **Level:** warn | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_10d6b8429777b04d`
- **Description:** "Anyone can invoke the scheduled loyalty image cleanup function using an unverified JWT with a service_role claim to delete unreferenced storage files."
- **Details (verbatim):** "Entry: Anyone can call the Deno.serve HTTP handler and provide an Authorization bearer token.\nOperation: Remove the computed orphan files from the loyalty images bucket.\nImpact: An unauthenticated caller supplying an unverified JWT with role service_role deletes files from the loyalty-images Supabase storage bucket and inserts audit records.\n\nLocation: supabase/functions/cleanup-loyalty-images/index.ts"
- **Points at:** `supabase/functions/cleanup-loyalty-images/index.ts` (entry lines 111, 116; impact lines 263–265 `supabase.storage.from(LOYALTY_IMAGES_BUCKET).remove(orphans)`)
- **Control:** LOV.EP.INTERNAL_ENDPOINT_SHARED_SECRET.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** `previousFindingRecheck` + `verifiedPreviousResolutionSnapshot` present (re-checked from earlier scan)

## Finding 3
- **Title:** Service callers can expose customer emails in server logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_1407dcbe28785c56`
- **Description:** "A service caller triggering loyalty inactivity checks can cause customer email addresses to be logged in server diagnostics when emails are suppressed, exposing personal contact details."
- **Details (verbatim):** "Entry: The action processes loyalty members and sends warning messages using their recipient email addresses.\nOperation: Write the recipient email address to the server log when a loyalty email is suppressed.\nImpact: Logging customer email addresses on email suppression exposes customer personal identifiable information in server logs.\n\nLocation: supabase/functions/loyalty-inactivity-check — loyalty email diagnostic"
- **Points at:** `supabase/functions/loyalty-inactivity-check/index.ts` line 83, function `sendEmail`: `console.log(`[loyalty-inactivity-check] templateName suppressed for ${recipientEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 4
- **Title:** Anyone can write payment tracking rows with a forged JWT
- **Level:** error | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_16c0c9a0d7d9b398`
- **Description:** "Anyone can forge a JWT with role service_role to append or modify tracking rows in private Google Sheets without valid service-role credentials."
- **Details (verbatim):** "Entry: The public HTTP handler accepts an Authorization bearer token and relies on isServiceRole before accessing private payment tracking data.\nOperation: PUT payment-tracking values to the Google Sheets spreadsheet\nImpact: An attacker with an unverified JWT carrying role: service_role can make authenticated external Google Sheets PUT API calls modifying spreadsheet cells.\n\nLocation: supabase/functions/append-payment-tracking/index.ts"
- **Points at:** `supabase/functions/append-payment-tracking/index.ts` (entry lines 76–77; impact lines 169–173, the Google Sheets `PUT .../values/...?valueInputOption=USER_ENTERED` fetch)
- **Control:** LOV.EP.PRIVATE_DATA_CALLER_AUTH.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 5
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_2143864471d1c155`
- **Description:** "Anyone whose order or account action triggers a customer email can cause its recipient's address to appear in system logs, so customer contact details are exposed beyond their sessions."
- **Details (verbatim):** "Entry: Order and account actions pass the customer's email address into the shared storefront email sender.\nOperation: Write the email destination address to the server log for each shared email outcome.\nImpact: Customer email addresses are emitted into server diagnostic logs visible to log-viewing roles.\n\nLocation: supabase/functions/_shared/storefront-email.ts — shared email diagnostics"
- **Points at:** `supabase/functions/_shared/storefront-email.ts` line 122: `console.log(JSON.stringify({ storefront_email: label, reference, to: email || null, outcome, ...extra }))`; entry via `supabase/functions/cancel-cash-order/index.ts` line 84
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 6
- **Title:** Admins can log customer email addresses
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_2a7aa146a18d4ffa`
- **Description:** "An administrator running bulk setup invites can cause customer email addresses to be written to server logs when sends are suppressed, exposing personal data."
- **Details (verbatim):** "Entry: An administrator triggers a batch of setup invitations, whose candidate records supply customer email addresses.\nOperation: Write a candidate's email address to the server log when an invitation is suppressed.\nImpact: The endpoint logs the candidate customer's cleartext email address to server console logs when email delivery is suppressed.\n\nLocation: supabase/functions/bulk-send-setup-invites — invite suppression diagnostic"
- **Points at:** `supabase/functions/bulk-send-setup-invites/index.ts` line 181: `console.log(`[bulk-send-setup-invites] portal-setup-invite suppressed for ${c.email}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 7
- **Title:** Anyone can trigger penalty calculations and fees
- **Level:** warn | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_2c15b308b4a3df69`
- **Description:** "Anyone can invoke the penalty engine using an unverified JWT with a service_role claim to generate and insert penalty fee records into the database."
- **Details (verbatim):** "Entry: Anyone can provide a bearer token to the publicly reachable HTTP handler.\nOperation: Insert computed penalty fee records.\nImpact: Executing the penalty engine inserts penalty fee rows into penalty_fees and updates layaway schedule records in the database.\n\nLocation: supabase/functions/penalty-engine/index.ts"
- **Points at:** `supabase/functions/penalty-engine/index.ts` (entry lines 48, 55; impact line 521 `supabase.from("penalty_fees").insert(chunk)`)
- **Control:** LOV.EP.INTERNAL_ENDPOINT_SHARED_SECRET.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** none

## Finding 8
- **Title:** Caller-chosen Drive files accessed with service credentials
- **Level:** warn | **Category:** access_control | **ID:** PUBLIC_DATA_EXPOSURE / `lov_finding_2d2ceb48014e10a4`
- **Description:** "A permitted staff caller can supply a Drive file ID and cause privileged service-account access to that file without a per-file authorization check."
- **Details (verbatim):** "Entry: supabase/functions/fill-payment-tracking/index.ts accepts an authenticated admin/staff/finance/csr caller's request-supplied `fileId` and uses the service-account token to copy that Drive file, then reads its roster and returns a generated tracking sheet. The code does not establish that the caller is authorized to access that particular file.\nOperation: Copies the request-selected Drive file using the privileged service-account token.\nImpact: Privileged Google Drive service account credentials copy and read arbitrary caller-chosen Google Drive file IDs.\n\nLocation: supabase/functions/fill-payment-tracking/index.ts"
- **Points at:** `supabase/functions/fill-payment-tracking/index.ts` (entry line 124; impact lines 135–139, the `https://www.googleapis.com/drive/v3/files/${fileId}/copy` fetch)
- **Control:** LOV.AC.DATABASE_OWNERSHIP_ENFORCEMENT.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 9
- **Title:** Anyone can trigger loyalty sheet reconciliation
- **Level:** warn | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_39fd271c965935fe`
- **Description:** "Anyone can trigger the loyalty sheet reconciler using an unverified JWT with a service_role claim to emit transaction batches to external sheets."
- **Details (verbatim):** "Entry: Anyone can call the HTTP handler with a caller-controlled Authorization bearer token.\nOperation: POST loyalty transaction-derived data to the sheet synchronization endpoint.\nImpact: An unauthenticated caller supplying an unverified JWT with role service_role triggers HTTP POST requests fanning out data to an external sync service and updates the database.\n\nLocation: supabase/functions/loyalty-sheet-reconcile/index.ts"
- **Points at:** `supabase/functions/loyalty-sheet-reconcile/index.ts` (entry lines 41, 44; impact lines 230–234 `fetch(syncSheetUrl, { method: "POST", ... })`)
- **Control:** LOV.EP.INTERNAL_ENDPOINT_SHARED_SECRET.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** `previousFindingRecheck` + `verifiedPreviousResolutionSnapshot` present

## Finding 10
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_3bbc674d2b8af301`
- **Description:** "Anyone triggering loyalty redemption or a reversal can cause the recipient's email address to appear in system logs, so customer contact details are exposed beyond their session."
- **Details (verbatim):** "Entry: The redemption action processes a customer's loyalty balance and uses the member email for redemption and reversal notifications.\nOperation: Write the recipient's email address to the server log when a redemption email is suppressed.\nImpact: Cleartext customer email addresses from the customer record are logged to server console logs when redemption emails are suppressed.\n\nLocation: supabase/functions/process-loyalty-redemption — redemption email diagnostics"
- **Points at:** `supabase/functions/process-loyalty-redemption/index.ts` line 590: `console.log(`[process-loyalty-redemption] "loyalty-redeem" suppressed for ${recipientEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 11
- **Title:** Anyone can place formulas in the loyalty spreadsheet
- **Level:** warn | **Category:** unsafe_input | **ID:** INPUT_VALIDATION / `lov_finding_3e0e598165ae2427`
- **Description:** "Anyone can put formula text in the loyalty spreadsheet during signup, so staff who open it could be exposed to deceptive or harmful spreadsheet content."
- **Details (verbatim):** "Entry: A person signing up controls the full_name profile field; setup-customer-account stores that name and sends it in an enrollment event that is appended to the configured loyalty spreadsheet.\nOperation: Append the constructed row to the Google Sheet; the row contains customer.full_name without formula-prefix neutralization.\nImpact: Caller-controlled signup data is appended directly into Google Sheets with USER_ENTERED and unescaped values.\n\nLocation: Loyalty Google Sheet member-event append"
- **Points at:** entry `src/pages/PortalSetup.tsx` line 194 and `supabase/functions/setup-customer-account/index.ts` lines 212, 354; impact `supabase/functions/sync-loyalty-to-sheet/index.ts` lines 249–261 (Sheets append with `valueInputOption=USER_ENTERED`)
- **Control:** LOV.IN.SPREADSHEET_FORMULA_NEUTRALIZATION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 12
- **Title:** Authorized staff can expose customer emails in server logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_3ebb40aab97eb579`
- **Description:** "Staff with forfeit permissions can cause customer email addresses to be recorded in system logs when email notifications are suppressed, exposing contact details beyond the session."
- **Details (verbatim):** "Entry: A signed-in user with account-forfeiture permission submits an account identifier, and the account record provides the customer's email address.\nOperation: Write the customer's email address to the server log when the forfeiture email is suppressed.\nImpact: Logging customer email addresses on template suppression writes customer personal identifiable information to server logs.\n\nLocation: supabase/functions/manual-forfeit — forfeiture email diagnostic"
- **Points at:** `supabase/functions/manual-forfeit/index.ts` line 106: `console.log(`[manual-forfeit] "account-forfeited" suppressed for ${customer.email}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 13
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_41b42deedaaca837`
- **Description:** "Anyone submitting a payment for an account can cause its customer's email address to appear in system logs, so customer contact details are exposed beyond their sessions."
- **Details (verbatim):** "Entry: A person submits a payment request, which loads the account and obtains the recipient email for the payment-submission message.\nOperation: Write the customer's email address to the server log when the payment email is suppressed.\nImpact: The customer's email address fetched from the database is logged in cleartext to edge function server logs when email sending is suppressed.\n\nLocation: supabase/functions/submit-payment — payment submission email diagnostic"
- **Points at:** `supabase/functions/submit-payment/index.ts` line 335: `console.log(`[submit-payment] "payment-submitted" suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 14
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_52b9c7c0e953e645`
- **Description:** "Anyone who joins the loyalty program can cause their email address to appear in system logs, so their contact details are exposed beyond their own session."
- **Details (verbatim):** "Entry: A person submits the loyalty-program join action, which uses the associated customer email for the welcome email.\nOperation: Write the customer's email address to the server log when the welcome email is suppressed.\nImpact: The function logs the member's cleartext email address to server console logs when the welcome email is suppressed.\n\nLocation: supabase/functions/join-loyalty-program — welcome email diagnostic"
- **Points at:** `supabase/functions/join-loyalty-program/index.ts` line 382: `console.log(`[join-loyalty-program] "loyalty-welcome" suppressed for ${customer.email}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 15
- **Title:** Anyone can inject formulas into account exports
- **Level:** warn | **Category:** unsafe_input | **ID:** INPUT_VALIDATION / `lov_finding_56c7e46ef06e72b7`
- **Description:** "Anyone can register a customer name starting with formula characters, so staff opening exported layaway accounts may execute arbitrary spreadsheet commands."
- **Details (verbatim):** "Entry: A signed-in customer supplies their own profile name; the customer-creation route stores it, and the account export includes customer names without neutralizing formula-leading text.\nOperation: The account export creates a downloadable CSV from account values, including the customer-provided name, without formula neutralization.\nImpact: Unsanitized user-controlled customer data is formatted directly into CSV cells without neutralizing formula trigger prefixes (=, +, -, @), enabling CSV formula injection.\n\nLocation: Layaway accounts CSV export"
- **Points at:** entry `supabase/functions/website/index.ts` lines 1143, 1221; impact `src/pages/AccountList.tsx` line 313 (`new Blob([csv], { type: 'text/csv;charset=utf-8;' })`) and line 318 (`a.click();`)
- **Control:** LOV.IN.SPREADSHEET_FORMULA_NEUTRALIZATION.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** none

## Finding 16
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_59c08705b2634202`
- **Description:** "Any workspace member permitted to restore loyalty points can cause the affected member's email address to appear in system logs, so their contact details are exposed beyond their session."
- **Details (verbatim):** "Entry: A signed-in user requests restoration of loyalty points, which loads the affected loyalty member and recipient email.\nOperation: Write the recipient email address to the server log when the tier-restoration email is suppressed.\nImpact: Cleartext recipient customer email addresses are logged to server diagnostic output when tier restoration emails are suppressed.\n\nLocation: supabase/functions/restore-loyalty-points — tier restoration email diagnostic"
- **Points at:** `supabase/functions/restore-loyalty-points/index.ts` line 188: `console.log(`[restore-loyalty-points] "loyalty-tier-restored" suppressed for ${recipientEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 17
- **Title:** Anyone can trigger customer account forfeitures
- **Level:** error | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_68251701922700d8`
- **Description:** "Anyone can trigger account forfeitures through the settlement job, so customers may lose account status and payment rights without permission."
- **Details (verbatim):** "Entry: An internet request supplies an Authorization bearer value; the service-role gate trusts its unverified JWT role claim.\nOperation: The isServiceRole call allows forged claims to pass the gate because its helper decodes claims without signature verification.\nImpact: An unauthenticated caller supplying an unverified JWT with role service_role can trigger final forfeiture database updates on layaway accounts.\n\nLocation: supabase/functions/auto-forfeit-settlement/index.ts"
- **Points at:** `supabase/functions/auto-forfeit-settlement/index.ts` (entry line 47; operation line 51 `isServiceRole(authToken)`; impact lines 267–270 `supabase.from("layaway_accounts").update({ status: "final_forfeited", ... })`)
- **Control:** LOV.EP.PRIVATE_DATA_CALLER_AUTH.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** `previousFindingRecheck` + `verifiedPreviousResolutionSnapshot` present

## Finding 18
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_6d2ebe4a1ce38096`
- **Description:** "Any workspace member handling a payment review can cause customers' email addresses to appear in system logs, so their contact details are exposed beyond their sessions."
- **Details (verbatim):** "Entry: A signed-in user submits a payment-review action, which loads the customer email for payment confirmation messages.\nOperation: Write the customer's email address to the server log when the payment message is suppressed.\nImpact: Customer email addresses from processed payment submissions are logged in plaintext to server logs during email suppression.\n\nLocation: supabase/functions/review-payment-submission — payment confirmation diagnostics"
- **Points at:** `supabase/functions/review-payment-submission/index.ts` line 686: `console.log(`[review-payment-submission] "cash-payment-confirmed" suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 19
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_712fdd315abf9cf1`
- **Description:** "A caller with service-role authority can trigger order expiration that logs customer email addresses when expiration notifications are suppressed."
- **Details (verbatim):** "Entry: The expiration action processes cash orders and uses the associated customer's email for an expiration message.\nOperation: Write the customer's email address to the server log when an expiration message is suppressed.\nImpact: Customer email addresses are written to server diagnostic output when email notification is suppressed during auto-expiration.\n\nLocation: supabase/functions/auto-expire-cash-orders — expiration email diagnostic"
- **Points at:** `supabase/functions/auto-expire-cash-orders/index.ts` line 95, function `sendExpiredEmail`: `console.log(`[auto-expire-cash-orders] "cash-order-expired" suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 20
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_7613aab28068f11a`
- **Description:** "Any workspace member permitted to reactivate an account can cause its customer's email address to appear in system logs, so contact details are exposed beyond their session."
- **Details (verbatim):** "Entry: A signed-in user triggers account reactivation, which sends an extension message using the account customer's email.\nOperation: Write the customer's email address to the server log when the extension email is suppressed.\nImpact: Cleartext customer email addresses are logged to server diagnostic output when extension-granted emails are suppressed.\n\nLocation: supabase/functions/reactivate-account — account email diagnostic"
- **Points at:** `supabase/functions/reactivate-account/index.ts` line 303: `console.log(`[reactivate-account] "extension-granted" suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 21
- **Title:** Anyone can import customer payment histories
- **Level:** error | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_829c4eb24ea95507`
- **Description:** "Anyone can import customer accounts and payment histories, so private financial records can be forged."
- **Details (verbatim):** "Entry: An internet request supplies an Authorization bearer value; the service-role branch treats an unverified JWT role claim as proof of privilege.\nOperation: The gate accepts isServiceRole(token) without verifying the JWT signature, bypassing the ordinary user-authentication path.\nImpact: An unauthenticated caller supplying an unverified JWT with role service_role can insert customer, account, schedule, and payment records into the database.\n\nLocation: supabase/functions/bulk-import/index.ts"
- **Points at:** `supabase/functions/bulk-import/index.ts` (entry line 98; operation line 110 `isServiceRole(token)`; impact lines 223–234 `supabase.from("customers").insert({...})`)
- **Control:** LOV.EP.PRIVATE_DATA_CALLER_AUTH.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** `previousFindingRecheck` + `verifiedPreviousResolutionSnapshot` present

## Finding 22
- **Title:** Anyone can trigger account reconciliation and view records
- **Level:** warn | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_848b454db25e4583`
- **Description:** "Anyone can trigger account reconciliation runs, so customer account details and balance drift reports can be viewed without authorization."
- **Details (verbatim):** "Entry: An internet request supplies an Authorization bearer value; the service-role gate trusts an unverified JWT role claim.\nOperation: The isServiceRole call accepts forged role claims because its helper decodes claims without signature verification.\nImpact: next_reconciliation_batch reads customer account details and balances from durable storage and returns them in the response.\n\nLocation: supabase/functions/daily-reconciliation/index.ts"
- **Points at:** `supabase/functions/daily-reconciliation/index.ts` (entry line 31; operation line 32 `isServiceRole(authToken)`; impact lines 65–68 `supabase.rpc("next_reconciliation_batch", { p_limit: MAX_ACCOUNTS_PER_RUN })`)
- **Control:** LOV.EP.PRIVATE_DATA_CALLER_AUTH.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** `previousFindingRecheck` + `verifiedPreviousResolutionSnapshot` present

## Finding 23
- **Title:** Privileged users can log customer email addresses
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_87cdab798afe493b`
- **Description:** "A user with loyalty adjustment permissions can trigger operations that write customer email addresses to server logs, exposing personal data."
- **Details (verbatim):** "Entry: The award action processes the customer's account and uses the customer's email for loyalty notifications.\nOperation: Write the recipient's email address to the server log when a loyalty notification is suppressed.\nImpact: The endpoint writes the recipient's cleartext email address to server console logs when an email send is suppressed.\n\nLocation: supabase/functions/award-loyalty-points — loyalty email diagnostics"
- **Points at:** `supabase/functions/award-loyalty-points/index.ts` line 656: `console.log(`[award-loyalty-points] "loyalty-earned" suppressed for ${recipientEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 24
- **Title:** User with manage_waivers can expose customer email in logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_a738ff58c0d11dd0`
- **Description:** "A user with the manage_waivers permission can cause a customer's email address to be logged in server output when a penalty-waived notification is suppressed."
- **Details (verbatim):** "Entry: A signed-in user triggers the waiver approval action for an account, whose customer record provides the recipient address.\nOperation: Write the customer's email address to the server log when the waiver email is suppressed.\nImpact: The customer email address is logged to server diagnostic output when an email is suppressed, accessible in server execution logs.\n\nLocation: supabase/functions/approve-waiver — waiver email diagnostic"
- **Points at:** `supabase/functions/approve-waiver/index.ts` line 259: `console.log(`[approve-waiver] "penalty-waived" suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 25
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_a804915c1c025ff7`
- **Description:** "Anyone allowed to run payment reminders can cause customers' email addresses to appear in system logs, so their contact details are exposed beyond their sessions."
- **Details (verbatim):** "Entry: A service-role or permitted staff user triggers reminder processing, which loads recipient addresses for customer notices.\nOperation: Write a customer's email address to the server log when a reminder is suppressed.\nImpact: Customer email addresses are logged to server console during payment reminder suppression.\n\nLocation: supabase/functions/send-reminders — reminder suppression diagnostics"
- **Points at:** `supabase/functions/send-reminders/index.ts` line 306: `console.log(`[send-reminders] reminder email suppressed for ${alert.customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 26
- **Title:** Anyone can change customer loyalty balances
- **Level:** error | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_a9cbf49f897c2a35`
- **Description:** "Anyone can run privileged loyalty adjustments, so customer points and rewards can be changed without permission."
- **Details (verbatim):** "Entry: An internet request supplies an Authorization bearer value; the service-role branch treats an unverified JWT role claim as proof of privilege and skips user verification and permission checking.\nOperation: The service-role branch accepts isServiceRole(token) without verifying the JWT signature.\nImpact: An unauthenticated caller supplying an unverified JWT with role service_role can insert loyalty reward transactions into the database without authorization.\n\nLocation: supabase/functions/award-loyalty-points/index.ts"
- **Points at:** `supabase/functions/award-loyalty-points/index.ts` (entry line 49; operation line 58 `isServiceRole(token)`; impact lines 392–396 `supabase.from("loyalty_transactions").insert(earnedTxRow)...`)
- **Control:** LOV.EP.PRIVATE_DATA_CALLER_AUTH.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** `previousFindingRecheck` + `verifiedPreviousResolutionSnapshot` present

## Finding 27
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_afb7189aa1dfefdf`
- **Description:** "Anyone submitting a cash payment can cause the customer's email address to appear in system logs, so customer contact details are exposed beyond their sessions."
- **Details (verbatim):** "Entry: A person submits a cash payment request, which loads the order's customer email for the payment-submission message.\nOperation: Write the customer's email address to the server log when the payment email is suppressed.\nImpact: The customer's email address read from the customers database table is written in cleartext to edge function server logs when email sending is suppressed.\n\nLocation: supabase/functions/submit-cash-payment — cash payment email diagnostic"
- **Points at:** `supabase/functions/submit-cash-payment/index.ts` line 294: `console.log(`[submit-cash-payment] "cash-payment-submitted" suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 28
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_bb6f3e024bf3da16`
- **Description:** "Any workspace member permitted to revoke loyalty points can cause the affected member's email address to appear in system logs, so their contact details are exposed beyond their session."
- **Details (verbatim):** "Entry: A signed-in user triggers a loyalty-points revocation affecting a member whose email is used for notification.\nOperation: Write the recipient's email address to the server log when the tier-revocation email is suppressed.\nImpact: Member email address is logged in plaintext to server logs when tier revocation email sending is suppressed.\n\nLocation: supabase/functions/revoke-loyalty-points — tier revocation email diagnostic"
- **Points at:** `supabase/functions/revoke-loyalty-points/index.ts` line 243: `console.log(`[revoke-loyalty-points] "loyalty-tier-revoked" suppressed for ${recipientEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 29
- **Title:** Finance users can send custom messages to selected customers
- **Level:** warn | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_bccdce994b090a27`
- **Description:** "Any finance user can send custom messages to selected loyalty members, so recipients may receive unsolicited company-branded email."
- **Details (verbatim):** "Entry: A signed-in finance or admin user supplies the notification body and specific loyalty-member IDs, or selects all members, in the request.\nOperation: Send a templated company email to the selected loyalty member.\nImpact: The function invokes sendTemplateEmail to send outbound emails via Lovable's email API to arbitrary selected customers with request-specified title and body text.\n\nLocation: send-loyalty-notification"
- **Points at:** `supabase/functions/send-loyalty-notification/index.ts` (entry lines 270, 285, 288; operation lines 198–210 `sendTemplateEmail("loyalty-broadcast", ...)`, function `sendBroadcastEmails`); impact `supabase/functions/_shared/transactional-email-templates/send-email.ts` lines 79–93 (`sendLovableEmailWithRetry(...)`)
- **Control:** LOV.EP.OUTBOUND_ACTION_ABUSE_PROTECTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 30
- **Title:** Service callers can expose customer emails in server logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_dd674321221557c5`
- **Description:** "A service caller triggering the penalty engine can cause customer email addresses to be recorded in system logs when penalty emails are suppressed, exposing contact details."
- **Details (verbatim):** "Entry: The penalty action processes customer accounts and uses their email addresses for penalty-related messages.\nOperation: Write a customer's email address to the server log when a penalty email is suppressed.\nImpact: Logging customer email addresses on suppression exposes personal contact data in server logs.\n\nLocation: supabase/functions/penalty-engine — penalty email diagnostics"
- **Points at:** `supabase/functions/penalty-engine/index.ts` line 697: `console.log(`[penalty-engine] templateName suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 31
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_e75fa7665f637197`
- **Description:** "Any workspace member permitted to void a payment can cause the customer's email address to appear in system logs, so their contact details are exposed beyond their session."
- **Details (verbatim):** "Entry: A signed-in user submits a payment identifier to the payment-void action, which retrieves the associated customer email.\nOperation: Write the customer's email address to the server log when the void email is suppressed.\nImpact: The customer's email address retrieved from the database is logged in cleartext to edge function server logs when email suppression occurs during payment voiding.\n\nLocation: supabase/functions/void-payment — payment void email diagnostic"
- **Points at:** `supabase/functions/void-payment/index.ts` line 294: `console.log(`[void-payment] "payment-voided" suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 32
- **Title:** Anyone can expose customer email addresses in system logs
- **Level:** warn | **Category:** exposed_data | **ID:** INFO_LEAKAGE / `lov_finding_e90d2e1aa9c4e5b6`
- **Description:** "A caller with service-role authority can trigger forfeiture settlement that logs customer email addresses when forfeiture notifications are suppressed."
- **Details (verbatim):** "Entry: The settlement action processes eligible accounts and sends forfeiture messages using each customer's email address.\nOperation: Write the customer's email address to the server log when a forfeiture email is suppressed.\nImpact: Customer email addresses are logged to server output when forfeiture email notification is suppressed.\n\nLocation: supabase/functions/auto-forfeit-settlement — forfeiture email diagnostic"
- **Points at:** `supabase/functions/auto-forfeit-settlement/index.ts` line 170, function `sendForfeitEmail`: `console.log(`[auto-forfeit-settlement] "account-forfeited" suppressed for ${customerEmail}`);`
- **Control:** LOV.INFO.SENSITIVE_LOG_REDACTION.V1
- **created_at:** 2026-10-03T03:01:33.040406246Z
- **Status markers:** none

## Finding 33
- **Title:** Anyone can bypass sweep authentication using forged claims
- **Level:** warn | **Category:** abusable_endpoints | **ID:** OPEN_ENDPOINTS / `lov_finding_fd9e9831e953f906`
- **Description:** "Anyone can fabricate a bearer token with an unsigned service_role claim to invoke web reservation sweeps that cancel expired reservations."
- **Details (verbatim):** "Entry: supabase/functions/web-reservation-sweep/index.ts\nOperation: Accept decoded service_role claims as a machine credential without verifying the token\nImpact: Calling expire_unconfirmed_web_reservations_atomic and expire_web_drafts_atomic mutates order statuses and sends cancellation emails.\n\nLocation: supabase/functions/web-reservation-sweep/index.ts"
- **Points at:** `supabase/functions/web-reservation-sweep/index.ts` (entry line 71; impact lines 80–83 `expire_unconfirmed_web_reservations_atomic` and 123–126 `expire_web_drafts_atomic`); operation `supabase/functions/_shared/jwt-claims.ts` line 35, function `isServiceRole`: `return parseJwtClaims(token)?.role === "service_role";`; also `supabase/functions/_shared/handler.ts` line 42
- **Control:** LOV.EP.INTERNAL_ENDPOINT_SHARED_SECRET.V1
- **created_at:** 2026-10-01T07:50:13.321207871Z
- **Status markers:** none

---

## Notes on the data itself (no fixes proposed)

- 33 findings total in the payload: 5 at level `error` (findings 1, 4, 17, 21, 26) and 28 at level `warn`.
- No finding carries a new/open/resolved/ignored status field in this payload; that state is not exposed by the tool. The `previousFindingRecheck`/`verifiedPreviousResolutionSnapshot` fingerprints on findings 2, 9, 17, 21, 22, 26 indicate they were re-checked against a previous scan's resolution snapshot.
- The scan is flagged **up_to_date: false** — the panel considers these results stale pending a rescan.
