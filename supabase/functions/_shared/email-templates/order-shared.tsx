/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Section, Text } from 'npm:@react-email/components@0.0.22'
import { formatJpy, type Lang } from '../storefront-email.ts'

/**
 * Pieces shared by the storefront ORDER emails (confirmation, payment
 * received, expired). Cha Jewels branding, the customer's language first and
 * English below, never a mention of the Hub. Literal hex is deliberate: mail
 * clients cannot read CSS variables (CLAUDE.md, BRAND STYLE STANDARD). Button
 * text is dark on gold — the accessible pairing.
 */

export interface OrderEmailItem {
  title: string
  title_ja?: string | null
  qty: number
  line_total_jpy: number
}

/** The storefront's TransferMethod shape, exactly as /checkout/pay returned it. */
export interface OrderEmailMethod {
  id: string
  method_type: string
  label_ja: string
  label_en: string
  bank: { name: string; branch: string | null; account_type: string | null; account_number: string | null; account_holder: string | null } | null
  wallet: { number: string; name: string | null } | null
  note_ja: string | null
  note_en: string | null
}

export const WORDS = {
  items: { ja: 'ご注文商品', en: 'Items' },
  shipping: { ja: '送料', en: 'Shipping' },
  free: { ja: '無料', en: 'Free' },
  total: { ja: '合計', en: 'Total' },
  reference: { ja: 'ご注文番号', en: 'Order reference' },
  bankName: { ja: '銀行名', en: 'Bank' },
  branch: { ja: '支店名', en: 'Branch' },
  accountType: { ja: '口座種別', en: 'Account type' },
  accountNumber: { ja: '口座番号', en: 'Account number' },
  accountHolder: { ja: '口座名義', en: 'Account holder' },
  gcashNumber: { ja: 'GCash 番号', en: 'GCash number' },
  gcashName: { ja: 'GCash 名義', en: 'GCash name' },
  mayaNumber: { ja: 'Maya 番号', en: 'Maya number' },
  mayaName: { ja: 'Maya 名義', en: 'Maya name' },
  walletNumber: { ja: '送金先番号', en: 'Account / number' },
  walletName: { ja: '登録名義', en: 'Registered name' },
  nameNotice: { ja: '振込名義はご注文者名でお願いします。', en: 'Please transfer under the name on the order.' },
  viewOrder: { ja: 'ご注文を確認する', en: 'View your order' },
  footer: { ja: 'Cha Jewels Co., Ltd. · 東京都葛飾区立石', en: 'Cha Jewels Co., Ltd. · Tateishi, Katsushika, Tokyo' },
  help: { ja: 'ご不明な点は、このメールにご返信ください。', en: 'Questions? Reply to this email.' },
} as const

export const itemTitle = (i: OrderEmailItem, lang: Lang) => (lang === 'ja' && i.title_ja ? i.title_ja : i.title)

export const ItemsTable = ({ items, shippingJpy, totalJpy, lang }: { items: OrderEmailItem[]; shippingJpy: number | null; totalJpy: number; lang: Lang }) => (
  <Section style={block}>
    <Text style={label}>{WORDS.items[lang]}</Text>
    {items.map((i, idx) => (
      <div key={idx} style={row}>
        <span style={rowKey}>{itemTitle(i, lang)}{i.qty > 1 ? ` × ${i.qty}` : ''}</span>
        <span style={rowVal}>{formatJpy(i.line_total_jpy)}</span>
      </div>
    ))}
    <div style={row}>
      <span style={rowKey}>{WORDS.shipping[lang]}</span>
      <span style={rowVal}>{shippingJpy === null ? '—' : shippingJpy === 0 ? WORDS.free[lang] : formatJpy(shippingJpy)}</span>
    </div>
    <div style={{ ...row, borderBottom: 'none', borderTop: '2px solid #C9A227', paddingTop: '10px', marginTop: '4px' }}>
      <span style={{ ...rowKey, color: '#1a1a2e', fontWeight: 'bold' }}>{WORDS.total[lang]}</span>
      <span style={{ ...rowVal, fontSize: '18px', fontWeight: 'bold', color: '#1a1a2e' }}>{formatJpy(totalJpy)}</span>
    </div>
  </Section>
)

/** Every transfer method shown at checkout, as its own labelled card, in the Hub's order. */
export const MethodCards = ({ methods, lang }: { methods: OrderEmailMethod[]; lang: Lang }) => (
  <>
    {methods.map((m) => {
      const isGcash = m.method_type === 'gcash'
      const isMaya = m.method_type === 'maya'
      const numberLabel = isGcash ? WORDS.gcashNumber[lang] : isMaya ? WORDS.mayaNumber[lang] : WORDS.walletNumber[lang]
      const nameLabel = isGcash ? WORDS.gcashName[lang] : isMaya ? WORDS.mayaName[lang] : WORDS.walletName[lang]
      const note = lang === 'ja' ? m.note_ja : m.note_en
      return (
        <Section key={m.id} style={card}>
          <Text style={cardTitle}>{lang === 'ja' ? m.label_ja : m.label_en}</Text>
          {m.wallet && (
            <>
              <Row k={numberLabel} v={m.wallet.number} mono />
              {m.wallet.name && <Row k={nameLabel} v={m.wallet.name} />}
            </>
          )}
          {m.bank && (
            <>
              <Row k={WORDS.bankName[lang]} v={m.bank.name} />
              {m.bank.branch && <Row k={WORDS.branch[lang]} v={m.bank.branch} />}
              {m.bank.account_type && <Row k={WORDS.accountType[lang]} v={m.bank.account_type} />}
              {m.bank.account_number && <Row k={WORDS.accountNumber[lang]} v={m.bank.account_number} mono />}
              {m.bank.account_holder && <Row k={WORDS.accountHolder[lang]} v={m.bank.account_holder} />}
            </>
          )}
          {note && <Text style={{ ...muted, whiteSpace: 'pre-line' as const, marginTop: '10px' }}>{note}</Text>}
        </Section>
      )
    })}
    <Text style={notice}>{WORDS.nameNotice[lang]}</Text>
  </>
)

export const Row = ({ k, v, mono }: { k: string; v: string; mono?: boolean }) => (
  <div style={row}>
    <span style={rowKey}>{k}</span>
    <span style={{ ...rowVal, fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined }}>{v}</span>
  </div>
)

export const main = { backgroundColor: '#f6f4ef', fontFamily: '"Hiragino Sans", "Noto Sans JP", Arial, sans-serif' }
export const container = { backgroundColor: '#ffffff', margin: '24px auto', maxWidth: '560px', borderRadius: '8px', overflow: 'hidden' as const }
export const headerBar = { borderTop: '4px solid #C9A227', padding: '24px 24px 8px', textAlign: 'center' as const }
export const wordmark = { fontSize: '22px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '1px' }
export const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '16px 24px 8px' }
export const h2 = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '16px 24px 8px' }
export const text = { fontSize: '15px', lineHeight: '1.7', color: '#3a3a3a', margin: '0 24px 12px' }
export const muted = { fontSize: '13px', lineHeight: '1.6', color: '#6b6b6b', margin: '0 24px 12px' }
export const block = { margin: '8px 24px 16px', padding: '12px 16px', border: '1px solid #e6dfd0', borderRadius: '6px' }
export const card = { margin: '8px 24px 12px', padding: '14px 16px', border: '1px solid #C9A227', borderRadius: '6px' }
export const cardTitle = { fontSize: '16px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0 0 8px' }
export const label = { fontSize: '12px', letterSpacing: '1px', textTransform: 'uppercase' as const, color: '#6b6b6b', margin: '0 0 8px' }
export const row = { display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '6px 0', borderBottom: '1px solid #eee7d8', fontSize: '14px' }
export const rowKey = { color: '#6b6b6b' }
export const rowVal = { color: '#1a1a2e', textAlign: 'right' as const }
export const notice = { margin: '4px 24px 16px', padding: '12px 16px', backgroundColor: '#f6f4ef', borderRadius: '6px', fontSize: '14px', color: '#3a3a3a' }
export const buttonWrap = { textAlign: 'center' as const, margin: '20px 24px' }
export const button = { backgroundColor: '#C9A227', color: '#1a1a2e', fontWeight: 'bold' as const, fontSize: '15px', padding: '12px 28px', borderRadius: '4px', textDecoration: 'none' }
export const rule = { borderColor: '#e6dfd0', margin: '20px 24px' }
export const footer = { fontSize: '12px', color: '#8a8a8a', margin: '16px 24px 24px', textAlign: 'center' as const }
