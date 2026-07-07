/**
 * Deco Ledger design tokens — Cha Jewels Hub
 *
 * Single source of truth for the "Deco Ledger" dark-luxe ERP palette.
 * CSS custom properties in src/index.css mirror these values (HSL triplets)
 * for Tailwind consumption; import from here for anything programmatic
 * (recharts colors, canvas, inline styles).
 *
 * Rule: gold is an ACCENT — active states, key CTAs, tier badges, hairline
 * rules. Body text is champagne, secondary text is ink-muted. Never set
 * long-form body copy in gold.
 */

export const palette = {
  /** App background — warm near-black, not pure black */
  surface0: '#0F0E0C',
  /** Cards, panels */
  surface1: '#1A1815',
  /** Elevated rows, modals, popovers */
  surface2: '#262320',
  /** Primary brand — Art Deco gold. Use sparingly. */
  gold500: '#C9A227',
  /** Hover / focus accents */
  gold300: '#E5C860',
  /** Primary text on dark */
  champagne: '#F3EBDD',
  /** Secondary text, labels */
  inkMuted: '#9B948A',
  // Semantic
  success: '#4CAF7D',
  warning: '#D9A441',
  danger: '#C25450',
  info: '#6B8FB5',
} as const;

/**
 * HSL triplets (H S% L%) matching the CSS custom properties in index.css.
 * Use as `hsl(${hslTriplets.gold500})` or `hsl(${hslTriplets.gold500} / 0.4)`.
 */
export const hslTriplets = {
  surface0: '40 11% 5.3%',
  surface1: '36 11% 9.2%',
  surface2: '30 9% 13.7%',
  gold500: '46 68% 47%',
  gold300: '47 72% 64%',
  champagne: '38 48% 91%',
  inkMuted: '35 8% 57.5%',
  success: '150 39% 49%',
  warning: '39 67% 55%',
  danger: '2 48% 54%',
  info: '211 33% 56%',
} as const;

/** The signature Art Deco "ledger line": 1px gold hairline at 40% opacity. */
export const hairline = `hsl(${hslTriplets.gold500} / 0.4)`;

/**
 * Type scale (px). Labels are 12px UPPERCASE letter-spaced 0.08em —
 * use the `.label-caps` utility from index.css.
 */
export const typeScale = [12, 13, 14, 16, 20, 28, 40] as const;

/** Chart colors (recharts, sparklines) — keep series order stable. */
export const chartColors = {
  primary: palette.gold500,
  primarySoft: palette.gold300,
  grid: 'rgba(201, 162, 39, 0.12)',
  axis: palette.inkMuted,
  positive: palette.success,
  negative: palette.danger,
  neutral: palette.info,
} as const;

/** Spacing follows a strict 4px grid. */
export const gridUnit = 4;

/** Border radii (px): cards 8, inputs 6, pills 999. */
export const radii = { card: 8, input: 6, pill: 999 } as const;
