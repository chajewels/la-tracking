import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  CUTOUT_LIST_KEY, CUTOUT_OVERVIEW_KEY, CUTOUT_PROVIDER_KEY, CUTOUT_TABS_KEY, type CutoutOverview, type CutoutProviderSetting,
  type CutoutRow, type CutoutTabTotals,
} from '@/lib/media-cutouts';
import { storefrontPreview } from '@/theme/tokens';
import { HERO_LINEUP_KEY, type HeroLineup, type HeroLineupPiece } from '@/lib/hero-picks';

/**
 * Seed for /__fixtures/?view=media-cutouts[&mode=off|test|on][&role=staff][&source=product_ticks] — Website → Photos
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

// Hero picks (20261013100000): the same rule as hero_pick_reason, for the fixture's rows only.
function heroBlocker(r: Pick<CutoutRow, 'status' | 'cutout_path' | 'published'>): string | null {
  if (r.status === 'kept_original') return 'kept_original';
  if (r.status === 'rejected') return 'rejected';
  if (!['ok', 'auto_fixed', 'approved'].includes(r.status)) return 'not_completed';
  if (!r.cutout_path) return 'no_cutout_file';
  if (r.published === false) return 'not_published';
  return null;
}

// The carry-over preview (hero_picks_carry_over) answers from here in the fixture; every other RPC is untouched.
function stubHeroRpc() {
  const c = supabase as unknown as { rpc: (fn: string, args?: Record<string, unknown>) => unknown; __heroStub?: boolean };
  if (c.__heroStub) return;
  const original = c.rpc.bind(c);
  c.rpc = (fn: string, args?: Record<string, unknown>) => {
    if (fn !== 'hero_picks_carry_over' || args?.p_apply) return original(fn, args);
    return Promise.resolve({ error: null, data: {
      ok: true, applied: false, approved_hero: 58, already_ticked: 3, to_tick: 44,
      left_out: { kept_original: 2, not_completed: 5, not_published: 4 },
      products_now: { published_in_stock: 303, products_on_hero: 2, published_left_out: 301 },
      products_after: { published_in_stock: 303, products_on_hero: 41, published_left_out: 262 },
    } });
  };
  c.__heroStub = true;
}

const row = (over: Partial<CutoutRow>): CutoutRow => withHero({
  id: 'x', source_url: BASE + 'page365/1/1-1.jpg', source_kind: 'page365', priority: 0, test_batch: 'Test 30',
  job_state: 'done', status: 'ok', flags: [], rerun: false, own_cutout_url: null, provider: 'photoroom',
  model: 'photoroom/v1/segment', attempts: 0, last_error: null, source_w: 1512, source_h: 1512, output_kind: 'baked',
  cutout_path: 'website/derived/aa/r1/cutout.webp', catalog_path: 'website/derived/aa/r1/catalog.webp',
  catalog_small_path: 'website/derived/aa/r1/catalog-small.webp', hero_usable: true, timings: { total: 480 },
  last_rerun: null, review_note: null, reviewed_at: null, finished_at: '2026-10-05T03:14:00Z',
  updated_at: '2026-10-05T03:14:00Z', product: null, product_count: 1, published: true,
  paid_calls: 1, paid_call_limit: 2, recut_allowed: false, hold_reason: null, held_at: null, hero_pick: false, ...over,
});
const withHero = (r: CutoutRow): CutoutRow => ({ ...r, hero_pick_blocker: r.hero_pick_blocker !== undefined ? r.hero_pick_blocker : heroBlocker(r) });

export function seedMediaCutouts(qc: QueryClient, mode: string, role: string | null = null, source: string | null = null) {
  stubPromotions();
  stubHeroRpc();
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
  const provider: CutoutProviderSetting = {
    found: true, provider: 'photoroom', price_usd: 0.02, updated_at: '2026-10-07T01:00:00Z', updated_by_name: 'Cynthia Largo',
  };
  seed(CUTOUT_PROVIDER_KEY, provider);
  // Cut once (20261010100000): the 2026-09-28 shape — Replicate at $0.005.
  const tabs: CutoutTabTotals = {
    is_admin: role !== 'staff', per_photo_limit: 2, provider: 'replicate', price_usd: 0.005,
    hero_photo_source: source === 'product_ticks' ? 'product_ticks' : 'hero_record',
    tabs: {
      // Provider errors (20261012100000), the live-shaped snapshot after the SQL: published products only;
      // Failed = genuine photo problems. 'waiting' is counted for SQL use; the card does not show it.
      needs_review: { count: 15, paid_calls: 15 }, needs_owner: { count: 2, paid_calls: 4 },
      failed: { count: 2, paid_calls: 2 }, auto_fixed: { count: 10, paid_calls: 10 },
      queue: { count: 64, paid_calls: 8 }, waiting: { count: 801, paid_calls: 4 },
      completed: { count: 111, paid_calls: 110, kept_original: 1 },
      rejected: { count: 5, paid_calls: 5 }, test: { count: 6, paid_calls: 6 }, all: { count: 209, paid_calls: 154 },
      // Hero picks (20261013100000): three ticks, one no longer usable (its product was unpublished).
      // Hero order (20261016100000): the slides — 4 on, 2 waiting their turn.
      hero: { count: 8, paid_calls: 8, usable: 7, products_on_hero: 4, hero_waiting: 2, published_left_out: 299, published_in_stock: 303 },
    },
  };
  seed(CUTOUT_TABS_KEY, tabs);
  // Hero order (20261016100000): get_hero_lineup, the running order per category.
  const lp = (sku: string, name: string, place: number | null, state: HeroLineupPiece['state'],
              reason: HeroLineupPiece['reason'], mins: number): HeroLineupPiece => ({
    product_id: sku, sku, name, slug: sku.toLowerCase(), place, state, reason,
    first_picked_at: new Date(Date.UTC(2026, 8, 29, 1, mins)).toISOString(),
    photo: { source_url: BASE + `page365/${sku}.jpg`, thumb_path: `website/derived/${sku.toLowerCase()}/r1/catalog-small.webp` },
  });
  const lineup: HeroLineup = {
    hero_photo_source: source === 'product_ticks' ? 'product_ticks' : 'hero_record', slide_limit: 3,
    categories: [
      { id: 'c1', slug: 'preloved-jewelry', name: 'Preloved Jewelry',
        on_hero: [lp('R7828', 'Preloved 18K Diamond Eternity Ring', 1, 'on_hero', null, 2),
                  lp('E1053', 'Preloved Pt900 Diamond Stud Earrings', 2, 'on_hero', null, 5),
                  lp('N2210', 'Preloved K18 Ruby Pendant Necklace', 3, 'on_hero', null, 9)],
        waiting: [lp('R8001', 'Preloved K18YG Sapphire Ring', 4, 'waiting', null, 14),
                  lp('B3302', 'Preloved K18 Tennis Bracelet', 5, 'waiting', null, 20)],
        not_showing: [lp('R7011', 'Preloved Pt950 Solitaire Ring', null, 'not_showing', 'sold', 1)] },
      { id: 'c2', slug: 'preloved-watches', name: 'Preloved Watches',
        on_hero: [lp('W2527', 'Preloved Rolex Datejust 36', 1, 'on_hero', null, 30)], waiting: [], not_showing: [] },
      { id: 'c3', slug: 'preloved-designer-accessories', name: 'Preloved Designer Accessories',
        on_hero: [], waiting: [], not_showing: [lp('AL1234', 'Preloved Designer Wallet', null, 'not_showing', 'not_published', 12)] },
    ],
    no_category: [],
  };
  seed(HERO_LINEUP_KEY, lineup);
  const n = (sku: string, name: string) => ({ id: sku, sku, name, slug: sku.toLowerCase(), status: 'active' });
  seed([CUTOUT_LIST_KEY, 'completed', '', 0], {
    total: 3,
    rows: [
      row({ source_url: drawn('original', false, false) + '#B1203', status: 'kept_original', provider: 'photoroom', hero_usable: false,
            flags: ['coverage:0.012'], review_note: 'The photo is fine as it is', reviewed_at: '2026-09-28T05:00:00Z',
            product: n('B1203', 'K18 Snake Chain Bracelet') }),
      row({ source_url: drawn('original', false, false), status: 'approved', provider: 'replicate', reviewed_at: '2026-09-28T02:00:00Z',
            hero_pick: true, product: n('R7828', 'Preloved 18K Diamond Eternity Ring') }),
      row({ source_url: drawn('original', true, false), status: 'ok', provider: 'replicate', paid_calls: 2, priority: 1,
            product: n('R3341', 'Preloved Platinum Baguette Cocktail Ring') }),
    ],
  });
  seed([CUTOUT_LIST_KEY, 'hero', '', 0], {
    total: 3,
    rows: [
      row({ source_url: drawn('original', false, false), status: 'approved', provider: 'replicate', hero_pick: true,
            product: n('R7828', 'Preloved 18K Diamond Eternity Ring') }),
      row({ source_url: drawn('original', true, false) + '#AL1234', status: 'ok', provider: 'replicate', hero_pick: true, priority: 1,
            product: n('AL1234', 'Diamond eternity ring PT900') }),
      row({ source_url: drawn('original', false, false) + '#E1053', status: 'auto_fixed', provider: 'replicate', hero_pick: true,
            published: false, product: { ...n('E1053', 'Hoop earrings K18'), status: 'draft' } }),
    ],
  });
  seed([CUTOUT_LIST_KEY, 'rejected', '', 0], {
    total: 1,
    rows: [row({ source_url: drawn('original', true, false), status: 'rejected', flags: ['extra_objects:1'],
                 review_note: 'The chain was cut through', product: n('N2734', 'K18 Fine Venetian Chain 40cm') })],
  });
  seed([CUTOUT_LIST_KEY, 'needs_owner', '', 0], {
    total: 1,
    rows: [row({ source_url: drawn('original', false, true), status: 'failed', job_state: 'error', paid_calls: 2,
                 cutout_path: null, catalog_path: null, catalog_small_path: null, flags: ['api_error:HTTP 502'],
                 hold_reason: 'Stopped after 2 paid calls (the limit for this photo is 2). Last error: replicate submit: HTTP 502',
                 held_at: '2026-09-28T03:10:00Z', product: n('C1395', 'Casio G-SHOCK Full Metal Series Solar') })],
  });
  seed([CUTOUT_LIST_KEY, 'needs_review', '', 0], {
    total: 4,
    rows: [
      row({ source_url: drawn('original', false, false) + '#N3380', status: 'needs_review', flags: ['coverage:0.012'], paid_calls: 1,
            product: { id: 'p6', sku: 'N3380', name: 'K18 Petite Chain Necklace 40cm', slug: 'n3380', status: 'active' } }),
      row({ source_url: drawn('original', false, true), status: 'needs_review',
            flags: ['edge_touch:bottom,left,right', 'interior_hole:0.054', 'uncertain:0.52'], source_w: 1440, source_h: 1440,
            product: { id: 'p5', sku: 'C1395', name: 'Casio G-SHOCK Full Metal Series Solar', slug: 'c1395', status: 'active' } }),
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
  // Provider errors (20261012100000): photos the provider refused go back by themselves.
  seed([CUTOUT_LIST_KEY, 'queue', '', 0], {
    total: 2,
    rows: [
      row({ source_url: drawn('original', false, false) + '#R4410', status: 'pending', job_state: 'queued', paid_calls: 0,
            cutout_path: null, catalog_path: null, catalog_small_path: null, finished_at: null, test_batch: null,
            error_kind: 'account', provider: null,
            last_error: 'photoroom: HTTP 402 {"detail":"You have exhausted the number of images in your plan"}',
            product: n('R4410', 'Preloved Pt900 Solitaire Ring') }),
      row({ source_url: drawn('original', true, false) + '#E2201', status: 'pending', job_state: 'queued', paid_calls: 1,
            priority: 1, cutout_path: null, catalog_path: null, catalog_small_path: null, finished_at: null, test_batch: null,
            error_kind: 'result_expired', provider: 'replicate', last_error: 'download 404',
            product: n('E2201', 'K18 Diamond Stud Earrings') }),
    ],
  });
  seed([CUTOUT_LIST_KEY, 'failed', '', 0], {
    total: 1,
    rows: [row({ source_url: drawn('original', false, false), status: 'failed', job_state: 'error',
                 flags: ['api_error:decode failed unsupported JPEG'], error_kind: 'photo',
                 cutout_path: null, catalog_path: null, catalog_small_path: null, attempts: 4,
                 last_error: 'decode failed: unsupported JPEG (progressive, 12-bit)',
                 product: { id: 'p4', sku: 'N1055', name: 'K18 Venetian Chain Necklace 45cm', slug: 'n1055', status: 'active' } })],
  });
}
