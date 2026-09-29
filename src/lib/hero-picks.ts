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
  | 'no_cutout' | 'kept_original' | 'rejected' | 'not_completed' | 'no_cutout_file' | 'not_published';

export const HERO_PICK_BLOCKER_TEXT: Record<HeroPickBlocker, string> = {
  no_cutout: 'there is no cut-out for this photo',
  kept_original: 'the original photo was kept (no cut-out)',
  rejected: 'the cut-out was rejected',
  not_completed: 'the cut-out is not finished and approved yet',
  no_cutout_file: 'the cut-out has no file',
  not_published: 'its product is not published',
};

export const blockerText = (b: string | null | undefined): string | null =>
  b ? HERO_PICK_BLOCKER_TEXT[b as HeroPickBlocker] ?? b : null;

/** The Hero tab's totals (get_media_cutout_tab_totals → tabs.hero). */
export interface HeroTabTotals {
  count: number;
  usable: number;
  paid_calls: number;
  products_on_hero: number;
  published_left_out: number;
  published_in_stock: number;
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
    'The website hero shows ONLY product cut-outs ticked "Use on hero" — up to 4 per piece. A piece without a ticked, usable photo leaves the hero. The Hero cut-outs card is no longer used.',
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
  products_now: { published_in_stock: number; products_on_hero: number; published_left_out: number };
  products_after?: { published_in_stock: number; products_on_hero: number; published_left_out: number };
}

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
    default: return `Could not save: ${err.code}`;
  }
}
