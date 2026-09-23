# Hub UI and motion improvements

Branch: `feature/hub-ui-motion`, based on `932709c2` (develop).

## Implemented

- Damped spring page entrance, retaining reduced-motion support.
- Shared CSS motion timing from the existing theme configuration.
- Button press feedback that preserves positioned transforms; 44px minimum touch targets on coarse pointers.
- Transform-based skeleton sweep instead of animating background position.
- Static layered card shadows with pointer-aware transform-only hover movement.
- Bounded, scrollable dialogs using dynamic viewport height; 44px close controls, title clearance, spaced footer actions and reduced-motion CSS.
- Named table search/column/export controls, larger filter/sort/expand targets and visible keyboard focus.
- Expanded table content fades without per-frame height animation.
- Explicit SKU/name/slug label associations and responsive product editor sizing.
- Larger default mobile textarea text and tighter catalog collection prop typing.

## Verification

- Production build passed (existing ambiguous duration utility warning elsewhere).
- Application typecheck passed, including the final type cleanup.
- Full test suite: 141 passed, one failure in post-login session restoration. The same failure reproduced in an unchanged detached worktree at the base commit (three passed, one failed in that test file).
- Targeted lint passed with zero errors after correcting existing empty-interface and catalog `any` declarations. One existing button fast-refresh export warning remains.
- No dependency, payment, inventory, authentication or database behavior changes are included.

## Pending acceptance

Visual browser screenshots at 375px and 1440px, physical-phone checks, keyboard interaction checks, reduced-motion rendering, and Lighthouse/performance traces remain outstanding. No FPS or speed improvement is claimed as measured.

Review dialogs with long content and phone keyboard open, Hub and Maison consumers of shared primitives, nested select/popover menus, expanded table details and disabled/asChild buttons. The source still contains other animation and accessibility work outside this scoped pass.

Do not deploy based solely on a successful build. This feature branch is for review; production is unchanged. Rollback is a revert of the feature commit; no migration is required.

## Round 2

Follow-up to the review of `7ecf3d68`. All timings still come from `src/theme/motion.ts`; no inline durations were added.

### Fixes

1. **Button hover regression** (`src/index.css`, `.ui-button`). The base button had lost its color transition, so hover colors snapped. The transition now covers `scale, color, background-color, border-color, box-shadow, opacity` at `var(--ui-motion-micro, 0.12s)` with the shared ease. `touch-action`, the `:active` 0.98 scale, the coarse-pointer 44px rule and the reduced-motion override are unchanged.
2. **CSS variable fallbacks** (`src/index.css`). Every `var(--ui-motion-micro|standard|ease)` usage now has a fallback equal to `motion.ts` (0.12s / 0.2s / `cubic-bezier(0.22,1,0.36,1)`). That covers the button, the dialog panel/overlay, `.card-hover` and its new `::after`. `main.tsx` still injects the variables, so `motion.ts` remains the single source of truth.
3. **DataTable mobile search** (`src/components/data-table/DataTable.tsx`). The search wrapper is `relative w-full sm:w-auto`, so the input's `w-full` spans the toolbar row on mobile.
4. **Gilded card hover without animating box-shadow** (`src/index.css`, `.card-hover`). The card is now `position: relative` with a `::after` layer carrying the gold ring and glow at opacity 0. Hover (fine pointers only) fades that layer to opacity 1, so only `opacity` animates. Under reduced motion there is no transition and no translateY.
   - Position audit: all 14 `.card-hover` usages were checked. None positions the card itself absolute, fixed or sticky. 11 were already `relative`; 3 were static (CustomerCard, CashOrdersList, CustomerCashOrdersTab). None was skipped.
   - **Known limitation, needs a decision:** 11 of the 14 cards also carry `overflow-hidden`: StatCard, the Dashboard plan-tier tiles and the AccountDetail tiles. On those cards the outer ring and glow are clipped at the padding box, so the hover shows only the lift and the card's own border change. The ring is fully visible on the 3 cards without `overflow-hidden`. Swapping to inset shadows (`inset 0 0 0 1px …, inset 0 0 18px …`) would make it visible on all 14. That is a one-line change, but it deviates from the specified values, so it was left as specified.

### Enhancements (Framer Motion)

5. **Tabs sliding indicator** (`src/components/ui/tabs.tsx`). A 2px gold underline (`bg-primary`) slides between active triggers. It is a `motion.span` with a `layoutId` namespaced per Tabs instance via `useId`, and uses `transition.spatial`. `Tabs` now tracks the active value (controlled `value` or uncontrolled `defaultValue` plus `onValueChange`) and passes every prop through to Radix unchanged. Public props of `Tabs`, `TabsList` and `TabsTrigger` are unchanged. The indicator is `aria-hidden` and `pointer-events-none`. Measured in Chromium: with motion on, the indicator is mid-slide 60ms after a click (x 36 → 69 → 276). With reduced motion it is already at its destination at 60ms (jump). ArrowRight still moves selection, so Radix keyboard behavior is intact.
6. **Dashboard KPI stagger** (`src/components/dashboard/KpiStrip.tsx`, the "At a Glance" grid). The grid is a `motion.div` with `staggerContainer`, and each card sits in a `staggerItem` wrapper. The wrapper is `display: grid` so cards still stretch to equal row height. A `hasAnimatedRef` switches later renders to `initial={false}`, including a skeleton round-trip that remounts the grid, so refetches never re-animate. The cards' old CSS `staggerIndex` fade was removed from these four cards so they don't animate twice. No figure, calculation or query was touched; the StatCard count-up is unchanged.

### Verification

- `npx tsc -p tsconfig.app.json --noEmit`: exit 0, no output.
- `npx vite build`: passed.
- `npx vitest run`: 141/142. The one failure is `post-login-splash-guard` "session restore", which also fails on `develop` (see above).
- ESLint on the touched TSX files: clean.
- Playwright (Chromium) screenshots at 375px and 1440px, plus a prefers-reduced-motion set, are in `docs/screenshots/hub-ui-motion/`. They were taken against the DEV-only `/__fixtures` harness with fixture data, not live data. Three harness views were added for this: `product-dialog` (the real Website Catalog `ProductDialog` with a long form), `datatable` (the real `DataTable` with expandable rows) and `tabs` (the real Tabs primitive with the /website tab set). The live `/website` page needs a signed-in session with website permissions, so it could not be shot from the harness.
- Console: the only errors were `ERR_CONNECTION_REFUSED`, from unseeded queries trying to reach the placeholder backend the harness runs against.

### Still pending acceptance

Physical-phone checks and a pass on the Firebase PR preview with real data. The card-hover limitation above needs Cynthia's call.
