/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Text } from 'npm:@react-email/components@0.0.22'
import { formatJpy, orderMoney, type Lang } from '../storefront-email.ts'
import { COMPANY_NAME } from '../transactional-email-templates/brand.ts'

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
  footer: { ja: `${COMPANY_NAME} · 東京都葛飾区立石`, en: `${COMPANY_NAME} · Tateishi, Katsushika, Tokyo` },
  help: { ja: 'ご不明な点は、このメールにご返信ください。', en: 'Questions? Reply to this email.' },
} as const

export const itemTitle = (i: OrderEmailItem, lang: Lang) => (lang === 'ja' && i.title_ja ? i.title_ja : i.title)

/**
 * A PANEL — the bordered box behind the items, the plan summary, the schedule
 * and each transfer method.
 *
 * NOT a `<Section style={{ margin: '8px 24px' }}>`, and this is the whole point
 * of the component. @react-email renders `Section` as `<table width="100%">`,
 * and a table with an explicit 100% width CANNOT be inset with horizontal
 * margin: the margin shifts it right while the width keeps it a full 100% wide,
 * so it ends exactly margin-left past the panel. `container` carries
 * `overflow: hidden`, so those pixels are CLIPPED rather than merely spilling —
 * which is why CJ-W-900013's Total, Deposit, Term, account number and account
 * holder all arrived cut mid-value in Gmail.
 *
 * Measured at +21px past a 560px panel, at every viewport, in all seven
 * storefront templates. `box-sizing: border-box` does NOT fix it — a table
 * already resolves its width attribute that way, and the measurement is
 * unchanged. See docs/FIXED-BUGS.md Bug #274.
 *
 * So the gutter lives as PADDING ON A `<td>`, which can only ever shrink the
 * content area, never grow the box past its container, and the visible border
 * sits on an auto-width `<div>` inside it. Keep it that way: moving the inset
 * back onto the table as margin reintroduces the clipping silently, because a
 * browser preview shows the panel growing instead of cutting.
 */
export const Panel = ({ gutter, box, children }: { gutter: React.CSSProperties; box: React.CSSProperties; children: React.ReactNode }) => (
  <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={panelTable}>
    <tbody>
      <tr>
        <td style={gutter}>
          <div style={box}>{children}</div>
        </td>
      </tr>
    </tbody>
  </table>
)

/** The currency a web order settles in. Yen when absent — every order before 2026-09-25. */
export type OrderCurrency = 'JPY' | 'PHP'

/**
 * Items, shipping, total.
 *
 * `shippingJpy` / `totalJpy` keep their names for the callers' sake but carry
 * the order's own figures — cash_orders.shipping_fee / total_amount, which are
 * in the order's currency. Item lines are always YEN (cash_order_items, the
 * price of record), so on a PESO order they are listed WITHOUT a price and only
 * shipping and total are shown, in ₱ (owner decision D1, 2026-09-25 — the
 * peso-layaway precedent). Two currencies never share one receipt.
 */
export const ItemsTable = ({ items, shippingJpy, totalJpy, lang, currency }: { items: OrderEmailItem[]; shippingJpy: number | null; totalJpy: number; lang: Lang; currency?: OrderCurrency }) => (
  <Panel gutter={blockGutter} box={block}>
    <Text style={label}>{WORDS.items[lang]}</Text>
    {items.map((i, idx) => (
      <Row key={idx} k={`${itemTitle(i, lang)}${i.qty > 1 ? ` × ${i.qty}` : ''}`} v={currency === 'PHP' ? '' : formatJpy(i.line_total_jpy)} />
    ))}
    <Row
      k={WORDS.shipping[lang]}
      v={shippingJpy === null ? '—' : shippingJpy === 0 ? WORDS.free[lang] : orderMoney(shippingJpy, currency)}
    />
    <Row k={WORDS.total[lang]} v={orderMoney(totalJpy, currency)} emphasis />
  </Panel>
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
        <Panel key={m.id} gutter={cardGutter} box={card}>
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
          {note && <Text style={{ ...muted, margin: '10px 0 0', whiteSpace: 'pre-line' as const }}>{note}</Text>}
        </Panel>
      )
    })}
    <Text style={notice}>{WORDS.nameNotice[lang]}</Text>
  </>
)

/**
 * ONE LABEL/VALUE LINE, AS A TABLE — NEVER FLEX.
 *
 * Gmail strips `display:flex` from a <div>. The two spans then run together
 * with no gap and no alignment: the CJ-W-900011 test on 2026-09-14 arrived
 * reading "ShippingFree", "Total¥628,980", "Account number7555832" and
 * "Branch第四営業支店 (254)", while the browser preview looked correct — which is
 * exactly why a preview cannot be the check.
 *
 * A two-cell table survives, but only if the geometry is carried as HTML
 * ATTRIBUTES on the <td> (width, align) rather than as CSS Gmail may drop.
 * Keep it that way: a class or a flex rule here reintroduces the bug silently.
 */
export const Row = ({ k, v, mono, emphasis }: { k: string; v: string; mono?: boolean; emphasis?: boolean }) => (
  <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={emphasis ? rowTableTotal : rowTable}>
    <tbody>
      <tr>
        <td align="left" width="52%" style={emphasis ? rowKeyCellTotal : rowKeyCell}>{k}</td>
        <td
          align="right"
          width="48%"
          style={{
            ...(emphasis ? rowValCellTotal : rowValCell),
            ...(mono ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } : {}),
          }}
        >
          {v}
        </td>
      </tr>
    </tbody>
  </table>
)

export const main = { backgroundColor: '#f6f4ef', fontFamily: '"Hiragino Sans", "Noto Sans JP", Arial, sans-serif' }
export const container = { backgroundColor: '#ffffff', margin: '24px auto', maxWidth: '560px', borderRadius: '8px', overflow: 'hidden' as const }
export const headerBar = { borderTop: '4px solid #C9A227', padding: '24px 24px 8px', textAlign: 'center' as const }
export const wordmark = { fontSize: '22px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0', letterSpacing: '1px' }
export const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '16px 24px 8px' }
export const h2 = { fontSize: '18px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '16px 24px 8px' }
export const text = { fontSize: '15px', lineHeight: '1.7', color: '#3a3a3a', margin: '0 24px 12px' }
export const muted = { fontSize: '13px', lineHeight: '1.6', color: '#6b6b6b', margin: '0 24px 12px' }
/**
 * `block` and `card` are now the INNER BOX of a `Panel` — border and padding
 * only, on an auto-width `<div>`. The horizontal inset they used to carry as
 * `margin` lives in the matching `*Gutter` below, as padding on a `<td>`. See
 * the note on Panel: margin on a 100%-width table clips, it does not inset.
 */
export const blockGutter = { padding: '8px 24px 16px' }
export const block = { padding: '12px 16px', border: '1px solid #e6dfd0', borderRadius: '6px' }
export const cardGutter = { padding: '8px 24px 12px' }
export const card = { padding: '14px 16px', border: '1px solid #C9A227', borderRadius: '6px' }
export const panelTable = { borderCollapse: 'collapse' as const, width: '100%' }
export const cardTitle = { fontSize: '16px', fontWeight: 'bold' as const, color: '#1a1a2e', margin: '0 0 8px' }
export const label = { fontSize: '12px', letterSpacing: '1px', textTransform: 'uppercase' as const, color: '#6b6b6b', margin: '0 0 8px' }
/**
 * RETIRED — do not use in a new template. `display:flex` does not survive
 * Gmail; see the note on Row. Kept only so an older import still compiles.
 */
export const row = { padding: '6px 0', borderBottom: '1px solid #eee7d8', fontSize: '14px' }
export const rowKey = { color: '#6b6b6b' }
export const rowVal = { color: '#1a1a2e', textAlign: 'right' as const }

export const rowTable = { borderCollapse: 'collapse' as const, width: '100%' }
export const rowTableTotal = { borderCollapse: 'collapse' as const, width: '100%', marginTop: '4px' }
/**
 * `wordBreak`/`overflowWrap` are load-bearing, not tidying. A value with no
 * space in it — a long account holder written as one token, an IBAN — cannot be
 * wrapped by the table, so auto layout widens the cell until it fits and the
 * 560px `max-width` on `container` cannot hold it: measured at 778px, i.e. the
 * whole email wider than the window, at every viewport. Breaking the word keeps
 * the panel at 560px (and at 400px on a phone). Bug #274.
 */
const cellBase = {
  padding: '6px 0', borderBottom: '1px solid #eee7d8', fontSize: '14px',
  verticalAlign: 'top' as const,
  wordBreak: 'break-word' as const, overflowWrap: 'anywhere' as const,
}
export const rowKeyCell = { ...cellBase, color: '#6b6b6b', paddingRight: '12px' }
export const rowValCell = { ...cellBase, color: '#1a1a2e' }
const totalCellBase = {
  padding: '10px 0 6px', borderBottom: 'none', borderTop: '2px solid #C9A227',
  verticalAlign: 'top' as const,
  wordBreak: 'break-word' as const, overflowWrap: 'anywhere' as const,
}
export const rowKeyCellTotal = { ...totalCellBase, color: '#1a1a2e', fontWeight: 'bold' as const, fontSize: '14px', paddingRight: '12px' }
export const rowValCellTotal = { ...totalCellBase, color: '#1a1a2e', fontWeight: 'bold' as const, fontSize: '18px' }
export const notice = { margin: '4px 24px 16px', padding: '12px 16px', backgroundColor: '#f6f4ef', borderRadius: '6px', fontSize: '14px', color: '#3a3a3a' }
/**
 * No horizontal margin, for the Panel reason: this is a `Section`, so it is a
 * 100%-width table and a 24px margin would push it 24px past the panel. The
 * button is centred inside the full width, which looks identical.
 */
export const buttonWrap = { textAlign: 'center' as const, margin: '20px 0' }
export const button = { backgroundColor: '#C9A227', color: '#1a1a2e', fontWeight: 'bold' as const, fontSize: '15px', padding: '12px 28px', borderRadius: '4px', textDecoration: 'none' }
export const rule = { borderColor: '#e6dfd0', margin: '20px 24px' }
export const footer = { fontSize: '12px', color: '#8a8a8a', margin: '16px 24px 24px', textAlign: 'center' as const }
