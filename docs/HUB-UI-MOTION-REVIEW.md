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
