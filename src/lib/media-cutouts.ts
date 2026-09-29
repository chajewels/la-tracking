import { supabase } from '@/integrations/supabase/client';
import { callUntypedRpc } from '@/lib/untyped-rpc';
import { errorMessage } from '@/lib/error-message';
import { type HeroPhotoSource, type HeroTabTotals, readHeroPhotoSource } from '@/lib/hero-picks';
import {
  COVERAGE_MIN, describeFlag, PUBLISHABLE_STATUSES, type CutoutStatus as QaStatus,
} from '../../supabase/functions/_shared/cutout-qa.ts';
import { BUCKET, type CutoutMode } from '../../supabase/functions/_shared/media-cutout-rules.ts';
import {
  DEFAULT_PRICE_USD, estimateCost, type ProviderName, readPriceSetting, readProviderSetting,
} from '../../supabase/functions/_shared/cutout-provider.ts';

/**
 * Website → Photos (automatic background removal, docs/MEDIA-CUTOUTS.md).
 * Every call is an RPC from migration 20261006100000_media_cutouts — not in
 * types.ts until Lovable regenerates it, so always through callUntypedRpc
 * (never a detached supabase.rpc). All of them check manage_website_catalog.
 */

export { DEFAULT_PRICE_USD, describeFlag, estimateCost, PUBLISHABLE_STATUSES };
export type { CutoutMode, ProviderName };

/**
 * The verdicts the Hub can see: the worker's (cutout-qa.ts) plus
 * 'kept_original' — "Keep original" (migration 20261011100000): Completed,
 * uncut, the website shows the normal photo. Never one of PUBLISHABLE_STATUSES.
 */
export type CutoutStatus = QaStatus | 'kept_original';

/** Who removes the backgrounds (migration 20261007100000_media_cutout_photoroom). */
export interface CutoutProviderSetting {
  found: boolean;
  provider: ProviderName;
  /** US$ per photo for the estimate; null = unknown (Replicate). */
  price_usd: number | null;
  updated_at: string | null;
  updated_by_name: string | null;
}

export const PROVIDER_LABEL: Record<ProviderName, string> = {
  photoroom: 'Photoroom',
  fal: 'fal.ai (BiRefNet)',
  replicate: 'Replicate (BiRefNet)',
};

export const PROVIDER_TEXT: Record<ProviderName, string> = {
  photoroom: 'Photoroom Remove Background API — edge secret PHOTOROOM_API_KEY.',
  fal: 'fal.ai BiRefNet v2 — edge secret FAL_KEY. Used on the first test; it erased parts of two watch dials.',
  replicate: 'Replicate BiRefNet — edge secrets REPLICATE_API_TOKEN and REPLICATE_BIREFNET_VERSION.',
};

export interface CutoutOverview {
  found: boolean;
  mode: CutoutMode;
  cap: number;
  month: string;
  used: number;
  bell_80_at: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  can_change: boolean;
  last_tick_at: string | null;
  last_tick: Record<string, unknown> | null;
  status_counts: Partial<Record<CutoutStatus, number>>;
  state_counts: Record<string, number>;
  test_batches: { name: string; count: number; done: number }[];
  cpu_ms_p95: number | null;
  cpu_ms_max: number | null;
  cpu_fallbacks: number;
}

export interface CutoutRow {
  id: string;
  source_url: string;
  source_kind: 'page365' | 'staff';
  priority: number;
  test_batch: string | null;
  /** 'waiting' = Waiting for publish: its product is not published, so it is never sent (20261011100000). */
  job_state: 'queued' | 'waiting' | 'submitted' | 'ready' | 'processing' | 'done' | 'error';
  status: CutoutStatus;
  flags: string[];
  rerun: boolean;
  own_cutout_url: string | null;
  provider: string | null;
  model: string | null;
  attempts: number;
  last_error: string | null;
  source_w: number | null;
  source_h: number | null;
  output_kind: 'baked' | 'cutout_only' | null;
  cutout_path: string | null;
  catalog_path: string | null;
  catalog_small_path: string | null;
  hero_usable: boolean | null;
  timings: Record<string, number> | null;
  last_rerun: (Record<string, unknown> & { status?: string; flags?: string[]; cutout_path?: string; catalog_path?: string }) | null;
  review_note: string | null;
  reviewed_at: string | null;
  finished_at: string | null;
  updated_at: string;
  product: { id: string; sku: string; name: string; slug: string; status: string } | null;
  product_count: number;
  /** Publish gate (migration 20261011100000): any product using this photo is published. Absent until it has run. */
  published?: boolean;
  /**
   * What its last error was (migration 20261012100000, media_cutout_error_kind):
   * only 'photo' can make a photo Failed; the others are the provider's or the
   * account's problem and send the photo back by itself. Absent until it has run.
   */
  error_kind?: CutoutErrorKind;
  /** Cut once (migration 20261010100000). Absent until it has run. */
  paid_calls?: number;
  paid_call_limit?: number;
  recut_allowed?: boolean;
  /** Set = "Needs owner": stopped at the paid-call limit; the reason in plain words. */
  hold_reason?: string | null;
  held_at?: string | null;
  /** Hero picks (migration 20261013100000): ticked "Use on hero". Absent until it has run — the tick is then not shown. */
  hero_pick?: boolean;
  /** Why it cannot be on the hero (hero_pick_reason); null = it can. */
  hero_pick_blocker?: string | null;
}

export type CutoutErrorKind = 'account' | 'provider' | 'result_expired' | 'photo';

/** Why a photo came back by itself (not its own fault), in plain words. */
export const RETURNED_REASON: Record<Exclude<CutoutErrorKind, 'photo'>, string> = {
  account: 'the provider refused the request (no credits left, rate limit, or the key) — no paid call was used',
  provider: 'the provider had an outage',
  result_expired: 'the provider no longer had the result (it keeps results only a short time)',
};

/** Every tab's photos and the paid calls they cost (get_media_cutout_tab_totals). */
export interface CutoutTabTotals {
  /** completed also carries kept_original (how many of them were kept uncut);
   *  hero (20261013100000) carries usable / products_on_hero / published_left_out. */
  tabs: Record<string, { count: number; paid_calls: number; kept_original?: number } & Partial<HeroTabTotals>>;
  is_admin: boolean;
  per_photo_limit: number;
  provider: ProviderName;
  price_usd: number | null;
  /** The hero switch (20261013100000); null before it has run. */
  hero_photo_source: HeroPhotoSource | null;
}

/** React Query keys (the dev fixture seeds the same ones). The list key is
 *  [CUTOUT_LIST_KEY, filter, search, page]. */
export const CUTOUT_OVERVIEW_KEY = ['media-cutouts-overview'] as const;
export const CUTOUT_LIST_KEY = 'media-cutouts-list';
export const CUTOUT_PAGE_SIZE = 20;
export const CUTOUT_TABS_KEY = ['media-cutouts-tabs'] as const;

export const FILTERS = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'needs_owner', label: 'Needs owner' },
  { value: 'failed', label: 'Failed' },
  { value: 'auto_fixed', label: 'Auto-fixed' },
  { value: 'queue', label: 'In the queue' },
  { value: 'completed', label: 'Completed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'test', label: 'Test batch' },
  { value: 'all', label: 'All' },
  // Shown only once migration 20261013100000 has run (the totals then carry it).
  { value: 'hero', label: 'Hero' },
] as const;
export type CutoutFilter = (typeof FILTERS)[number]['value'];

/**
 * The two ADMIN actions that spend money on a photo the rules have closed:
 * each allows exactly ONE more paid call and is audited with the estimated
 * cost (review_media_cutout). There is no reopen for a Completed photo:
 * "Unlock and re-cut" was removed (owner rule 2026-09-28, migration
 * 20261011100000 — Completed is final; the database refuses it).
 */
export type PaidReopenAction = 'retry_once' | 'override_cap';
export type ReviewAction =
  | 'approve' | 'reject' | 'rerun' | 'rerun_high_detail' | 'use_rerun' | 'own_cutout' | 'keep_original' | PaidReopenAction;

/**
 * COMPLETED IS FINAL: passed, approved or kept original — never sent again,
 * by anyone. Rejected is locked too, but an admin can try it once more.
 */
export const isCompleted = (s: CutoutStatus) => s === 'ok' || s === 'auto_fixed' || s === 'approved' || s === 'kept_original';
export const isLocked = (s: CutoutStatus) => isCompleted(s) || s === 'rejected';

/**
 * The checks say almost nothing of the piece was kept: the cut-out's coverage
 * is under the minimum, or it kept under half of what the photo shows. Keep
 * original is then the main button.
 */
export function almostNothingKept(flags: readonly string[]): boolean {
  return flags.some(f => {
    const [kind, value] = f.split(':');
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    return (kind === 'coverage' && n < COVERAGE_MIN) || (kind === 'detail_loss' && n < 0.5);
  });
}
/** At (or over) its paid-call limit, or stopped there: only an admin can allow another call. */
export const isCapped = (r: Pick<CutoutRow, 'paid_calls' | 'paid_call_limit' | 'hold_reason'>) =>
  !!r.hold_reason || (r.paid_calls ?? 0) >= (r.paid_call_limit ?? 2);

/**
 * What a row's state allows, read once so the row and the zoom viewer offer
 * exactly the same buttons (CutoutActionButtons). CUT ONCE (20261010100000) +
 * PUBLISH GATE (20261011100000): Completed (incl. Kept original) is final for
 * everyone; Rejected is locked (an admin can try once more); a photo at its
 * paid-call limit needs the owner; a photo of an unpublished product waits.
 * The database enforces all of it.
 */
export function cutoutRowState(row: CutoutRow) {
  const inFlight = ['submitted', 'ready', 'processing'].includes(row.job_state);
  const completed = isCompleted(row.status);
  return {
    inFlight,
    completed,
    kept: row.status === 'kept_original',
    rejected: row.status === 'rejected',
    waiting: row.job_state === 'waiting',
    keepFirst: !completed && !inFlight && almostNothingKept(row.flags),
    held: !!row.hold_reason,
    capped: isCapped(row),
  };
}

export const STATUS_LABEL: Record<CutoutStatus, string> = {
  pending: 'Waiting',
  ok: 'OK',
  auto_fixed: 'Auto-fixed',
  needs_review: 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed',
  kept_original: 'Kept original',
};

export const MODE_TEXT: Record<CutoutMode, string> = {
  off: 'Off — nothing is sent. New photos wait in the queue.',
  test: 'Test — only photos in a test batch are processed.',
  on: 'On — every queued photo of a published product is processed, main photos first. Photos of unpublished products wait (not shown) until the product is published.',
};

class RpcRefusal extends Error {
  constructor(readonly code: string, readonly detail?: Record<string, unknown>) { super(code); }
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const out = await callUntypedRpc<Record<string, unknown> | null>(fn, args);
  if (out && typeof out === 'object' && typeof out.error === 'string') throw new RpcRefusal(out.error, out);
  return (out ?? {}) as T;
}

export const getOverview = () => rpc<CutoutOverview>('get_media_cutout_overview');

export async function getTabTotals(): Promise<CutoutTabTotals> {
  const raw = await rpc<Record<string, unknown>>('get_media_cutout_tab_totals');
  const provider = readProviderSetting(raw.provider);
  return {
    tabs: (raw.tabs ?? {}) as CutoutTabTotals['tabs'],
    is_admin: raw.is_admin === true,
    per_photo_limit: typeof raw.per_photo_limit === 'number' ? raw.per_photo_limit : 2,
    provider,
    price_usd: readPriceSetting(raw.price_usd, provider),
    hero_photo_source: readHeroPhotoSource(raw.hero_photo_source),
  };
}

export const listCutouts = (filter: CutoutFilter, search: string, limit = 20, offset = 0) =>
  rpc<{ total: number; rows: CutoutRow[] }>('list_media_cutouts', {
    p_filter: filter, p_search: search.trim() || null, p_limit: limit, p_offset: offset,
  });

export const CUTOUT_PROVIDER_KEY = ['media-cutouts-provider'] as const;

export async function getProvider(): Promise<CutoutProviderSetting> {
  const raw = await rpc<Record<string, unknown>>('get_media_cutout_provider');
  const provider = readProviderSetting(raw.provider);
  return {
    found: raw.found === true,
    provider,
    price_usd: readPriceSetting(raw.price_usd, provider),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    updated_by_name: typeof raw.updated_by_name === 'string' ? raw.updated_by_name : null,
  };
}

export const setProvider = (provider: ProviderName | null, priceUsd: number | null, expected: ProviderName | null) =>
  rpc<{ ok: boolean; changed: boolean; provider: ProviderName; price_usd: string | null }>('set_media_cutout_provider', {
    p_provider: provider, p_price_usd: priceUsd, p_expected_provider: expected,
  });

/** "$0.72" — or "unknown" when there is no price. */
export function formatUsd(v: number | null): string {
  return v == null ? 'unknown' : `$${v.toFixed(2)}`;
}

export const setSettings = (mode: CutoutMode | null, cap: number | null, expectedMode: CutoutMode | null) =>
  rpc<{ ok: boolean; changed: boolean; mode: CutoutMode; cap: number }>('set_media_cutout_settings', {
    p_mode: mode, p_cap: cap, p_expected_mode: expectedMode,
  });

export const review = (sourceUrl: string, action: ReviewAction, opts: { note?: string; ownUrl?: string; expected?: CutoutStatus } = {}) =>
  rpc<{ ok: boolean; status: CutoutStatus; job_state?: CutoutRow['job_state']; waiting_for_publish?: boolean }>('review_media_cutout', {
    p_source_url: sourceUrl, p_action: action, p_note: opts.note?.trim() || null,
    p_own_cutout_url: opts.ownUrl ?? null, p_expected_status: opts.expected ?? null,
  });

export const addTestBatch = (skus: string[], batch: string, mainOnly: boolean) =>
  rpc<{ ok: boolean; batch: string; photos: number; queued_new: number; tagged: number; unknown_skus: string[] }>(
    'add_media_cutout_test_batch', { p_skus: skus, p_batch: batch, p_main_only: mainOnly });

/** "Run now": one worker tick, as the signed-in user (manage_website_catalog). */
export async function runNow(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('media-cutout-worker', { body: { action: 'tick' } });
  if (error) throw error;
  return (data ?? {}) as Record<string, unknown>;
}

/** Split pasted SKUs on commas, spaces and new lines. */
export function parseSkus(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)));
}

export function publicUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * Staff's own cut-out: a PNG or WebP that really has transparency. Checked in
 * the browser before upload (the worker checks again).
 */
export async function hasTransparency(file: File): Promise<boolean> {
  if (!/^image\/(png|webp)$/.test(file.type)) return false;
  const bitmap = await createImageBitmap(file);
  const w = Math.min(256, bitmap.width), h = Math.max(1, Math.round(bitmap.height * (w / bitmap.width)));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) clear++;
  return clear / (w * h) > 0.03;
}

export async function uploadOwnCutout(file: File): Promise<string> {
  const ext = file.type === 'image/webp' ? 'webp' : 'png';
  const path = `website/derived/own/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw error;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** A refusal code in plain words; any other error keeps its own message. */
export function refusalText(err: unknown): string {
  if (!(err instanceof RpcRefusal)) return errorMessage(err);
  switch (err.code) {
    case 'permission_denied': return 'You need the "Manage website catalog" permission for this.';
    case 'stale': return 'Someone changed this a moment ago. The list has been refreshed — check it and try again.';
    case 'busy': return 'This photo is being processed right now. Try again in a few minutes.';
    case 'no_cutout': return 'There is no cut-out to approve yet. Re-run it or upload your own.';
    case 'no_rerun': return 'There is no re-run result to use.';
    case 'invalid_own_cutout_url': return 'The uploaded cut-out could not be used. Upload a PNG or WebP again.';
    case 'invalid_mode': return 'That setting is not one of Off / Test / On.';
    case 'invalid_provider': return 'That provider is not one of Photoroom / fal.ai / Replicate.';
    case 'invalid_price': return 'The price per photo must be between $0 and $10.';
    case 'invalid_cap': return 'The monthly limit must be a whole number from 0 to 100,000.';
    case 'batch_name_required': return 'Give the test batch a name (up to 60 characters).';
    case 'skus_required_max_100': return 'Paste between 1 and 100 SKUs.';
    case 'setting_missing': return 'Background removal is not set up yet — the migration has not been run.';
    case 'locked': return 'This photo is finished and is not sent again. A rejected photo can be tried once more by an admin.';
    case 'completed_is_final': return 'This photo is completed. Completed is final: it is never sent again.';
    case 'already_completed': return 'This photo is already completed — there is nothing to keep.';
    case 'needs_owner': return 'This photo stopped at its paid-call limit. Only an admin can allow another call.';
    case 'paid_call_cap': return 'This photo has used all its paid calls. Only an admin can allow another call.';
    case 'admin_only': return 'Only an admin can spend another paid call on this photo.';
    case 'not_rejected': return 'Try once more is for rejected photos only.';
    case 'not_capped': return 'This photo has not reached its paid-call limit.';
    default: return `Could not save: ${err.code}`;
  }
}

/** A status the website may show (PR 2 sends only these to the storefront). */
export const isPublishable = (s: CutoutStatus) => (PUBLISHABLE_STATUSES as readonly string[]).includes(s);
