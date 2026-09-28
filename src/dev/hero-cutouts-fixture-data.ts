import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  setHeroContextForFixture, setHeroTransportForFixture, type HeroMode, type HeroOverview, type HeroRow,
} from '@/lib/hero-cutouts';

/**
 * /__fixtures/?view=hero-cutouts[&role=staff] — Website → Photos → Hero
 * cut-outs (HeroCutoutsCard) against an IN-MEMORY stand-in for the four hero
 * RPCs (lib/hero-cutouts.ts setHeroTransportForFixture — supabase.rpc is not touched), so Approve / Reject / the go-live switch really change the screen,
 * with the admin-only rule applied as review_hero_cutout applies it
 * (`role=staff` = catalogue permission, not admin). Originals are the Hub's
 * public photos of the live pieces; the cut-out thumbnails are the
 * storefront's public comp cut-outs or a drawn stand-in. No binary in the repo,
 * no network write, nothing reaches Supabase.
 */

const HUB = 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/page365/';
/** Website photos outside page365/ (R3341's own uploads). */
const WEB = 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/';
const SITE = 'https://www.chajewelsjp.com/fixtures/cutouts/';
const HERO_RPCS = new Set(['get_hero_cutout_overview', 'list_hero_cutouts', 'review_hero_cutout', 'set_hero_cutout_mode']);

function drawn(label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="95" r="58" fill="#DDD" stroke="#C9A227" stroke-width="10"/><circle cx="118" cy="72" r="16" fill="#15120F"/><text x="100" y="185" font-size="13" text-anchor="middle" fill="#bbb">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const row = (over: Partial<HeroRow> & Pick<HeroRow, 'source_url' | 'status'>): HeroRow => ({
  id: over.source_url, source_sha256: '0'.repeat(64), source_width: 1440, source_height: 1440,
  qa_status: over.status === 'approved' || over.status === 'rejected' ? 'ok' : (over.status as HeroRow['qa_status']),
  flags: [], coverage: 0.4, cutout_path: `website/derived/hero/${'a'.repeat(32)}/${'b'.repeat(8)}/cutout.webp`,
  width: 700, height: 900, model: 'birefnet-general@epoch_244', auto_approved: false, reviewed_at: null,
  review_note: null, updated_at: '2026-09-28T03:00:00Z', product: null, ...over,
});
const product = (sku: string, name: string) => ({ id: sku, sku, name, slug: sku.toLowerCase(), status: 'active' });

/** Cut-out thumbnails by cutout_path (the Hub's publicUrl is stubbed to read this). */
const THUMB = new Map<string, string>();

function seedRows(): HeroRow[] {
  const rows: HeroRow[] = [
    row({ source_url: `${HUB}80288100/450588938-1758211797.jpeg`, status: 'auto_fixed', flags: ['edge_touch:top,bottom'], coverage: 0.5,
          product: product('C0853', 'Watch Bvlgari B-Zero1 Diamond Bezel Quartz SS Leather Silver [Used]') }),
    row({ source_url: `${HUB}82108479/489472301-1783753200.png`, status: 'ok', source_width: 1782, source_height: 1782,
          product: product('R0831', 'Ring Louis Vuitton 750WG 7.30g Empreinte #60 [Preloved]') }),
    row({ source_url: `${HUB}82378949/504517133-1787977458.jpeg`, status: 'auto_fixed', flags: ['edge_touch:left,right'], source_width: 1800, source_height: 2400,
          product: product('N2734', 'Necklace K18WG 9.70g Blue Topaz 3.89ct Diamond 0.17ct 40cm [Preloved]') }),
    // Three jewellery pieces with REAL BiRefNet cut-outs (the storefront's public
    // bundled set) on their real originals — for the zoom viewer.
    row({ source_url: `${WEB}0be8abc2-12d9-4c0e-b978-bf1a36fa2daf.jpeg`, status: 'ok', source_width: 2048, source_height: 2048,
          coverage: 0.31, width: 867, height: 900, product: product('R3341', 'Ring (fixture — name not recorded)') }),
    row({ source_url: `${HUB}78321785/428829493-1732601113.jpeg`, status: 'needs_review', flags: ['low_res:418x370'],
          source_width: 418, source_height: 370, width: 339, height: 204,
          product: product('R3110', 'Ring (fixture — name not recorded)') }),
    row({ source_url: `${HUB}79213257/437392479-1742360877.jpeg`, status: 'needs_review', flags: ['extra_objects:1'],
          source_width: 1280, source_height: 1280, width: 623, height: 773,
          product: product('AL123', 'Pendant (fixture — name not recorded)') }),
    row({ source_url: `${HUB}80288100/450588940-1758211797.jpeg`, status: 'needs_review', flags: ['edge_touch:bottom,left,right', 'interior_hole:0.0042'],
          product: product('C0853', 'Watch Bvlgari B-Zero1 Diamond Bezel Quartz SS Leather Silver [Used]') }),
    row({ source_url: `${HUB}80288064/450588849-1758211442.jpeg`, status: 'needs_review', flags: ['edge_touch:left', 'relative_coverage:0.14'], coverage: 0.06,
          product: product('W2527', 'Wallet Louis Vuitton Damier Graphite Zippy Coin Purse [Preloved]') }),
    row({ source_url: `${HUB}82416695/505199327-1788437501.jpeg`, status: 'needs_review', flags: ['low_res:463x495'], source_width: 463, source_height: 495,
          product: product('N3940', 'Necklace Louis Vuitton 750PG 3.90g Diamond Idylle Blossom 40cm [Preloved]') }),
    row({ source_url: `${HUB}81247920/461438748-1772029940.png`, status: 'needs_review', flags: ['low_res:434x434'], source_width: 434, source_height: 434,
          product: product('W1451', 'Wallet Louis Vuitton Porte 2 Cult Vertical Pass Case [Preloved]') }),
    row({ source_url: `${HUB}80288104/450588970-1758211904.jpeg`, status: 'approved', flags: ['edge_touch:top,bottom'], reviewed_at: '2026-09-28T02:00:00Z',
          product: product('C0983', 'Watch Van Cleef & Arpels La Collection Quartz SS White 17cm [Used]') }),
  ];
  rows.forEach((r, i) => {
    r.cutout_path = `website/derived/hero/${String(i).padStart(32, '0')}/${'b'.repeat(8)}/cutout.webp`;
    const real = ({ C0983: 'c0983', R3341: 'r3341', R3110: 'r3110', AL123: 'al123' } as Record<string, string>)[r.product?.sku ?? ''];
    THUMB.set(r.cutout_path, real ? `${SITE}${real}.webp` : drawn(r.product?.sku ?? ''));
  });
  return rows;
}

export function seedHeroCutouts(qc: QueryClient, role: string | null) {
  const admin = role !== 'staff';
  const rows = seedRows();
  const state = { mode: 'approve' as HeroMode, updated_at: '2026-09-28T01:00:00Z' };

  // The cut-out thumbnail for a row: publicUrl(cutout_path) → by row.
  const storage = supabase.storage as unknown as { from: (b: string) => Record<string, unknown>; __heroStub?: boolean };
  if (!storage.__heroStub) {
    const original = storage.from.bind(storage);
    storage.from = (bucket: string) => {
      const real = original(bucket);
      if (bucket !== 'promotions') return real;
      return { ...real, getPublicUrl: (path: string) => ({ data: { publicUrl: THUMB.get(path) ?? drawn('') } }) };
    };
    storage.__heroStub = true;
  }

  // The viewer's product read (photo number, categories): the product's photos
  // in list order, and a category by product type.
  const CATEGORY: Record<string, string> = {
    R3341: 'Fine Jewelry', AL123: 'Fine Jewelry', R3110: 'Preloved Branded Jewelry', R0831: 'Preloved Branded Jewelry',
    N2734: 'Preloved Branded Jewelry', N3940: 'Preloved Branded Jewelry', C0853: 'Preloved Watches', C0983: 'Preloved Watches',
    W2527: 'Preloved Accessories', W1451: 'Preloved Accessories',
  };
  setHeroContextForFixture(async (productId: string) => ({
    photos: rows.filter(r => r.product?.id === productId).map(r => r.source_url),
    categories: CATEGORY[productId] ? [CATEGORY[productId]] : [],
  }));

  setHeroTransportForFixture(async (fn: string, args: Record<string, unknown> = {}) => {
    if (!HERO_RPCS.has(fn)) throw new Error(`fixture: ${fn} is not a hero RPC`);
    const ok = (data: unknown) => data;
    if (fn === 'get_hero_cutout_overview') {
      const status_counts: HeroOverview['status_counts'] = {};
      for (const r of rows) status_counts[r.status] = (status_counts[r.status] ?? 0) + 1;
      return ok({ mode: state.mode, updated_at: state.updated_at, updated_by_name: 'Cynthia Largo', can_review: admin,
                  status_counts, last_recorded_at: '2026-09-28T03:00:00Z' } satisfies HeroOverview);
    }
    if (fn === 'list_hero_cutouts') {
      const f = String(args.p_filter);
      const q = String(args.p_search ?? '').toLowerCase();
      const hit = rows.filter(r =>
        (f === 'all' || (f === 'waiting' && ['ok', 'auto_fixed'].includes(r.status)) || (f === 'held' && ['needs_review', 'failed'].includes(r.status))
          || (f === 'live' && r.status === 'approved') || (f === 'rejected' && r.status === 'rejected'))
        && (!q || `${r.product?.sku} ${r.product?.name}`.toLowerCase().includes(q)));
      return ok({ total: hit.length, rows: hit });
    }
    if (!admin) return ok({ error: 'admin_only' });
    if (fn === 'set_hero_cutout_mode') {
      if (args.p_expected_mode !== state.mode) return ok({ error: 'stale', mode: state.mode });
      state.mode = args.p_mode as HeroMode; state.updated_at = new Date().toISOString();
      return ok({ ok: true, changed: true, mode: state.mode });
    }
    const r = rows.find(x => x.source_url === args.p_source_url);
    if (!r) return ok({ error: 'not_found' });
    if (args.p_expected_status !== r.status) return ok({ error: 'stale', status: r.status });
    if (args.p_action === 'approve' && r.qa_status === 'failed') return ok({ error: 'nothing_to_approve' });
    const old = r.status;
    r.status = args.p_action === 'approve' ? 'approved' : 'rejected';
    r.auto_approved = false; r.reviewed_at = new Date().toISOString();
    return ok({ ok: true, status: r.status, old_status: old });
  });
  void qc;
}
