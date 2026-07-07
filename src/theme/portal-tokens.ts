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
  /** Primary brand / CTAs — deeper gold for AA contrast on light backgrounds */
  gold600: '#A8822A',
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
  // Semantic — tuned for light backgrounds, AA-verified against white text
  success: '#3E7D5B',
  warning: '#A9762B',
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
  gold600: '42 60% 41%',
  gold400: '46 67% 47%',
  ink: '30 10% 15%',
  inkMuted: '34 8% 40%',
  success: '148 34% 37%',
  warning: '36 59% 42%',
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
