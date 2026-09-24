<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## SIDEBAR ARCHITECTURE — NON-NEGOTIABLE (added 2026-05-31)

### Item types
Two kinds of sidebar items in src/components/layout/AppSidebar.tsx:
- **Leaf items** (Dashboard, Executive Dashboard, Admin Audit): direct Link to path
- **Parent items with sub-menus** (Customers, CSR Monitoring, Finance, Promotions, Loyalty, Settings): collapsible group with children that navigate via ?tab= query param

### MenuItem type contract
  type SubMenuItem = { label, tab, badgeKey?, permFilter? }
  type MenuItem = { label, icon, path? (leaf), parentPath? (parent), children?, adminOnly?, permPath? }

### Navigation convention
- Sub-item links: `${parentPath}?tab=${child.tab}`
- Each parent page reads ?tab from URL via useSearchParams and switches active tab
- Refresh, deep links, browser back/forward all stay in sync with active tab
- Sub-item label is text-only (no icons) — keeps Loyalty's 12 sub-items readable

### Tab URL sync pattern (applied to all 6 parent pages)
Customers, Monitoring, Finance, Promotions, LoyaltyAdmin, SettingsPage all use this pattern:
  - Initialize tab state from searchParams.get('tab') with fallback to default
  - setTab wraps both local state update + setSearchParams(..., { replace: true })
  - useEffect on [searchParams] mirrors external URL changes to local state
LoyaltyAdmin reads directly from searchParams each render (alternative pattern, equivalent effect).

### Accordion behavior
- Hover-based: only one parent expanded at a time
- Hover on parent → that parent expands, all others collapse
- Hover on leaf → all parents collapse
- Click on parent → toggles (close if open; open + close others if closed)
- Auto-expand on path match: navigating to /parentPath opens that parent automatically

### Permission gating
- `adminOnly` on MenuItem hides whole parent
- `permPath` on MenuItem uses canSeeNav()
- `permFilter` on SubMenuItem uses can() — gates individual sub-items
- If all sub-items of a parent are gated out, the parent itself is hidden

### Badges
- Parent aggregate badge: badgeCountByPath (path → count)
- Sub-item specific badge: badgeBySubKey (badgeKey → count)
- Both visible simultaneously — Finance parent shows submissions + waivers total, Documentation sub-item shows the same count

### Locked UI decisions (updated — Hub visual refresh, approved by Cynthia, PR #165)
- ONE active indicator: the sliding gold pill (`ActivePill` in AppSidebar.tsx) —
  gold-500 tint + 1px gold inset ring + 2px gold bar on the left, gold-300 text.
  It sits on exactly one row: the active leaf, OR the active sub-item when its
  parent is expanded, OR the parent itself when its sub-menu is closed or the
  sidebar is icon-only. It replaces both former styles (the parent "inside"
  left border and the separate sub-item accent) — do not reintroduce them.
- The pill GLIDES between rows. Every page mounts its own AppLayout, so the
  sidebar remounts on each navigation and framer-motion `layoutId` cannot
  animate across it; ActivePill records its last rect on unmount and the next
  pill FLIPs from there (reduced motion: it simply appears). Never swap this
  back to `layoutId` without first moving AppLayout to a shared layout route.
- The expanded group is seeded from the route on the FIRST render (useState
  initialiser), not only in the effect — a one-frame all-collapsed state let
  whichever row slid under a stationary cursor steal the hover accordion.
- Icon-only collapse (`collapsible="icon"`) is remembered per browser in
  localStorage key `cj-hub-sidebar-open` (every access try/catch-guarded).
  On the icon rail, badges become a dot and clicking a parent opens the
  sidebar with that group expanded. Phones keep the slide-out drawer.
- Section headers: Deco serif small caps + a trailing gold hairline.
- No hover delay (immediate accordion switch) — can be revisited if jitter becomes an issue

