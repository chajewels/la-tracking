/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../render-email.ts'
import {
  NewsletterCampaignEmail,
  type PostCard,
  type ProductCard,
} from '../transactional-email-templates/newsletter-campaign.tsx'

/** Shared by campaign-queue and process-newsletter-campaigns so a test send and
 * a real send can never render differently. */

export const SITE = 'https://chajewelsjp.com'

export interface Campaign {
  id: string
  subject_en: string | null
  subject_ja: string | null
  body_en: string | null
  body_ja: string | null
  audience: string
  status: string
  product_ids: string[] | null
  post_slug: string | null
}

export type Lang = 'en' | 'ja'

export function unsubscribeUrl(token: string): string {
  return `${SITE}/newsletter/unsubscribe?token=${token}`
}

export function hasLang(c: Campaign, lang: Lang): boolean {
  const subject = lang === 'ja' ? c.subject_ja : c.subject_en
  const body = lang === 'ja' ? c.body_ja : c.body_en
  return !!(subject && subject.trim() && body && body.trim())
}

/**
 * Which language a given subscriber receives, or 'skip'.
 *
 * A subscriber whose own language is missing from the campaign falls back to
 * the other one — a jewellery photo and a price read fine either way. The one
 * exception is deliberate: a Japanese subscriber is NOT sent an English-only
 * campaign that talks about layaway, because the layaway terms are a financial
 * commitment and half-understood terms are worse than no email.
 */
export function recipientLang(c: Campaign, subscriberLang: string): Lang | 'skip' {
  const own: Lang = subscriberLang === 'ja' ? 'ja' : 'en'
  if (hasLang(c, own)) return own
  const other: Lang = own === 'ja' ? 'en' : 'ja'
  if (!hasLang(c, other)) return 'skip'
  if (own === 'ja') {
    const en = `${c.subject_en ?? ''} ${c.body_en ?? ''}`.toLowerCase()
    if (en.includes('layaway')) return 'skip'
  }
  return other
}

export function subjectFor(c: Campaign, lang: Lang): string {
  return (lang === 'ja' ? c.subject_ja : c.subject_en) ?? c.subject_en ?? c.subject_ja ?? 'Cha Jewels'
}

function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString('en-US')}`
}

/** Product and post cards are read at SEND time, not at compose time, so a
 * price or a sold-out state is the one that was true when the email went out. */
export async function loadCards(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  c: Campaign,
  lang: Lang,
): Promise<{ products: ProductCard[]; post: PostCard | null }> {
  const products: ProductCard[] = []
  const ids = (c.product_ids ?? []).filter(Boolean)
  if (ids.length > 0) {
    const { data } = await supabase
      .from('website_products')
      .select('id, slug, name, name_ja, website_product_variants(id, price_jpy, sort, website_product_media(url, sort))')
      .in('id', ids)
    for (const id of ids) {
      // deno-lint-ignore no-explicit-any
      const p = (data ?? []).find((r: any) => r.id === id)
      if (!p) continue
      // deno-lint-ignore no-explicit-any
      const variants = [...(p.website_product_variants ?? [])].sort((a: any, b: any) => (a.sort ?? 0) - (b.sort ?? 0))
      const prices = variants
        // deno-lint-ignore no-explicit-any
        .map((v: any) => Number(v.price_jpy))
        .filter((n: number) => Number.isFinite(n) && n > 0)
      // deno-lint-ignore no-explicit-any
      const media = variants.flatMap((v: any) => v.website_product_media ?? [])
        // deno-lint-ignore no-explicit-any
        .sort((a: any, b: any) => (a.sort ?? 0) - (b.sort ?? 0))
      products.push({
        name: (lang === 'ja' ? p.name_ja : p.name) || p.name,
        price: prices.length > 0 ? yen(Math.min(...prices)) : null,
        url: `${SITE}/product/${p.slug}`,
        imageUrl: media[0]?.url ?? null,
      })
    }
  }

  let post: PostCard | null = null
  if (c.post_slug) {
    const { data } = await supabase
      .from('website_posts')
      .select('slug, title_en, title_ja, excerpt_en, excerpt_ja, cover_media, published')
      .eq('slug', c.post_slug)
      .maybeSingle()
    if (data && data.published) {
      post = {
        title: (lang === 'ja' ? data.title_ja : data.title_en) || data.title_en || data.slug,
        excerpt: (lang === 'ja' ? data.excerpt_ja : data.excerpt_en) ?? null,
        url: `${SITE}/journal/${data.slug}`,
        imageUrl: data.cover_media ?? null,
      }
    }
  }
  return { products, post }
}

export async function renderCampaign(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  c: Campaign,
  lang: Lang,
  unsubUrl: string,
  subjectPrefix = '',
): Promise<{ subject: string; html: string }> {
  const { products, post } = await loadCards(supabase, c, lang)
  const html = await renderEmail(
    React.createElement(NewsletterCampaignEmail, {
      subject: subjectFor(c, lang),
      bodyMarkdown: (lang === 'ja' ? c.body_ja : c.body_en) ?? '',
      lang,
      unsubscribeUrl: unsubUrl,
      products,
      post,
    }),
  )
  return { subject: `${subjectPrefix}${subjectFor(c, lang)}`, html }
}
