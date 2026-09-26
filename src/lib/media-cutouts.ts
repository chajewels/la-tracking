import { supabase } from '@/integrations/supabase/client';
import { callUntypedRpc } from '@/lib/untyped-rpc';
import { describeFlag, PUBLISHABLE_STATUSES, type CutoutStatus } from '../../supabase/functions/_shared/cutout-qa.ts';
import { BUCKET, type CutoutMode } from '../../supabase/functions/_shared/media-cutout-rules.ts';

/**
 * Website → Photos (automatic background removal, docs/MEDIA-CUTOUTS.md).
 * Every call is an RPC from migration 20261005100000_media_cutouts — not in
 * types.ts until Lovable regenerates it, so always through callUntypedRpc
 * (never a detached supabase.rpc). All of them check manage_website_catalog.
 */

export { describeFlag, PUBLISHABLE_STATUSES };
export type { CutoutMode, CutoutStatus };

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
  job_state: 'queued' | 'submitted' | 'ready' | 'processing' | 'done' | 'error';
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
}

/** React Query keys (the dev fixture seeds the same ones). The list key is
 *  [CUTOUT_LIST_KEY, filter, search, page]. */
export const CUTOUT_OVERVIEW_KEY = ['media-cutouts-overview'] as const;
export const CUTOUT_LIST_KEY = 'media-cutouts-list';
export const CUTOUT_PAGE_SIZE = 20;

export const FILTERS = [
  { value: 'needs_review', label: 'Needs review' },
  { value: 'failed', label: 'Failed' },
  { value: 'auto_fixed', label: 'Auto-fixed' },
  { value: 'queue', label: 'In the queue' },
  { value: 'published', label: 'Published' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'test', label: 'Test batch' },
  { value: 'all', label: 'All' },
] as const;
export type CutoutFilter = (typeof FILTERS)[number]['value'];

export type ReviewAction = 'approve' | 'reject' | 'rerun' | 'rerun_high_detail' | 'use_rerun' | 'own_cutout';

export const STATUS_LABEL: Record<CutoutStatus, string> = {
  pending: 'Waiting',
  ok: 'OK',
  auto_fixed: 'Auto-fixed',
  needs_review: 'Needs review',
  approved: 'Approved',
  rejected: 'Rejected',
  failed: 'Failed',
};

export const MODE_TEXT: Record<CutoutMode, string> = {
  off: 'Off — nothing is sent. New photos wait in the queue.',
  test: 'Test — only photos in a test batch are processed.',
  on: 'On — every queued photo is processed, main photos of live products first.',
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

export const listCutouts = (filter: CutoutFilter, search: string, limit = 20, offset = 0) =>
  rpc<{ total: number; rows: CutoutRow[] }>('list_media_cutouts', {
    p_filter: filter, p_search: search.trim() || null, p_limit: limit, p_offset: offset,
  });

export const setSettings = (mode: CutoutMode | null, cap: number | null, expectedMode: CutoutMode | null) =>
  rpc<{ ok: boolean; changed: boolean; mode: CutoutMode; cap: number }>('set_media_cutout_settings', {
    p_mode: mode, p_cap: cap, p_expected_mode: expectedMode,
  });

export const review = (sourceUrl: string, action: ReviewAction, opts: { note?: string; ownUrl?: string; expected?: CutoutStatus } = {}) =>
  rpc<{ ok: boolean; status: CutoutStatus }>('review_media_cutout', {
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
  if (!(err instanceof RpcRefusal)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case 'permission_denied': return 'You need the "Manage website catalog" permission for this.';
    case 'stale': return 'Someone changed this a moment ago. The list has been refreshed — check it and try again.';
    case 'busy': return 'This photo is being processed right now. Try again in a few minutes.';
    case 'no_cutout': return 'There is no cut-out to approve yet. Re-run it or upload your own.';
    case 'no_rerun': return 'There is no re-run result to use.';
    case 'invalid_own_cutout_url': return 'The uploaded cut-out could not be used. Upload a PNG or WebP again.';
    case 'invalid_mode': return 'That setting is not one of Off / Test / On.';
    case 'invalid_cap': return 'The monthly limit must be a whole number from 0 to 100,000.';
    case 'batch_name_required': return 'Give the test batch a name (up to 60 characters).';
    case 'skus_required_max_100': return 'Paste between 1 and 100 SKUs.';
    case 'setting_missing': return 'Background removal is not set up yet — the migration has not been run.';
    default: return `Could not save: ${err.code}`;
  }
}

/** A status the website may show (PR 2 sends only these to the storefront). */
export const isPublishable = (s: CutoutStatus) => (PUBLISHABLE_STATUSES as readonly string[]).includes(s);
