/**
 * Website → Photos → "Upload from Photoroom" (owner request 2026-09-27).
 *
 * The owner batch-edits photos in the Photoroom APP (up to 250 at a time) and
 * drops the exported transparent PNGs here. No Photoroom API call is made and
 * no API images are used. Each file is matched to one product photo by its
 * FILENAME, and every match is shown — with the product code and photo number
 * editable — before anything is saved:
 *
 *   AL123.png          → AL123, photo 1 (the main photo)
 *   AL123-2.png        → AL123, photo 2      (also "AL123_2", "AL123 2", "AL123 (2)")
 *   AL123-2_edit.png   → AL123, photo 2      (anything after the number is ignored)
 *
 * The product code is the first word of the name, the same rule as Page365
 * (docs/PAGE365-IMPORT.md "MATCHING IS THE FIRST WORD"). A product's photos
 * are numbered in the order the Catalog shows them: variants by sort, then
 * each variant's photos by sort, each distinct photo link once.
 *
 * Applying a file is exactly "Upload my own cut-out" (uploadOwnCutout +
 * review_media_cutout own_cutout): audited, composited by the worker, lands
 * approved. Nothing is written for a row that is not "ready".
 */
import { supabase } from '@/integrations/supabase/client';
import type { CutoutStatus } from '@/lib/media-cutouts';

export interface ParsedName { code: string; photoNo: number }

/** Product code (first word) and photo number from a file name. */
export function parseFileName(fileName: string): ParsedName {
  const base = fileName.replace(/\.[A-Za-z0-9]+$/, '').trim();
  const m = base.match(/^([A-Za-z0-9]+)(?:\s*[-_ ]\s*\(?\s*(\d{1,2})\s*\)?|\s*\(\s*(\d{1,2})\s*\))?(?=$|[-_ .(])/);
  if (!m) return { code: '', photoNo: 1 };
  const n = Number(m[2] ?? m[3] ?? 1);
  return { code: m[1].toUpperCase(), photoNo: n >= 1 ? n : 1 };
}

/** A code we will look up: letters and digits only (no wildcards reach the query). */
export function isLookupCode(code: string): boolean {
  return /^[A-Za-z0-9]{1,40}$/.test(code);
}

export interface ProductPhotos {
  productId: string;
  sku: string;
  name: string;
  /** Photo links in Catalog order; index 0 = photo 1 (main). */
  photos: string[];
}

export interface CutoutState { status: CutoutStatus; job_state: string }

interface MediaRow { url: string; sort: number | null }
interface VariantRow { sort: number | null; website_product_media: MediaRow[] | null }
interface ProductRow { id: string; sku: string; name: string; website_product_variants: VariantRow[] | null }

/** Photos of one product in Catalog order, each link once. */
export function orderedPhotos(variants: VariantRow[] | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const vs = [...(variants ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  for (const v of vs) {
    const ms = [...(v.website_product_media ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    for (const m of ms) {
      if (m.url && !seen.has(m.url)) { seen.add(m.url); out.push(m.url); }
    }
  }
  return out;
}

/** Products (by code, case-insensitive) with their photos in order. */
export async function fetchProductPhotos(codes: string[]): Promise<Map<string, ProductPhotos[]>> {
  const wanted = [...new Set(codes.filter(isLookupCode).map((c) => c.toUpperCase()))];
  const out = new Map<string, ProductPhotos[]>();
  if (wanted.length === 0) return out;
  for (let i = 0; i < wanted.length; i += 50) {
    const chunk = wanted.slice(i, i + 50);
    const { data, error } = await supabase
      .from('website_products')
      .select('id, sku, name, website_product_variants(sort, website_product_media(url, sort))')
      .or(chunk.map((c) => `sku.ilike.${c}`).join(','));
    if (error) throw new Error(error.message);
    for (const p of ((data as unknown) ?? []) as ProductRow[]) {
      const key = String(p.sku ?? '').toUpperCase();
      const list = out.get(key) ?? [];
      list.push({ productId: p.id, sku: p.sku, name: p.name, photos: orderedPhotos(p.website_product_variants) });
      out.set(key, list);
    }
  }
  return out;
}

/** The cut-out row (status + machinery) of each photo link that has one. */
export async function fetchCutoutStates(urls: string[]): Promise<Map<string, CutoutState>> {
  const out = new Map<string, CutoutState>();
  const unique = [...new Set(urls)];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase
      .from('website_media_cutouts' as never)
      .select('source_url, status, job_state')
      .in('source_url', unique.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const r of ((data as unknown) ?? []) as Array<{ source_url: string; status: CutoutStatus; job_state: string }>) {
      out.set(r.source_url, { status: r.status, job_state: r.job_state });
    }
  }
  return out;
}

export type MatchProblem =
  | 'no_code' | 'not_found' | 'several_products' | 'no_such_photo'
  | 'not_in_list' | 'busy' | 'not_image' | 'not_transparent' | 'duplicate';

export interface MatchResult {
  ready: boolean;
  problem: MatchProblem | null;
  product: ProductPhotos | null;
  sourceUrl: string | null;
  status: CutoutStatus | null;
}

export const PROBLEM_TEXT: Record<MatchProblem, string> = {
  no_code: 'Type the product code.',
  not_found: 'No product has this code.',
  several_products: 'More than one product has this code — fix the code in the Catalog first.',
  no_such_photo: 'This product has no photo with that number.',
  not_in_list: 'This photo is not in the cut-out list yet.',
  busy: 'This photo is being processed right now — try again in a few minutes.',
  not_image: 'Only PNG or WebP files can be used.',
  not_transparent: 'No transparent background — export from Photoroom as a transparent PNG.',
  duplicate: 'Another file is set for the same photo.',
};

const BUSY = new Set(['submitted', 'ready', 'processing']);

/** Decide one file's target. Pure: every input is already fetched. */
export function matchOne(
  code: string, photoNo: number,
  file: { isImage: boolean; transparent: boolean | null },
  products: Map<string, ProductPhotos[]>, states: Map<string, CutoutState>,
): MatchResult {
  const none = { product: null, sourceUrl: null, status: null };
  if (!file.isImage) return { ready: false, problem: 'not_image', ...none };
  const key = code.trim().toUpperCase();
  if (!key) return { ready: false, problem: 'no_code', ...none };
  const found = products.get(key) ?? [];
  if (found.length === 0) return { ready: false, problem: 'not_found', ...none };
  if (found.length > 1) return { ready: false, problem: 'several_products', ...none };
  const product = found[0];
  const sourceUrl = product.photos[photoNo - 1] ?? null;
  if (!sourceUrl) return { ready: false, problem: 'no_such_photo', product, sourceUrl: null, status: null };
  const st = states.get(sourceUrl);
  if (!st) return { ready: false, problem: 'not_in_list', product, sourceUrl, status: null };
  if (BUSY.has(st.job_state)) return { ready: false, problem: 'busy', product, sourceUrl, status: st.status };
  if (file.transparent === false) return { ready: false, problem: 'not_transparent', product, sourceUrl, status: st.status };
  return { ready: file.transparent === true, problem: null, product, sourceUrl, status: st.status };
}

/** Two ready files aimed at the same photo: neither is applied until one is changed. */
export function markDuplicates(results: MatchResult[]): MatchResult[] {
  const count = new Map<string, number>();
  for (const r of results) if (r.sourceUrl && r.problem === null) count.set(r.sourceUrl, (count.get(r.sourceUrl) ?? 0) + 1);
  return results.map((r) => (r.sourceUrl && r.problem === null && (count.get(r.sourceUrl) ?? 0) > 1
    ? { ...r, ready: false, problem: 'duplicate' as const }
    : r));
}
