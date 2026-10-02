import { callUntypedRpc } from '@/lib/untyped-rpc';
import { errorMessage } from '@/lib/error-message';

/**
 * Hero picks (migration 20261013100000, docs/HERO-PICKS.md): an admin ticks
 * "Use on hero" on a product cut-out (Website → Photos). The storefront hero
 * uses the ticks only once system_settings.hero_photo_source is switched to
 * "product_ticks" — until then it keeps showing the hero record. Every write is
 * an RPC (admin role, audited); the rules live in the database.
 */

export type HeroPhotoSource = 'hero_record' | 'product_ticks';

/** Why a cut-out cannot be on the hero (hero_pick_reason). null = it can. */
export type HeroPickBlocker =
  | 'no_cutout' | 'kept_original' | 'rejected' | 'not_approved' | 'not_completed' | 'no_cutout_file' | 'not_published';

export const HERO_PICK_BLOCKER_TEXT: Record<HeroPickBlocker, string> = {
  no_cutout: 'there is no cut-out for this photo',
  kept_original: 'the original photo was kept (no cut-out)',
  rejected: 'the cut-out was rejected',
  // Approval first (20261026100000): passed the checks, but no staff Approve yet.
  not_approved: 'the cut-out is not approved yet — approve it first',
  not_completed: 'the cut-out is not finished and approved yet',
  no_cutout_file: 'the cut-out has no file',
  not_published: 'its product is not published',
};

export const blockerText = (b: string | null | undefined): string | null =>
  b ? HERO_PICK_BLOCKER_TEXT[b as HeroPickBlocker] ?? b : null;

/**
 * Published in-stock products and where they stand (hero_product_counts).
 * From 20261016100000, products_on_hero counts only pieces actually ON a
 * category slide (at most 3 per category, in tick order) and hero_waiting the
 * ticked pieces waiting their turn; published_left_out = on no slide (the
 * waiting ones included). hero_waiting is absent before that migration.
 */
export interface HeroProductCounts {
  published_in_stock: number;
  products_on_hero: number;
  published_left_out: number;
  hero_waiting?: number;
}

/** The Hero tab's totals (get_media_cutout_tab_totals → tabs.hero). */
export interface HeroTabTotals extends HeroProductCounts {
  count: number;
  usable: number;
  paid_calls: number;
}

export const HERO_SOURCE_LABEL: Record<HeroPhotoSource, string> = {
  hero_record: 'Hero record (approved hero cut-outs)',
  product_ticks: 'Ticked product cut-outs',
};

/** What the website hero shows with each value — said before the owner switches. */
export const HERO_SOURCE_TEXT: Record<HeroPhotoSource, string> = {
  hero_record:
    'The website hero shows the approved cut-outs of the Hero cut-outs card (the storefront workflow), as it does today. Ticks are kept but not used.',
  product_ticks:
    'The website hero shows ONLY pieces with a product cut-out ticked "Use on hero": up to 3 per category, in the order they were ticked (oldest first). Publishing a product never changes the hero. A piece that sells or is unpublished drops out and the next ticked piece of that category takes its place. The Hero cut-outs card is no longer used.',
};

export interface CarryOverResult {
  ok: true;
  applied: boolean;
  approved_hero: number;
  already_ticked: number;
  /** Preview: how many it would tick. */
  to_tick?: number;
  /** Apply: how many it ticked (0 on a second press). */
  ticked?: number;
  left_out: Partial<Record<HeroPickBlocker, number>>;
  products_now: HeroProductCounts;
  products_after?: HeroProductCounts;
}

/** The slide limit the storefront uses (lib/hero-deck.ts PIECES); get_hero_lineup sends it too. */
export const HERO_SLIDE_LIMIT = 3;

/** Why a ticked piece is not on any slide (hero_lineup_rows, 20261016100000). */
export type HeroLineupReason = 'not_published' | 'cutout_not_usable' | 'sold' | 'no_category';

export const HERO_LINEUP_REASON_TEXT: Record<HeroLineupReason, string> = {
  not_published: 'not published',
  cutout_not_usable: 'no ticked photo is usable now',
  sold: 'sold out — it comes back to its place if it is back in stock',
  no_category: 'not in any published category',
};

export const lineupReasonText = (r: string | null | undefined): string =>
  r ? HERO_LINEUP_REASON_TEXT[r as HeroLineupReason] ?? r : '';

/** One ticked piece in the running order (get_hero_lineup). */
export interface HeroLineupPiece {
  product_id: string;
  sku: string;
  name: string;
  slug: string;
  /** 1..n among the pieces that can show; null when not showing. */
  place: number | null;
  state: 'on_hero' | 'waiting' | 'not_showing';
  reason: HeroLineupReason | null;
  /** When its earliest usable photo was ticked (its place in the queue). */
  first_picked_at: string;
  photo: { source_url: string; thumb_path: string | null } | null;
}

export interface HeroLineupCategory {
  id: string;
  slug: string;
  name: string;
  on_hero: HeroLineupPiece[];
  waiting: HeroLineupPiece[];
  not_showing: HeroLineupPiece[];
}

export interface HeroLineup {
  hero_photo_source: HeroPhotoSource;
  slide_limit: number;
  categories: HeroLineupCategory[];
  no_category: HeroLineupPiece[];
}

export const HERO_LINEUP_KEY = ['hero-lineup'] as const;

export class HeroPickRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const out = await callUntypedRpc<Record<string, unknown> | null>(fn, args);
  if (out && typeof out === 'object' && typeof out.error === 'string') throw new HeroPickRefusal(out.error);
  return (out ?? {}) as T;
}

export const setHeroPick = (sourceUrl: string, pick: boolean) =>
  rpc<{ ok: true; hero_pick: boolean; changed: boolean }>('set_hero_pick', { p_source_url: sourceUrl, p_pick: pick });

/** Per category: ticked pieces on the hero now, waiting, not showing (read-only; 20261016100000). */
export const getHeroLineup = () => rpc<HeroLineup>('get_hero_lineup');

export const carryOver = (apply: boolean) => rpc<CarryOverResult>('hero_picks_carry_over', { p_apply: apply });

export const setHeroPhotoSource = (source: HeroPhotoSource, expected: HeroPhotoSource | null) =>
  rpc<{ ok: true; changed: boolean; source: HeroPhotoSource }>('set_hero_photo_source', {
    p_source: source, p_expected_source: expected,
  });

export const readHeroPhotoSource = (v: unknown): HeroPhotoSource | null =>
  v === 'product_ticks' ? 'product_ticks' : v === 'hero_record' ? 'hero_record' : null;

export function heroPickRefusalText(err: unknown): string {
  if (!(err instanceof HeroPickRefusal)) return errorMessage(err);
  const blocker = blockerText(err.code);
  if (err.code in HERO_PICK_BLOCKER_TEXT && blocker) return `Cannot use this photo on the hero: ${blocker}.`;
  switch (err.code) {
    case 'admin_only': return 'Only an admin can choose the hero photos.';
    case 'user_identity_required': return 'Sign in again to do this.';
    case 'not_found': return 'This photo is no longer in the list. Refresh and try again.';
    case 'stale': return 'Someone switched the hero a moment ago. Check the switch and try again.';
    case 'invalid_source': return 'That is not one of the two hero sources.';
    case 'setting_missing': return 'The hero switch is not set up yet — the migration has not been run.';
    case 'permission_denied': return 'You do not have access to the website photos.';
    default: return `Could not save: ${err.code}`;
  }
}
