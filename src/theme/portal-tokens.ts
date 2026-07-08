/**
 * Maison design tokens — Cha Jewels Customer Portal
 *
 * Single source of truth for the "Maison" light-luxe boutique palette.
 * This is a SEPARATE token system from the internal Hub's "Deco Ledger"
 * (src/theme/tokens.ts) — never import from that file, never add these
 * values to it. The two products share a visual family resemblance (the
 * gold hairline signature) but never a token source.
 *
 * CSS custom properties in src/index.css (the `.maison-portal` scope,
 * `@layer utilities`) mirror these values for Tailwind consumption via
 * the SAME shared shadcn variable names the Hub's `.dark` scope uses
 * (--background, --primary, --card, etc.) — descendant-scoped, so any
 * component nested under `.maison-portal` picks up Maison colors while
 * everything outside it is unaffected. Import from here for anything
 * programmatic (charts, canvas, inline styles).
 *
 * Rule: --gold-600 is for text/CTAs (AA-verified on ivory). --gold-400 is
 * decorative only (icons, hairlines) — never body text or small CTAs.
 */

export const palette = {
  /** App background — warm ivory, never pure white */
  surface0: '#FAF7F2',
  /** Cards */
  surface1: '#FFFFFF',
  /** Subtle wells, timeline tracks */
  surface2: '#F1EBE1',
  /**
   * Primary brand / CTAs. Darkened from the original #A8822A on 2026-07-08
   * after the Phase 3 Lighthouse audit measured it at only 3.34:1 as text on
   * surface0 — short of WCAG AA's 4.5:1 for normal text. First pass (#8B6C23,
   * L 41%→34%) still failed on tinted pill backgrounds (bg-primary/10 etc,
   * which lighten the effective background) — measured 4.03:1 there. #7A5F1F
   * (same 42°/60% hue/saturation, L 41%→30%) measures 5.64:1 on plain
   * surface0 and 4.93:1 even on a 10%-opacity self-tinted pill. Paired with a
   * white --primary-foreground (was --portal-ink, which only hit 4.16:1 on
   * the original shade) — see index.css.
   */
  gold600: '#7A5F1F',
  /**
   * Decorative accents, icons, the hairline signature. NOTE: this hex is
   * intentionally identical to the Hub's gold500 (#C9A227) — the shared
   * gold is the deliberate "family resemblance" signature between the two
   * products (same Art Deco line, different job). Coincidence in name
   * only; this file never imports the Hub's token.
   */
  gold400: '#C9A227',
  /** Primary text — warm near-black */
  ink: '#2B2723',
  /** Secondary text, labels */
  inkMuted: '#6E675E',
  // Semantic — tuned for light backgrounds, AA-verified as text on surface0/1/2
  success: '#3E7D5B',
  /** Darkened from #A9762B on 2026-07-08 (Lighthouse: 3.70:1 on surface0; the
   * first pass, #926726, still failed on a 12%-tint pill at 4.05:1). #825B21
   * measures 4.81:1 even on a 12%-tint pill. */
  warning: '#825B21',
  danger: '#A4423E',
  info: '#4A6B8A',
} as const;

/**
 * HSL triplets (H S% L%) matching the CSS custom properties in index.css.
 * Use as `hsl(${hslTriplets.gold600})` or `hsl(${hslTriplets.gold600} / 0.4)`.
 */
export const hslTriplets = {
  surface0: '38 44% 96%',
  surface1: '0 0% 100%',
  surface2: '38 36% 91%',
  gold600: '42 60% 30%',
  gold400: '46 67% 47%',
  ink: '30 10% 15%',
  inkMuted: '34 8% 40%',
  success: '148 34% 37%',
  warning: '36 59% 32%',
  danger: '2 45% 44%',
  info: '209 30% 42%',
} as const;

/**
 * The signature Art Deco hairline, here expressing the payment journey
 * rather than structure — same line as the Hub, different job.
 */
export const hairline = `hsl(${hslTriplets.gold600} / 0.35)`;

/** Type scale (px): 13/14/16/18/22/30/44, comfortable 1.6 line-height. */
export const typeScale = [13, 14, 16, 18, 22, 30, 44] as const;

/** Border radii (px): 12 cards, 8 inputs, 999 pills. */
export const radii = { card: 12, input: 8, pill: 999 } as const;

/** Spacing follows a 4px grid, but with generous rhythm: 24-32px between
 *  card sections (vs. the Hub's 12-16px) — this is a boutique, not an ERP. */
export const gridUnit = 4;
export const sectionRhythm = { compact: 24, generous: 32 } as const;

/** Chart colors (points ledger, statements) — keep series order stable. */
export const chartColors = {
  primary: palette.gold600,
  primarySoft: palette.gold400,
  grid: 'rgba(168, 130, 42, 0.12)',
  axis: palette.inkMuted,
  positive: palette.success,
  negative: palette.danger,
  neutral: palette.info,
} as const;

/**
 * Loyalty member-card gold — a brighter, decorative 3-stop gradient, distinct
 * from the gold400/gold600 TEXT tokens above (which are darkened for AA on
 * ivory; this is a large decorative fill, so brightness is intentional). This
 * is the SINGLE SOURCE for the gradient/accent that was previously duplicated
 * inline in MemberCard.tsx, ProfileMemberCard.tsx, LoyaltyTierBadge.tsx, and
 * the HomeScreen "Redeem Points" CTA. Hex literals live here (src/theme/) per
 * the brand-token rule — call sites import these instead of re-typing them.
 */
export const memberCard = {
  /** The gold gradient used as the member-card surface + the primary CTA fill. */
  gradient: 'linear-gradient(135deg, #C9A84C 0%, #E8C96D 50%, #C9A84C 100%)',
  /** Near-black foreground for text/icons sitting on the gold gradient. */
  ink: '#1A1500',
  /** Muted tan fallback accent for tier badges (matches TIER_STATIC.Glimmer). */
  mutedAccent: '#9A8F7E',
} as const;

/**
 * Disabled/muted button pairing that reads on the ivory Maison surface — a
 * light well + muted ink. Replaces the near-black `#1A1A1A` / `#9A8F7E`
 * dark-theme leftover on the HomeScreen "Redeem Points" button's zero-points
 * state (a highly visible regression, since that is the default for most
 * customers).
 */
export const disabledButton = {
  background: `hsl(${hslTriplets.surface2})`,
  color: `hsl(${hslTriplets.inkMuted})`,
} as const;
