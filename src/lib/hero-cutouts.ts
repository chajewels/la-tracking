import { callUntypedRpc } from '@/lib/untyped-rpc';
import { publicUrl } from '@/lib/media-cutouts';

/**
 * Website → Photos → Hero cut-outs (docs/HERO-CUTOUTS.md; migration
 * 20261009100000_hero_cutouts). The HERO-ONLY record: cut-outs made by the
 * original tool (BiRefNet-general via rembg) in the storefront's scheduled
 * workflow — separate from Photoroom's product cut-outs (lib/media-cutouts.ts),
 * which this file never reads or writes.
 *
 * Reading needs manage_website_catalog; approving, rejecting and the go-live
 * switch are ADMIN ROLE only (checked again in SQL), each one audited. Every
 * call goes through callUntypedRpc (not in types.ts until Lovable regenerates
 * it).
 */

export type HeroStatus = 'ok' | 'auto_fixed' | 'needs_review' | 'failed' | 'approved' | 'rejected';
export type HeroMode = 'approve' | 'auto';
export type HeroFilter = 'waiting' | 'held' | 'live' | 'rejected' | 'all';

export interface HeroOverview {
  mode: HeroMode;
  updated_at: string | null;
  updated_by_name: string | null;
  can_review: boolean;
  status_counts: Partial<Record<HeroStatus, number>>;
  last_recorded_at: string | null;
}

export interface HeroRow {
  id: string;
  source_url: string;
  source_sha256: string;
  source_width: number | null;
  source_height: number | null;
  status: HeroStatus;
  qa_status: 'ok' | 'auto_fixed' | 'needs_review' | 'failed';
  flags: string[];
  coverage: number | null;
  cutout_path: string | null;
  width: number | null;
  height: number | null;
  model: string;
  auto_approved: boolean;
  reviewed_at: string | null;
  review_note: string | null;
  updated_at: string;
  product: { id: string; sku: string; name: string; slug: string; status: string } | null;
}

export const HERO_OVERVIEW_KEY = ['hero-cutouts-overview'] as const;
export const HERO_LIST_KEY = 'hero-cutouts-list';
export const HERO_PAGE_SIZE = 20;

export const HERO_FILTERS: { value: HeroFilter; label: string }[] = [
  { value: 'waiting', label: 'Waiting for approval' },
  { value: 'held', label: 'Held by the checks' },
  { value: 'live', label: 'Live on the hero' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

export const HERO_STATUS_LABEL: Record<HeroStatus, string> = {
  ok: 'Waiting — passed',
  auto_fixed: 'Waiting — passed (edge faded)',
  needs_review: 'Held',
  failed: 'Failed',
  approved: 'Live',
  rejected: 'Rejected',
};

export const HERO_MODE_TEXT: Record<HeroMode, string> = {
  approve: 'Approve first — every new hero cut-out waits for an admin. Until then the hero shows the whole photo.',
  auto: 'Automatic — a cut-out that passed every check goes live on the hero by itself. Held ones still wait.',
};

/** The checks' flags in plain words (storefront scripts/hero-cutouts/qa.py). */
export function describeHeroFlag(flag: string): string {
  const [key, value = ''] = flag.split(':');
  switch (key) {
    case 'extra_objects': return `A second object was in the photo (${value}); only the main piece was kept.`;
    case 'edge_touch': return `The piece is cut by the photo's edge (${value.replace(/,/g, ', ')}); that side is faded.`;
    case 'coverage': return `The piece fills an unusual share of the photo (${Math.round(Number(value) * 100)} %).`;
    case 'low_res': return `The photo is too small for the hero (${value.replace('x', ' × ')} px; at least 1200 px on the long side).`;
    case 'interior_hole': return `Part of the piece was erased from inside it (${value} px) — e.g. a dial or a stone.`;
    case 'relative_coverage': return `This photo kept far less of the piece than the main photo (${Math.round(Number(value) * 100)} % of it).`;
    case 'api_error': return `The cut-out could not be made (${value}).`;
    default: return flag;
  }
}

class RpcRefusal extends Error {
  constructor(readonly code: string, readonly detail?: Record<string, unknown>) { super(code); }
}

type Transport = (fn: string, args?: Record<string, unknown>) => Promise<unknown>;
let transport: Transport = (fn, args) => callUntypedRpc(fn, args);
/** DEV FIXTURE ONLY (/__fixtures/?view=hero-cutouts): answer the hero RPCs in memory. */
export function setHeroTransportForFixture(t: Transport) { transport = t; }

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const out = (await transport(fn, args)) as Record<string, unknown> | null;
  if (out && typeof out === 'object' && typeof out.error === 'string') throw new RpcRefusal(out.error, out);
  return (out ?? {}) as T;
}

export const getHeroOverview = () => rpc<HeroOverview>('get_hero_cutout_overview');

export const listHeroCutouts = (filter: HeroFilter, search: string, limit = HERO_PAGE_SIZE, offset = 0) =>
  rpc<{ total: number; rows: HeroRow[] }>('list_hero_cutouts', {
    p_filter: filter, p_search: search.trim() || null, p_limit: limit, p_offset: offset,
  });

export const reviewHeroCutout = (row: Pick<HeroRow, 'source_url' | 'status'>, action: 'approve' | 'reject', note?: string) =>
  rpc<{ ok: true; status: HeroStatus; old_status: HeroStatus }>('review_hero_cutout', {
    p_source_url: row.source_url, p_action: action, p_expected_status: row.status, p_note: note?.trim() || null,
  });

export const setHeroMode = (mode: HeroMode, expected: HeroMode) =>
  rpc<{ ok: true; changed: boolean; mode: HeroMode }>('set_hero_cutout_mode', { p_mode: mode, p_expected_mode: expected });

/** What an admin may do to a row — the same rules review_hero_cutout enforces. */
export function heroActions(row: Pick<HeroRow, 'status' | 'qa_status'>): { approve: boolean; reject: boolean } {
  return {
    approve: row.qa_status !== 'failed' && row.status !== 'approved',
    reject: row.status !== 'rejected',
  };
}

export const heroCutoutUrl = (row: Pick<HeroRow, 'cutout_path'>) => publicUrl(row.cutout_path);

export function heroRefusalText(err: unknown): string {
  if (!(err instanceof RpcRefusal)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case 'admin_only': return 'Only an admin can approve, reject or change the go-live switch.';
    case 'permission_denied': return 'You need the "Manage website catalog" permission to see hero cut-outs.';
    case 'stale': return 'Someone changed this a moment ago. The list has been refreshed — check it and try again.';
    case 'nothing_to_approve': return 'This one failed — there is no cut-out to approve.';
    case 'already': return 'It is already in that state.';
    case 'not_found': return 'This cut-out no longer exists.';
    default: return `Refused: ${err.code}`;
  }
}
