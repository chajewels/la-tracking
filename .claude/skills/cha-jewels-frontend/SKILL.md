---
name: cha-jewels-frontend
description: Use this skill for ANY frontend work in the Cha Jewels la-tracking codebase — UI components, styling, animation, layout, or refactors in src/. It encodes the two design systems (Deco Ledger for the internal Hub, Maison for the Customer Portal), locked business rules that must never be recalculated client-side, code-ownership boundaries, and the verification workflow. Trigger whenever editing or creating React components, theme files, or styles in this repo.
---
# Cha Jewels Frontend Skill
Cha Jewels Hub is a **high-discipline financial and CRM system for a luxury jewelry brand — not basic e-commerce.** Accuracy, traceability, and premium experience are non-negotiable.
**Stack (verified):** React + TypeScript + Vite · **Supabase** (Postgres/RLS/Edge Functions/Auth) · Firebase **Hosting** (frontend only) · GitHub Actions. `firebase-deploy.yml` deploys frontend on push to **main only** — feature branches deploy nothing.
Two surfaces share this repo and must never be visually confused:
| | Internal Hub (app.chajewelsjp.com) | Customer Portal (portal.chajewelsjp.com) |
|---|---|---|
| Theme | **Deco Ledger** (dark) | **Maison** (light) |
| Users | Owner + CSR staff | Customers, mobile-first (375px) |
Domain rule is strict: portal = customers only, app = internal only. Never mix.
## Ownership boundaries (hard rules — from CLAUDE.md)
- `src/` → Claude Code, when explicitly directed. Default mode: read-only audit.
- `supabase/functions/` code + deploys → **Lovable IDE only**. NEVER edit or deploy. If a task needs an edge-function change: STOP, report it — the owner sends a separate Lovable prompt.
- DB changes → owner runs pure SQL in Supabase SQL Editor. Provide SQL as text only; must be self-resolving (no placeholders).
- No Supabase MCP, no API keys, no bearer tokens — the owner cannot retrieve keys and all DB work routes through her.
- SOP: investigation → plan → owner confirmation → implementation. "go/proceed" approves the approach, never implementation. No step without an explicit go.
- Always verify remote state with `git fetch origin` + `git show origin/<branch>:<path>` before any claim. Local checkout drifts.
## Locked business logic (display only — NEVER recalculate, round, or "simplify" client-side)
- **Dual currency PHP + JPY.** Conversion: `JPY = PHP ÷ php_jpy_rate` (divide, never multiply). Frontend uses `src/lib/currency-converter.ts → toJpy()`.
- **Currency display: formatting treatment only** (tabular-nums, right-aligned) in whatever currency each surface already uses. Never switch a surface's currency. Customer message templates are locked and ₱-based.
- `total_amount` on `layaway_accounts` = base amount only; penalties live exclusively in `penalty_fees`. `payments` table is the sole source of truth for balances.
- Cash orders are **first-class**: every account-scoped UI feature covers both `layaway_accounts` AND `cash_orders` unless the owner explicitly excludes cash.
- Penalties, services, and waivers ALWAYS visible as itemized lines (waivers as labeled credits). Never net, hide, or bury them — traceability is a feature. Never show ₱0 penalties.
- Loyalty: ¥10,000 = 100 pts; 1 pt = ¥1; non-transferable; no cash conversion. Members without lots = edge cases, not bugs.
## Brand gold (confirmed 2026-07-06)
Canonical gold is now **#C9A227** (`--gold-500`) / **#E5C860** (`--gold-300`), tokens-only. The old #D4AF37 is retired. Outstanding migration: `AppSidebar.tsx:253` inline `style={{ color: '#D4AF37' }}` → token. Widened check must return 0:
`grep -rn "\[#D4AF37\]\|\[#E7D7A2\]\|#D4AF37\|#C9A227" src --include="*.tsx" | grep -v theme/` (hex literals live only in `src/theme/` and `index.css`). Update the CLAUDE.md BRAND STYLE STANDARD section in the same commit as any gold-related code change.
## Deco Ledger tokens (Hub — dark)
```
--surface-0:#0F0E0C  --surface-1:#1A1815  --surface-2:#262320
--gold-500:#C9A227   --gold-300:#E5C860   --champagne:#F3EBDD  --ink-muted:#9B948A
--success:#4CAF7D  --warning:#D9A441  --danger:#C25450  --info:#6B8FB5
```
Serif display (Cormorant Garamond, `font-deco`) for titles + KPI numbers only; body with `"tnum"`. Scale 12/13/14/16/20/28/40. 4px grid, tight rhythm. Radius 8/6/4. Signature: 1px gold hairline (`.hairline-gold/-b/-t`).
## Maison tokens (Portal — light)
```
--surface-0:#FAF7F2  --surface-1:#FFFFFF  --surface-2:#F1EBE1
--gold-600:#A8822A   --gold-400:#C9A227   --ink:#2B2723   --ink-muted:#6E675E
--success:#3E7D5B  --warning:#A9762B  --danger:#A4423E  --info:#4A6B8A
```
Serif used generously. Scale 13/14/16/18/22/30/44, line-height 1.6, rhythm 24–32px. Radius 12/8/999. `--gold-600` for text/CTAs (AA on ivory); `--gold-400` decorative only. Signature: the gold hairline as the payment journey line, filling as installments are paid. Keep the two token sets in separate namespaces — no bleed.
## Motion rules
Single config: `src/theme/motion.ts` — all animations import from it, no inline durations. Hub 120/200/320ms; Portal 140/240/400ms. Easing `cubic-bezier(0.22,1,0.36,1)`, no bounce. Count-ups/rings/sheens animate ONCE on first mount. Skeleton shimmer for every async surface. `prefers-reduced-motion` always respected (MotionConfig reducedMotion="user" is at app root).
## Shipped UI that must be preserved (do not replace)
- AccountList.tsx status-folder accordion (ERP folders, c19bee2) — extend, never flatten into a plain table.
- Its existing CSV export, PHP/JPY currency tabs, expand/collapse controls.
- Payment submission flow and locked sidebar behaviors per CLAUDE.md "Locked UI decisions".
## Portal-specific requirements
375px first; touch targets ≥ 44px; bottom tab nav < 1024px. Strict data isolation — a customer sees only their own records; if anything could leak cross-customer data, STOP and flag. No admin capabilities may render. i18n for all strings; friendly plain-language errors, never raw error strings. Test long Filipino/Japanese names.
## Verification workflow (every phase)
1. Playwright screenshots of affected screens at **375px and 1440px**; inspect and fix defects BEFORE reporting done.
2. Keyboard: visible 2px gold focus rings, sane tab order.
3. `npx lighthouse` on key screens: Perf ≥ 90, A11y ≥ 95. Verify gold-on-background contrast AA.
4. `npx tsc --noEmit` + test suite pass (CI runs typecheck on main push — don't merge red).
5. Virtualize tables > 100 rows; lazy-load charts/images.
6. Conventional commit per phase, push to the session feature branch, never to main. PR to main only on explicit owner instruction.
## Component sourcing order
1. Extend an existing repo component if one fits (check the 9 existing ui/table consumers before touching table.tsx).
2. shadcn MCP for primitives, restyled with tokens.
3. Context7 for current framer-motion / recharts / TanStack APIs — never training data.
4. Magic MCP only for novel signature components, then refactor to tokens.
