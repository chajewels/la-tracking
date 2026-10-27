# UI Conventions

Moved verbatim from CLAUDE.md on 2026-10-28 (Option A split); CLAUDE.md keeps a one-line pointer and every money rule.

## HELP CENTER SCREENSHOTS — NON-NEGOTIABLE (updated 2026-06-01)

Help Center screenshots live in the Supabase Storage bucket `brand-assets` (public read), NOT in the repo, stored WITHOUT file extensions (`Signin_Page`, not `Signin_Page.png`); Markdown references omit the extension too.

Markdown in src/help-content/ references a screenshot by filename only (no
extension); Help.tsx resolves it to the bucket's public URL; adding one needs
no code change. docs/SCHEMA-FACTS.md "Rules moved from CLAUDE.md".

## BRAND STYLE STANDARD (Deco Ledger, 2026-07-06)

  Full text incl. the tracked-debt list (nested workflow, package-lock
  registry quirk, email-template gold, SheetJS pin), background photos and
  video assets: docs/BRAND-STYLE.md (moved verbatim 2026-09-24).

  - Gold: --gold-500 #C9A227 (primary), --gold-300 #E5C860 (hover/focus). The
    old #D4AF37 is RETIRED. Gold only via theme tokens (src/index.css,
    src/theme/tokens.ts); hex literals ONLY in src/theme/ and src/index.css.
  - Semantic tokens --success/--warning/--danger/--info exist; signature
    divider is the 1px gold hairline (.hairline-gold / -b / -t).
  - TWO CHECKS, both must be 0: (1) retired gold repo-wide, case-insensitive;
    (2) token discipline in src outside src/theme/ (do NOT widen — email
    templates inline #C9A227). Commands: docs/BRAND-STYLE.md "Rules moved".
  - Email templates: canonical literal hex only.
  - Keep package-lock.json on registry.npmjs.org; if private-registry URLs
    reappear, regenerate on main, never from a feature branch.
  - SheetJS stays at 0.18.5 for the admin-only catalog importer; NEVER feed
    customer- or portal-supplied files through it.
  - The DOUBLE SLASH in brand-assets//… video keys is real — never normalize it.

## POST-LOGIN SPLASH (2026-07-06)

  Full mechanics: docs/POST-LOGIN-SPLASH.md (moved verbatim 2026-09-24).
  Shows ONLY on a fresh staff sign-in with no ?next (freshLoginRef set before
  the sign-in await); never on session restore or ?next flows. Failsafes
  (onError, 5s canplay watchdog, reduced motion) are mandatory; there is NO
  auto-navigate timer. Invariants are locked by
  src/test/post-login-splash-guard.test.tsx.

## REALTIME SYNC (added 2026-05-24)

  useRealtimeSync (src/hooks/useRealtimeSync.ts) is mounted once at the App
  root, internal users only (the portal never opens a channel), and invalidates
  REALTIME_INVALIDATE_KEYS on any postgres_changes event from SYNC_TABLES,
  debounced 250 ms. Published tables and mechanics: docs/SCHEMA-FACTS.md
  "Rules moved from CLAUDE.md".

  When adding a new mutating table or a new dashboard query key:
    - If the table drives a card, add it to SYNC_TABLES.
    - If the key isn't covered by any of the four KEY groups, add it to
      one of them (so it's swept into REALTIME_INVALIDATE_KEYS).

## SIDEBAR ARCHITECTURE — NON-NEGOTIABLE (2026-05-31, refresh PR #165)

  Full text (types, navigation, badges, accordion): docs/SIDEBAR.md (moved verbatim 2026-09-24).

  - Sub-items navigate via `${parentPath}?tab=${child.tab}`; every parent page
    keeps ?tab in sync both ways (refresh, deep links, back/forward).
  - Gating: adminOnly / permPath (canSeeNav) / permFilter (can()); a parent
    whose sub-items are all gated out is hidden.
  - LOCKED UI: ONE active indicator — the sliding gold ActivePill (FLIP from its
    last rect; never framer layoutId, never the old parent border / sub-item
    accent); collapse remembered in localStorage 'cj-hub-sidebar-open'; hover
    accordion, one parent open. Full text: docs/SIDEBAR.md "Rules moved".

## FRONTEND / DESIGN WORKFLOW (added 2026-06-19)

1. Before writing any library/framework code (React, Tailwind, Firebase),
   consult Context7 for current docs — don't rely on memory.

2. Build structure with shadcn/ui primitives by default. Check the shadcn
   MCP registry before hand-rolling any component (buttons, cards, dialogs,
   forms, etc.).

3. Only when a component needs motion or visual richness, layer Magic on
   TOP of the shadcn foundation — animated counters, bento grids, shimmer,
   hover effects. Do not reach for Magic for plain/static UI.

4. After any frontend change, verify in a real browser with Playwright:
   start the dev server, navigate to the route, screenshot it, check
   desktop and mobile (~375px), and read the console for errors before
   saying it's done.

5. TYPECHECK — the canonical command is `npx tsc -p tsconfig.app.json --noEmit`
   (the EXACT CI command). NEVER bare `npx tsc --noEmit`: the root tsconfig checks
   ZERO files and always exits 0 — a documented false green (deploy #1896). Any
   error is a regression; there is no accepted baseline. Evidence:
   docs/HUB-UI-MOTION-REVIEW.md "Rules moved from CLAUDE.md".

6. KPI + CHART ANIMATION STANDARDS (2026-07-07): StatCard KPIs pass countUpValue
   + formatValue + staggerIndex, bespoke KPIs use <AnimatedNumber>; charts take
   useChartAnimation() on every series; dashboard hooks use React Query with
   staleTime + keepPreviousData; heavy pages join usePrefetchHeavyPages. A
   surface without them is a defect — docs/HUB-UI-MOTION-REVIEW.md "Rules moved".
