import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  CUTOUT_LIST_KEY, CUTOUT_OVERVIEW_KEY, type CutoutOverview, type CutoutRow,
} from '@/lib/media-cutouts';
import { storefrontPreview } from '@/theme/tokens';

/**
 * Seed for /__fixtures/?view=media-cutouts[&mode=off|test|on] — Website → Photos
 * (MediaCutoutsFixture.tsx) with seeded data (docs/MEDIA-CUTOUTS.md). No binary images in the repo: the
 * promotions bucket's public URLs are stubbed with drawn stand-ins (a gold
 * ring; an inset square where the photo had a second object).
 */

const BASE = 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/';

function drawn(kind: 'original' | 'cutout' | 'catalog', inset: boolean, cropped: boolean): string {
  const bg = kind === 'original' ? '#FFFFFF' : kind === 'catalog' ? storefrontPreview.chalk : 'none';
  const ring = cropped
    ? '<rect x="70" y="-10" width="60" height="220" rx="10" fill="#B8B8B8" stroke="#8A8A8A" stroke-width="4"/><circle cx="100" cy="100" r="42" fill="#EEE" stroke="#C9A227" stroke-width="8"/>'
    : '<ellipse cx="100" cy="112" rx="58" ry="46" fill="none" stroke="#C9A227" stroke-width="14"/><circle cx="100" cy="62" r="14" fill="#E8F4FF" stroke="#C9A227" stroke-width="5"/>';
  const extra = inset && kind === 'original'
    ? '<rect x="140" y="10" width="52" height="52" fill="#111"/><text x="146" y="30" font-size="11" fill="#fff">BACK</text>' : '';
  const shadow = kind === 'catalog' && !cropped ? '<ellipse cx="100" cy="160" rx="40" ry="5" fill="rgba(34,34,34,0.15)"/>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${bg}"/>${shadow}${ring}${extra}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function stubPromotions() {
  const s = supabase.storage as unknown as { from: (b: string) => Record<string, unknown>; __cutoutStub?: boolean };
  if (s.__cutoutStub) return;
  const original = s.from.bind(s);
  s.from = (bucket: string) => {
    const real = original(bucket);
    if (bucket !== 'promotions') return real;
    return {
      ...real,
      getPublicUrl: (path: string) => ({
        data: { publicUrl: drawn(path.includes('catalog') ? 'catalog' : 'cutout', false, path.includes('/c0983/')) },
      }),
    };
  };
  s.__cutoutStub = true;
}

const row = (over: Partial<CutoutRow>): CutoutRow => ({
  id: 'x', source_url: BASE + 'page365/1/1-1.jpg', source_kind: 'page365', priority: 0, test_batch: 'Test 30',
  job_state: 'done', status: 'ok', flags: [], rerun: false, own_cutout_url: null, provider: 'fal',
  model: 'fal-ai/birefnet/v2:heavy', attempts: 0, last_error: null, source_w: 1512, source_h: 1512, output_kind: 'baked',
  cutout_path: 'website/derived/aa/r1/cutout.webp', catalog_path: 'website/derived/aa/r1/catalog.webp',
  catalog_small_path: 'website/derived/aa/r1/catalog-small.webp', hero_usable: true, timings: { total: 480 },
  last_rerun: null, review_note: null, reviewed_at: null, finished_at: '2026-10-05T03:14:00Z',
  updated_at: '2026-10-05T03:14:00Z', product: null, product_count: 1, ...over,
});

export function seedMediaCutouts(qc: QueryClient, mode: string) {
  stubPromotions();
  const seed = (key: readonly unknown[], data: unknown) => {
    qc.setQueryDefaults(key as unknown[], { staleTime: Infinity, gcTime: Infinity, retry: false, refetchInterval: false });
    qc.setQueryData(key as unknown[], data);
  };
  const overview: CutoutOverview = {
    found: true, mode: mode === 'on' || mode === 'off' ? mode : 'test', cap: 600, month: '2026-10', used: 486,
    bell_80_at: '2026-10-05T02:00:00Z', updated_at: '2026-10-05T01:15:00Z', updated_by_name: 'Cynthia Largo',
    can_change: true, last_tick_at: '2026-10-05T03:15:00Z',
    last_tick: { mode: 'test', submitted: 6, ready: 5, errors: 0, processed: [] },
    status_counts: { needs_review: 2, failed: 1, auto_fixed: 1, ok: 21, approved: 3, pending: 2 },
    state_counts: { done: 28, queued: 2 }, test_batches: [{ name: 'Test 30', count: 30, done: 28 }],
    cpu_ms_p95: 812, cpu_ms_max: 1040, cpu_fallbacks: 0,
  };
  seed(CUTOUT_OVERVIEW_KEY, overview);
  seed([CUTOUT_LIST_KEY, 'needs_review', '', 0], {
    total: 2,
    rows: [
      row({ source_url: drawn('original', true, false), status: 'needs_review', flags: ['extra_objects:1'],
            product: { id: 'p1', sku: 'AL123', name: 'K18 Yellow Gold Diamond-Cut Heart Pendant', slug: 'al123', status: 'active' } }),
      row({ source_url: drawn('original', false, false), status: 'needs_review', flags: ['low_res:418x370'],
            source_w: 418, source_h: 370, hero_usable: false, priority: 1,
            product: { id: 'p2', sku: 'R3110', name: 'Branded 18K Rose Gold Open Heart Ring', slug: 'r3110', status: 'active' } }),
    ],
  });
  seed([CUTOUT_LIST_KEY, 'auto_fixed', '', 0], {
    total: 1,
    rows: [row({ source_url: drawn('original', false, true), status: 'auto_fixed', flags: ['edge_touch:top,bottom'],
                 cutout_path: 'website/derived/c0983/r1/cutout.webp', catalog_path: 'website/derived/c0983/r1/catalog.webp',
                 catalog_small_path: 'website/derived/c0983/r1/catalog-small.webp', source_w: 1440, source_h: 1440,
                 last_rerun: { status: 'needs_review', flags: ['soft_matte:0.12'], cutout_path: 'website/derived/c0983/r2/cutout.webp' },
                 product: { id: 'p3', sku: 'C0983', name: 'Van Cleef & Arpels La Collection Watch', slug: 'c0983', status: 'active' } })],
  });
  seed([CUTOUT_LIST_KEY, 'failed', '', 0], {
    total: 1,
    rows: [row({ source_url: drawn('original', false, false), status: 'failed', job_state: 'error', flags: ['api_error:HTTP 500 upstream'],
                 cutout_path: null, catalog_path: null, catalog_small_path: null, attempts: 4, last_error: 'fal submit: HTTP 500 upstream',
                 product: { id: 'p4', sku: 'N1055', name: 'K18 Venetian Chain Necklace 45cm', slug: 'n1055', status: 'active' } })],
  });
}
