<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## BRAND STYLE STANDARD (updated 2026-07-06 — Deco Ledger)

  Canonical brand gold (Deco Ledger, confirmed by Cynthia 2026-07-06):
    --gold-500: #C9A227 = hsl(46 68% 47%)   primary gold — active states,
                                            key CTAs, tier badges, hairlines
    --gold-300: #E5C860 = hsl(47 72% 64%)   hover/focus accents, focus ring
  The former gold #D4AF37 is RETIRED. Gold is applied ONLY via theme tokens
  (--primary / --accent / --ring / --gold family in src/index.css; TS mirror
  incl. chartColors in src/theme/tokens.ts). Hardcoded gold hex literals are
  allowed ONLY in src/theme/ and src/index.css — never in components/pages.

  Semantic tokens --success / --warning / --danger / --info (plus
  *-foreground) ARE defined as of 2026-07-06 (Phase 1 Deco Ledger commit) —
  the matching Tailwind classes are safe to use. The signature structural
  divider is the 1px gold hairline: .hairline-gold / .hairline-b /
  .hairline-t (gold-500 at 40%).

  TWO checks, different purposes. Both must pass; running only the first
  is what let the retired gold survive in the email templates until
  2026-09-09 (see below).

  1. RETIRED GOLD — repo-wide, CASE-INSENSITIVE, target 0 hits:
       grep -rniE "#D4AF37|#E7D7A2|#E8C84A" src supabase/functions --include="*.tsx" --include="*.ts"
     The -i is not optional: 29 of the 79 occurrences found on 2026-09-09
     were lowercase `#d4af37` and invisible to a case-sensitive grep.

  2. TOKEN DISCIPLINE — src only, target 0 hits:
       grep -rnE "#D4AF37|#E7D7A2|#C9A227|#E5C860|#E8C84A" src --include="*.tsx" --include="*.ts" | grep -v "src/theme/"
     Scoped to src BY DESIGN. Do NOT widen this one to supabase/functions:
     the transactional email templates must inline literal hex (mail
     clients do not resolve CSS custom properties), so they legitimately
     carry ~79 canonical #C9A227 literals and would fail it forever.
     Check 1 is what governs them.

  Target: 0 hits on both. The gold-literal migration COMPLETED 2026-07-06 (Phase 5)
  — all former debt rows (Finance/Commissions/Timesheet/Inquiries charts,
  ForgotPassword, Login, PortalLogin, AuthContext splash, AdminSplashScreen,
  TierCelebrationModal confetti) now import from src/theme/tokens. The
  avatar gradients (AppSidebar/AppLayout) use the gold-gradient class.
  Never reintroduce a gold hex outside src/theme/ and src/index.css.

  Remaining tracked debt (each row re-justified 2026-07-06, Phase 5):
    - .github/workflows/.github/workflows/firebase-hosting.yml — INERT
      nested duplicate workflow (survives — lives outside src/, needs its
      own cleanup commit; GitHub never executes nested paths). NOTE: the
      REAL deploy workflow .github/workflows/firebase-deploy.yml is LIVE.
      As of 2026-09-11 it deploys to PRODUCTION hosting only on a push to
      main; pushes to develop go to the `develop` preview channel and each
      PR gets a `pr-<number>` channel with the URL posted on the PR. The
      Typecheck and Deno gates run on all three. docs/AUTO-DEPLOY.md
      describes a different, removed workflow (Supabase edge functions)
      and does not apply.
    - PACKAGE-LOCK PRIVATE-REGISTRY QUIRK (RESOLVED 2026-09-09): from
      fbc9338 (MCP integration) until 2026-09-09, package-lock.json pinned
      ~94 tarball URLs to Lovable's private registry
      (europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache), so
      `npm ci` and fresh installs OUTSIDE Lovable/CI failed with 403 on the
      newer entries. The Claude Code web sandbox made this worse than
      documented: its egress proxy REJECTS europe-west1-npm.pkg.dev
      outright (connect_rejected, organization policy), so `npm install`
      there hangs rather than failing fast, and killing it mid-run leaves
      node_modules unusable. The lockfile was regenerated against
      registry.npmjs.org as the sanctioned main-side fix. Keep it that way:
      if private-registry URLs reappear, regenerate on main again — never
      from a feature branch.

    - TRANSACTIONAL EMAIL TEMPLATES (RESOLVED 2026-09-09): all 29
      templates under supabase/functions/_shared/transactional-email-
      templates/ carried the RETIRED #D4AF37 — 79 occurrences (50
      uppercase, 29 lowercase in every footerBrand). They survived the
      2026-07-06 Phase 5 migration because the only documented check was
      scoped to `src`, and these live under supabase/. Swapped to
      #C9A227 and the check widened (above). These files intentionally
      use literal hex — emails cannot read CSS variables — so the rule
      for them is "canonical literal only", never "no literal".
      NOTE (unfixed, separate decision): the shared `button` style sets
      color #ffffff on the gold fill. White on #C9A227 measures ~2.4:1,
      short of AA — slightly better than the ~2.1:1 it was on #D4AF37,
      but still failing. extension-requested.tsx already uses dark
      #1a1a2e text on gold and is the accessible pattern. Left as-is
      because it is a visual change, not a token swap.

    - SHEETJS (`xlsx`) PINNED AT 0.18.5 (accepted 2026-09-09): 0.18.5 is
      the last release SheetJS published to npm. It carries a
      prototype-pollution advisory (GHSA-4r6h-8v6p-xvw6) and a ReDoS
      (GHSA-5pgg-2g8v-p4x9); both are fixed only in >=0.19.3 / >=0.20.2,
      which ship from cdn.sheetjs.com and not from npm. Accepted because
      the only parser is the Website Catalog spreadsheet importer — an
      admin-only, browser-side parse of a file that admin chose. Do NOT
      feed customer- or portal-supplied files through it. REVISIT TRIGGER:
      if SheetJS resumes publishing to npm, or if any parsing moves
      server-side or accepts a file from outside the Hub, upgrade or
      replace the library.

  Background photo: brand-assets/IMG_4761.jpeg (Supabase Storage, public)
  Used by: AppLayout.tsx (Hub interior, under bg-black/72 overlay)
           PortalLogin.tsx (PORTAL_HERO constant)
  Admin login (Login.tsx) intentionally keeps IMG_3197.jpeg — now as the
  poster/fallback/reduced-motion image for the HERO_VIDEO constant
  (brand-assets//SigninVideo.mp4, Seedance-generated
  "necklaces one by one", plays once and freezes on its final frame = the
  photo). The DOUBLE SLASH in that video's storage key is real — never
  "normalize" it (same rule as the post-login splash asset).

  Gold tokens --gold / --gold-light / --gold-dark remain defined in :root and
  .dark and now alias the Deco Ledger family (--gold = gold-500,
  --gold-light = gold-300).

