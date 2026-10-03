# Security scan — compact index (READ-ONLY, fresh forced read)

## Scan header

- Scanner with findings: **agent_security_v2**, version **1.91**, completion **complete**, timestamp **2026-10-03T05:36:09.521718886Z**, **up_to_date: true**
- Total findings: **46** (5 level `error`, 41 level `warn`)
- Per scanner: agent_security_v2 = 46; app_mcp (v1.0) = 0, up_to_date true; app_mcp_deep (v1.1) = 0, up_to_date true; lov_pgscan (v0.2.1) = 0, up_to_date true; connector_security_scan (v1.0) = 0, **incomplete**, up_to_date false (last run 2026-06-12T07:00:30Z); supply_chain (v2.2.0) = 0, up_to_date false (timestamp 2026-10-03T02:58:09Z)
- No finding carries a new/open/resolved/ignored status field. Markers appended per line: `recheck` = previousFindingRecheck + verifiedPreviousResolutionSnapshot present; `prevScan` = previousScanIdentity only; `unconfirmedRescans=1` where present. Findings created at 05:36:09 with no prev markers are new in this scan.

## Findings (one line each, in payload order)

1 | warn | INFO_LEAKAGE | lov_finding_003a2b65b83e7bfe | 2026-10-03T05:36:09Z | Any workspace member can expose customer emails in logs | supabase/functions/process-loyalty-redemption/index.ts:966 (entry :89)
2 | warn | INFO_LEAKAGE | lov_finding_08b45e83212b8606 | 2026-10-03T05:36:09Z | Staff members can expose customer emails in logs | supabase/functions/send-transactional-email/index.ts:165-168 (entry :93, :95)
3 | warn | OPEN_ENDPOINTS | lov_finding_10d6b8429777b04d | 2026-10-01T07:50:13Z | Anyone can trigger loyalty image deletion | supabase/functions/cleanup-loyalty-images/index.ts:263-265 (entry :111, :116) | recheck
4 | warn | INFO_LEAKAGE | lov_finding_1407dcbe28785c56 | 2026-10-03T03:01:33Z | Service callers can expose customer emails in server logs | supabase/functions/loyalty-inactivity-check/index.ts:83 (sendEmail; entry :178) | recheck
5 | error | OPEN_ENDPOINTS | lov_finding_16c0c9a0d7d9b398 | 2026-10-03T03:01:33Z | Anyone can write payment tracking rows with a forged JWT | supabase/functions/append-payment-tracking/index.ts:169-173 (entry :76-77) | recheck
6 | warn | INFO_LEAKAGE | lov_finding_2143864471d1c155 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/_shared/storefront-email.ts:122 (entry supabase/functions/cancel-cash-order/index.ts:84, :130, :133) | recheck
7 | warn | INFO_LEAKAGE | lov_finding_2a7aa146a18d4ffa | 2026-10-03T03:01:33Z | Admins can log customer email addresses | supabase/functions/bulk-send-setup-invites/index.ts:181 (entry :48) | prevScan
8 | warn | OPEN_ENDPOINTS | lov_finding_2c15b308b4a3df69 | 2026-10-01T07:50:13Z | Anyone can trigger penalty calculations and fees | supabase/functions/penalty-engine/index.ts:521 (entry :48, :55) | recheck
9 | warn | PUBLIC_DATA_EXPOSURE | lov_finding_2d2ceb48014e10a4 | 2026-10-03T03:01:33Z | Caller-chosen Drive files accessed with service credentials | supabase/functions/fill-payment-tracking/index.ts:135-139, :164 (entry :106, :124) | prevScan
10 | warn | INFO_LEAKAGE | lov_finding_31f82287c7bd1cc3 | 2026-10-03T05:36:09Z | Anyone can expose customer emails in logs | supabase/functions/penalty-engine/index.ts:730 (entry :711)
11 | warn | OPEN_ENDPOINTS | lov_finding_39fd271c965935fe | 2026-10-01T07:50:13Z | Anyone can trigger loyalty sheet reconciliation | supabase/functions/loyalty-sheet-reconcile/index.ts:230-234 (entry :41, :44) | recheck
12 | warn | INFO_LEAKAGE | lov_finding_3bbc674d2b8af301 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/process-loyalty-redemption/index.ts:590 (entry :89) | prevScan
13 | warn | INPUT_VALIDATION | lov_finding_3e0e598165ae2427 | 2026-10-03T03:01:33Z | Anyone can put formulas in loyalty records | supabase/functions/sync-loyalty-to-sheet/index.ts:254-261 (entry src/pages/PortalSetup.tsx:195)
14 | warn | INFO_LEAKAGE | lov_finding_3ebb40aab97eb579 | 2026-10-03T03:01:33Z | Authorized staff can expose customer emails in server logs | supabase/functions/manual-forfeit/index.ts:106 (entry :30, :36) | prevScan
15 | warn | INFO_LEAKAGE | lov_finding_41b42deedaaca837 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/submit-payment/index.ts:335 | prevScan
16 | warn | INFO_LEAKAGE | lov_finding_52b9c7c0e953e645 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/join-loyalty-program/index.ts:382 (entry :47) | prevScan
17 | warn | INPUT_VALIDATION | lov_finding_56c7e46ef06e72b7 | 2026-10-01T07:50:13Z | Anyone can inject formulas into account exports | src/pages/AccountList.tsx:313, :318 (entry supabase/functions/website/index.ts:1143, :1221) | unconfirmedRescans=1
18 | warn | INFO_LEAKAGE | lov_finding_59c08705b2634202 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/restore-loyalty-points/index.ts:188 | prevScan
19 | error | OPEN_ENDPOINTS | lov_finding_5fafb79607c54055 | 2026-10-03T05:36:09Z | Anyone can trigger privileged Shopify catalog sync | supabase/functions/shopify-sync-products/index.ts:186-188, :208-213 (entry :79, :83)
20 | error | OPEN_ENDPOINTS | lov_finding_68251701922700d8 | 2026-10-01T07:50:13Z | Anyone can trigger customer account forfeitures | supabase/functions/auto-forfeit-settlement/index.ts:51, :267-270 (entry :47) | recheck
21 | warn | INFO_LEAKAGE | lov_finding_6d2ebe4a1ce38096 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/review-payment-submission/index.ts:686 | prevScan
22 | warn | INFO_LEAKAGE | lov_finding_712fdd315abf9cf1 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/auto-expire-cash-orders/index.ts:95 (sendExpiredEmail; entry :46) | recheck
23 | warn | INFO_LEAKAGE | lov_finding_7299ccdf059aa478 | 2026-10-03T05:36:09Z | Staff members can expose customer emails in logs | supabase/functions/review-payment-submission/index.ts:1356
24 | warn | INFO_LEAKAGE | lov_finding_7613aab28068f11a | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/reactivate-account/index.ts:303 (entry :283) | prevScan
25 | warn | INFO_LEAKAGE | lov_finding_7cd97923a6bddc40_45f8612e | 2026-10-03T05:36:09Z | Finance users can expose customer emails in error logs | supabase/functions/send-loyalty-notification/index.ts:215-218 (sendBroadcastEmails; entry :198)
26 | warn | INFO_LEAKAGE | lov_finding_7cd97923a6bddc40_dd22ec18 | 2026-10-03T05:36:09Z | Finance users can expose customer emails in suppression logs | supabase/functions/send-loyalty-notification/index.ts:212 (sendBroadcastEmails; entry :198)
27 | error | OPEN_ENDPOINTS | lov_finding_829c4eb24ea95507 | 2026-10-01T07:50:13Z | Anyone can import customer payment histories | supabase/functions/bulk-import/index.ts:110, :223-234 (entry :98) | recheck
28 | warn | OPEN_ENDPOINTS | lov_finding_848b454db25e4583 | 2026-10-01T07:50:13Z | Anyone can trigger account reconciliation and view records | supabase/functions/daily-reconciliation/index.ts:32, :65-68 (entry :31) | recheck
29 | warn | INFO_LEAKAGE | lov_finding_87cdab798afe493b | 2026-10-03T03:01:33Z | Privileged users can log customer email addresses | supabase/functions/award-loyalty-points/index.ts:656 (entry :39) | prevScan
30 | warn | INFO_LEAKAGE | lov_finding_9699893941b1b360 | 2026-10-03T05:36:09Z | Anyone can expose customer emails in logs | supabase/functions/setup-customer-account/index.ts:333 (entry :54)
31 | warn | INFO_LEAKAGE | lov_finding_a738ff58c0d11dd0 | 2026-10-03T03:01:33Z | User with manage_waivers can expose customer email in logs | supabase/functions/approve-waiver/index.ts:259 | prevScan
32 | warn | INFO_LEAKAGE | lov_finding_a804915c1c025ff7 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/send-reminders/index.ts:269 (entry :245) | prevScan
33 | error | OPEN_ENDPOINTS | lov_finding_a9cbf49f897c2a35 | 2026-10-01T07:50:13Z | Anyone can change customer loyalty balances | supabase/functions/award-loyalty-points/index.ts:58, :392-396 (entry :49) | recheck
34 | warn | INFO_LEAKAGE | lov_finding_afb7189aa1dfefdf | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/submit-cash-payment/index.ts:294 | prevScan
35 | warn | INFO_LEAKAGE | lov_finding_bb6f3e024bf3da16 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/revoke-loyalty-points/index.ts:243 (entry :60, :62) | prevScan
36 | warn | OPEN_ENDPOINTS | lov_finding_bccdce994b090a27 | 2026-10-03T03:01:33Z | Finance users can send custom messages to selected customers | supabase/functions/send-loyalty-notification/index.ts:198-210 (sendBroadcastEmails; entry :270); impact supabase/functions/_shared/transactional-email-templates/send-email.ts:79-93 | recheck
37 | warn | INFO_LEAKAGE | lov_finding_be9a4c2c42805a46_3d6a4b38 | 2026-10-03T05:36:09Z | Anyone can expose an email address in logs | supabase/functions/handle-email-unsubscribe/index.ts:129 (entry :35)
38 | warn | INFO_LEAKAGE | lov_finding_be9a4c2c42805a46_55f2d50b | 2026-10-03T05:36:09Z | Anyone can expose an email address in logs | supabase/functions/handle-email-unsubscribe/index.ts:122-125 (entry :35)
39 | warn | INFO_LEAKAGE | lov_finding_dd674321221557c5 | 2026-10-03T03:01:33Z | Service callers can expose customer emails in server logs | supabase/functions/penalty-engine/index.ts:697 | prevScan
40 | warn | INFO_LEAKAGE | lov_finding_e75fa7665f637197 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/void-payment/index.ts:294 (entry :12) | recheck
41 | warn | INFO_LEAKAGE | lov_finding_e90d2e1aa9c4e5b6 | 2026-10-03T03:01:33Z | Anyone can expose customer email addresses in system logs | supabase/functions/auto-forfeit-settlement/index.ts:170 (sendForfeitEmail; entry :153) | recheck
42 | warn | INFO_LEAKAGE | lov_finding_ea55a6ef97290833_72c61d1e | 2026-10-03T05:36:09Z | Privileged users can log customer email addresses | supabase/functions/award-loyalty-points/index.ts:743 (entry :39)
43 | warn | INFO_LEAKAGE | lov_finding_ea55a6ef97290833_979caf34 | 2026-10-03T05:36:09Z | Privileged users can log customer email addresses | supabase/functions/award-loyalty-points/index.ts:685 (entry :39)
44 | warn | STORAGE_EXPOSURE | lov_finding_eb0727ebb818efef | 2026-10-03T05:36:09Z | Page365 imports store files without validating their type | supabase/functions/page365-fetch-order/index.ts:551-554 (entry :384, :544)
45 | warn | INFO_LEAKAGE | lov_finding_fd565dd3f040bad6 | 2026-10-03T05:36:09Z | Anyone can expose customer emails in logs | supabase/functions/process-loyalty-notification-queue/index.ts:199-202 (sendBroadcastEmails; entry :182)
46 | warn | OPEN_ENDPOINTS | lov_finding_fd9e9831e953f906 | 2026-10-01T07:50:13Z | Anyone can bypass sweep authentication using forged claims | supabase/functions/_shared/jwt-claims.ts:35 (isServiceRole); supabase/functions/web-reservation-sweep/index.ts:71, :123; supabase/functions/_shared/handler.ts:42 | recheck
