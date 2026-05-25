# Cha Jewels la-tracking — Next Session Prompt

## Quick Status
**Current Date:** 2026-05-25 EOD | **Latest Commit:** fdec3cd | **Repo:** github.com/chajewels/la-tracking

---

## What Just Happened (2026-05-25)

✅ **4 deferred items resolved:**
- Bug #103 (send-transactional-email auto-deploy) → RESOLVED by design
- RLS file 6 (Phase B RLS policies) → DEPLOYED via migrations 05/06
- customer-statement deletion → COMPLETE (7 files, 789 lines removed)
- tier_changed downgrade → COMPLETED (both expiry + gap paths insert transactions)

✅ **Documentation:** FIXED-BUGS.md #153–156, OPEN-BUGS.md updated, HANDOVER-2026-05-25.md created (109 lines)

✅ **Final commits:** fdec3cd, da0b6fc, 0272587, cbf68b1, 7f38d37

---

## What's Next (Pick One)

┌─────────────────────────────────────────┐
│ OPTION 1: P5 Session Timeout 2hr        │
│ Add session expiry to internal portal   │
│ (admin/staff/CSR/finance users)         │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ OPTION 2: P6 Admin Audit Log            │
│ Create audit log UI for admin actions   │
│ (permissions, team members, settings)   │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ OPTION 3: riskFactor Cleanup (LOW)      │
│ Strip dead 0.85 code from dashboard     │
│ (optional future tidy-up)               │
└─────────────────────────────────────────┘

---

## How to Start

**Step 1: Read Documentation**

docs/HANDOVER-2026-05-25.md (SOP + locked rules) — 5 min
CLAUDE.md (core rules) — skim for relevance
docs/OPEN-BUGS.md (known issues) — 2 min
**Step 2: Verify Git State**
```bash
cd ~/la-tracking && git pull origin main && git log --oneline -5
```

**Step 3: Pick Priority** — Choose OPTION 1, 2, or 3

**Step 4: Follow SOP (6 steps)**
Investigation  → Capture verbatim file state (line numbers, before/after)
Analysis       → Line-level analysis with exact strings
Confirmation   → Explicit go-ahead from Cynthia
Implementation → Write the code/SQL
Ship           → Deploy via Lovable (edge functions) or SQL Editor (DB)
Verification   → Test + update docs
---

## Critical Rules (NON-NEGOTIABLE)

┌─────────────────────────────────────────────┐
│ ### Deployment Model (PERMANENT)            │
│                                             │
│ FRONTEND     → Firebase (auto-deploy)      │
│ EDGE FUNCTIONS → Lovable IDE ONLY          │
│ DATABASE    → Supabase SQL Editor (pure SQL) │
│ AUDIT       → Cloud Shell (git/grep only)  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ### SQL Rules (ABSOLUTE)                    │
│                                             │
│ ✗ NO SQL PLACEHOLDERS                      │
│ ✓ Self-resolving only (subquery/CTE)       │
│ ✓ Pure SQL in Editor (no TypeScript)       │
│ ✓ One query at a time                      │
│ ✓ Enum casting ('active'::account_status)  │
│ ✓ UUID use DISTINCT ON (not MIN/MAX)       │
│ ✓ All ids table-aliased                    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ### Lovable Prompt Rules                    │
│                                             │
│ ✓ ONE code block (copy-paste entire)       │
│ ✓ Bundle code + CLAUDE.md cleanup          │
│ ✓ Explicit "Push to main (no branches)"    │
│ ✓ Verify against git after deploy          │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ### Cloud Shell Usage                       │
│                                             │
│ ✓ Always git pull first (drifts with        │
│   Lovable as committer)                     │
│ ✓ Verification greps < 40 chars            │
│ ✗ NEVER deploy from here (audit only)      │
└─────────────────────────────────────────────┘

---

## Locked Rules (Reference)

┌─────────────────────────────────────────────┐
│ ### Calculation Standard (NON-NEGOTIABLE)   │
│                                             │
│ totalLAAmount = total_amount +              │
│                 Σ(non-waived penalties)     │
│                                             │
│ remainingBalance = totalLAAmount -          │
│                   Σ(non-voided payments)    │
│                                             │
│ Penalty status:                             │
│ 'unpaid'  → counts in activePenalties      │
│ 'paid'    → counts in activePenalties      │
│ 'waived'  → EXCLUDED                       │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ### Currency Conversion (NON-NEGOTIABLE)    │
│                                             │
│ JPY = PHP ÷ php_jpy_rate (DIVIDE)          │
│ PHP = JPY × php_jpy_rate (MULTIPLY)        │
│                                             │
│ Example (rate = 0.42, ¥1 = ₱0.42):        │
│ ₱10,000 ÷ 0.42 = ¥23,810   ✓ CORRECT      │
│ ₱10,000 × 0.42 = ¥4,200    ✗ WRONG        │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ### Enum Values (EXACT)                     │
│                                             │
│ penalty_fee_status:                         │
│   'unpaid' | 'paid' | 'waived'             │
│   (NEVER 'active')                         │
│                                             │
│ account_status:                             │
│   'active' | 'overdue' | 'completed' |     │
│   'cancelled' | 'forfeited' |              │
│   'final_forfeited' | 'extension_active' | │
│   'reactivated' | 'final_settlement'       │
│                                             │
│ schedule_status:                            │
│   'pending' | 'partially_paid' | 'paid' |  │
│   'overdue' | 'cancelled'                  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ ### Schema Facts (LOCKED)                   │
│                                             │
│ customers: id, customer_code, full_name,   │
│ email, mobile_number, auth_user_id         │
│ (NO first_name/last_name)                  │
│                                             │
│ layaway_accounts: has downpayment_amount,  │
│ NO dp_paid, NO statement_token             │
│ (total_amount never modified by payments)  │
│                                             │
│ payments: NO payment_type/is_downpayment   │
│ DP: ref LIKE 'DP-%' OR remarks LIKE '%down%' │
│ NO status column                            │
│                                             │
│ penalty_fees: status enum                   │
│ 'unpaid' | 'paid' | 'waived'               │
│ (NEVER 'active')                           │
└─────────────────────────────────────────────┘

---

## Quick Links

- **CLAUDE.md** — Core rules (currency, calculation, enums, payment workflow)
- **docs/HANDOVER-2026-05-25.md** — Complete SOP handbook
- **docs/FIXED-BUGS.md** — What broke (DO NOT reintroduce)
- **docs/OPEN-BUGS.md** — Known issues
- **docs/SCHEMA-FACTS.md** — Schema constraints
- **src/lib/business-rules.ts** — Calculation engine

---

## Team Info

┌─────────────────────────────────────────┐
│ Admin Accounts                          │
│ sales@chajewelsjp.com (Cynthia, owner) │
│ efrhyll.largo@gmail.com (staff)        │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Domains (CRITICAL)                      │
│ portal.chajewelsjp.com → customers only │
│ app.chajewelsjp.com → internal only     │
│ (NEVER suggest app.* for customers)    │
└─────────────────────────────────────────┘

**Communication:** Direct, terse. No over-explanation. Provide investigation data before asking approval.

---

## Board State

✅ **Just Completed (2026-05-25):**
- customer-statement deletion (full stack)
- Bug #103 resolved (auto-deploy working)
- RLS file 6 deployed (migrations live)
- tier_changed downgrade completed (both paths)

⏳ **Pending Next:**
- P5: Session timeout 2hr
- P6: Admin audit log
- riskFactor optional cleanup (low priority)

---

## Next Steps

1. `cd ~/la-tracking && git pull origin main && git log --oneline -5`
2. Read: `docs/HANDOVER-2026-05-25.md` (complete SOP handbook)
3. Read: `CLAUDE.md` (skim for rules relevant to your priority)
4. Pick priority from "What's Next" section above
5. Start investigation phase (step 1 of 6-step SOP)
6. Follow: investigate → analyze → confirm → implement → ship → verify → docs

---

**All systems current. Board clean. Ready for next priority.** 🚀
