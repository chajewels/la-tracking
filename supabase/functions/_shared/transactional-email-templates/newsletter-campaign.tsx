/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Text, Section, Hr, Img, Link,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { renderMarkdown } from '../newsletter/markdown.tsx'

/**
 * Newsletter campaign email.
 *
 * Marketing mail, so unlike every transactional template it carries the legal
 * footer in full: the registered company name, the registered address, and a
 * one-click unsubscribe link. The same URL is also sent as a List-Unsubscribe
 * header by the provider adapter — the header alone is not enough for the
 * Japanese 特定電子メール法 / CAN-SPAM requirement that the link be visible in
 * the body.
 *
 * The body arrives as markdown typed by staff and is rendered to React
 * ELEMENTS (see ../newsletter/markdown.tsx) — never to an HTML string — so a
 * body containing raw markup can never become live markup in the inbox.
 */

export interface ProductCard {
  name: string
  price: string | null
  url: string
  imageUrl: string | null
}

export interface PostCard {
  title: string
  excerpt: string | null
  url: string
  imageUrl: string | null
}

interface Props {
  subject?: string
  bodyMarkdown?: string
  lang?: 'en' | 'ja'
  unsubscribeUrl?: string
  products?: ProductCard[]
  post?: PostCard | null
}

const COPY = {
  en: {
    picks: 'Featured pieces',
    read: 'Read more',
    view: 'View piece',
    company: 'Ｃｈａ Ｊｅｗｅｌｓ株式会社',
    address: 'Time Mansion 301, 6-5-1 Tateishi, Katsushika-ku, Tokyo 124-0012, Japan',
    why: 'You are receiving this because you subscribed to Cha Jewels updates.',
    unsub: 'Unsubscribe',
  },
  ja: {
    picks: '注目のジュエリー',
    read: '続きを読む',
    view: '商品を見る',
    company: 'Ｃｈａ Ｊｅｗｅｌｓ株式会社',
    address: '〒124-0012 東京都葛飾区立石6-5-1 タイムマンション301',
    why: 'Cha Jewels のニュースレターにご登録いただいた方にお送りしています。',
    unsub: '配信停止',
  },
} as const

const CONTACT_EMAIL = 'sales@chajewelsjp.com'

const NewsletterCampaignEmail = ({
  subject = 'Cha Jewels',
  bodyMarkdown = '',
  lang = 'en',
  unsubscribeUrl = 'https://chajewelsjp.com/newsletter/unsubscribe',
  products = [],
  post = null,
}: Props) => {
  const t = COPY[lang === 'ja' ? 'ja' : 'en']
  return (
    <Html lang={lang} dir="ltr">
      <Head />
      <Preview>{subject}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={headerBar}>
            <Text style={brandText}>💎 Cha Jewels</Text>
          </Section>

          <Heading style={title}>{subject}</Heading>

          {renderMarkdown(bodyMarkdown)}

          {products.length > 0 && (
            <Section style={cardsWrap}>
              <Text style={cardsHeading}>{t.picks}</Text>
              {products.map((p, i) => (
                <Section key={`prod${i}`} style={card}>
                  {p.imageUrl && (
                    <Link href={p.url}>
                      <Img src={p.imageUrl} alt={p.name} width="512" style={cardImg} />
                    </Link>
                  )}
                  <Text style={cardTitle}>{p.name}</Text>
                  {p.price && <Text style={cardMeta}>{p.price}</Text>}
                  <Text style={cardLinkRow}>
                    <Link href={p.url} style={cardLink}>{t.view} →</Link>
                  </Text>
                </Section>
              ))}
            </Section>
          )}

          {post && (
            <Section style={cardsWrap}>
              <Section style={card}>
                {post.imageUrl && (
                  <Link href={post.url}>
                    <Img src={post.imageUrl} alt={post.title} width="512" style={cardImg} />
                  </Link>
                )}
                <Text style={cardTitle}>{post.title}</Text>
                {post.excerpt && <Text style={cardMeta}>{post.excerpt}</Text>}
                <Text style={cardLinkRow}>
                  <Link href={post.url} style={cardLink}>{t.read} →</Link>
                </Text>
              </Section>
            </Section>
          )}

          <Hr style={hr} />
          <Text style={footer}>{t.why}</Text>
          <Text style={footer}>
            <Link href={unsubscribeUrl} style={unsubLink}>{t.unsub}</Link>
          </Text>
          <Text style={footerBrand}>{t.company}</Text>
          <Text style={footerAddr}>{t.address}</Text>
        </Container>
      </Body>
    </Html>
  )
}

export const template = {
  /** Customer-facing: "Cha Jewels" From name, customer footer. */
  audience: 'customer' as const,
  component: NewsletterCampaignEmail,
  subject: (data: Record<string, any>) => data.subject || 'Cha Jewels',
  displayName: 'Newsletter Campaign',
  previewData: {
    subject: 'New arrivals — September',
    lang: 'en',
    bodyMarkdown:
      '## This month at Cha Jewels\n\nThree new **pearl** pieces just landed, each one hand-finished in Tokyo.\n\n- Akoya pearl studs\n- A 18K gold chain, 45cm\n- One-of-a-kind diamond pendant\n\nRead the full story on [our journal](https://chajewelsjp.com/journal).',
    unsubscribeUrl: 'https://chajewelsjp.com/newsletter/unsubscribe?token=demo',
    products: [],
    post: null,
  },
} satisfies TemplateEntry

export { NewsletterCampaignEmail }

const main = { backgroundColor: '#ffffff', fontFamily: "'Montserrat', 'Inter', Arial, sans-serif" }
const container = { padding: '0', maxWidth: '560px', margin: '0 auto' }
const headerBar = { borderTop: '4px solid #C9A227', padding: '24px 24px 8px', textAlign: 'center' as const }
const brandText = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '0.5px' }
const title = { fontSize: '22px', fontWeight: 'bold' as const, color: '#a37e1f', textAlign: 'center' as const, margin: '16px 24px 16px' }
const cardsWrap = { padding: '8px 0 0' }
const cardsHeading = { fontSize: '13px', fontWeight: 'bold' as const, color: '#a37e1f', letterSpacing: '1px', textTransform: 'uppercase' as const, padding: '0 24px', margin: '16px 0 8px' }
const card = { padding: '0 24px 16px' }
const cardImg = { width: '100%', maxWidth: '512px', borderRadius: '8px', display: 'block' as const }
const cardTitle = { fontSize: '15px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '10px 0 2px' }
const cardMeta = { fontSize: '13px', color: '#6b7280', margin: '0 0 6px', lineHeight: '1.5' }
const cardLinkRow = { margin: '0' }
const cardLink = { fontSize: '13px', color: '#a37e1f', fontWeight: 'bold' as const, textDecoration: 'none' }
const hr = { borderColor: '#e5e7eb', margin: '24px' }
const footer = { fontSize: '12px', color: '#9ca3af', padding: '0 24px', margin: '0 0 6px', lineHeight: '1.5', textAlign: 'center' as const }
const unsubLink = { color: '#9ca3af', textDecoration: 'underline' }
const footerBrand = { fontSize: '11px', color: '#C9A227', textAlign: 'center' as const, padding: '8px 24px 0', margin: '0', fontWeight: 'bold' as const }
const footerAddr = { fontSize: '11px', color: '#9ca3af', textAlign: 'center' as const, padding: '2px 24px 24px', margin: '0' }
