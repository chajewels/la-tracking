import * as React from 'npm:react@18.3.1'
import { renderEmail } from './render-email.ts'
import { EmailAPIError, sendLovableEmail } from 'npm:@lovable.dev/email-js@0.1.0'
import { recordEmailAttempt } from './email-log.ts'

/**
 * Customer emails for chajewelsjp.com STOREFRONT orders.
 *
 * Same sender setup as the storefront sign-in email (auth-email-hook):
 * "Cha Jewels <noreply@chajewelsjp.com>" through Lovable's managed email API
 * on the verified notify.chajewelsjp.com sender domain. Never "Cha Jewels
 * Hub" — the customer has never heard of the Hub.
 *
 * TEST GATE. A customer flagged is_test never receives storefront email unless
 * the address is one the owner reads (@chajewelsjp.com, or
 * chajewelsjapan@gmail.com), so a test order still produces the real email for
 * the owner and nothing for a throwaway address.
 *
 * Also used (2026-09-13) for the loyalty LEVEL emails in
 * _shared/email-templates/loyalty-level.tsx — same brand, same Reply-To,
 * same test gate; `reference` is then the customer code.
 *
 * ONE LOG LINE PER SEND, always: label, order reference, recipient, outcome.
 * Sending is fire-and-forget for the caller — a failed email never fails the
 * order, the confirmation or the expiry that triggered it.
 *
 * Since 2026-09-13 every attempt (sent / suppressed / error) is ALSO written to
 * email_send_log via _shared/email-log.ts, channel 'storefront' — function
 * logs retain minutes and hid the nine-day missing_unsubscribe outage.
 */

export type Lang = 'ja' | 'en'

export const STOREFRONT_FROM = 'Cha Jewels <noreply@chajewelsjp.com>'
export const STOREFRONT_SENDER_DOMAIN = 'notify.chajewelsjp.com'
/** Replies to any storefront email land with sales, not in the noreply void. */
export const STOREFRONT_REPLY_TO = 'sales@chajewelsjp.com'

const OWNER_ADDRESSES = new Set(['chajewelsjapan@gmail.com'])
const OWNER_DOMAIN = '@chajewelsjp.com'

export function pickLang(v: unknown): Lang {
  return v === 'en' ? 'en' : 'ja'
}

/** The storefront order page for this order, built from WEBSITE_URL. */
export function storefrontOrderUrl(orderId: string): string | null {
  const base = (Deno.env.get('WEBSITE_URL') ?? '').replace(/\/$/, '')
  return base ? `${base}/account/orders/${encodeURIComponent(orderId)}` : null
}

/** The storefront layaway page for this plan, built from WEBSITE_URL. */
export function storefrontLayawayUrl(accountId: string): string | null {
  const base = (Deno.env.get('WEBSITE_URL') ?? '').replace(/\/$/, '')
  return base ? `${base}/account/layaway/${encodeURIComponent(accountId)}` : null
}

/**
 * Money in the account's own settlement currency. A web layaway can be settled
 * in yen or in pesos (owner decision 2026-09-13), so an email about one cannot
 * assume the yen symbol the way an order email can.
 */
export function formatMoney(n: number | string | null | undefined, currency: 'JPY' | 'PHP' = 'JPY'): string {
  const v = Math.round(Number(n ?? 0))
  return `${currency === 'PHP' ? '\u20b1' : '\u00a5'}${v.toLocaleString('en-US')}`
}

/**
 * Money on a web ORDER email, in the order's own currency. Yen keeps
 * formatJpy, so a yen email is exactly what it was before peso full payment
 * (2026-09-25); pesos use formatMoney's ₱, as the layaway emails already do.
 */
export function orderMoney(n: number, currency: 'JPY' | 'PHP' | undefined): string {
  return currency === 'PHP' ? formatMoney(n, 'PHP') : formatJpy(n)
}

/** Owner-readable address? The only exception to the test gate. */
export function ownerReadable(email: string): boolean {
  const e = email.trim().toLowerCase()
  return OWNER_ADDRESSES.has(e) || e.endsWith(OWNER_DOMAIN)
}

export interface StorefrontRecipient {
  email: string | null | undefined
  is_test?: boolean | null
}

export interface SendStorefrontEmailArgs {
  to: StorefrontRecipient
  subject: string
  element: React.ReactElement
  /** Short machine label for logs and Lovable's send log, e.g. "order-confirmation". */
  label: string
  /** The reference the customer sees (CJ-W-000123). Logged, never used as the key. */
  reference: string
  /** Dedupes retries of the same logical send. */
  idempotencyKey: string
}

export type SendStorefrontEmailResult =
  | { sent: true }
  | { sent: false; reason: 'no_address' | 'test_customer' | 'recipient_suppressed' | 'not_configured' | 'error'; detail?: string }

export async function sendStorefrontEmail(args: SendStorefrontEmailArgs): Promise<SendStorefrontEmailResult> {
  const { label, reference } = args
  const email = String(args.to.email ?? '').trim()
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ storefront_email: label, reference, to: email || null, outcome, ...extra }))

  // A SKIP IS AN OUTCOME AND IT LEAVES A ROW.
  //
  // These three paths used to return silently, writing nothing to
  // email_send_log. That made "the customer never got the email"
  // indistinguishable from "the send was never reached" — you could only tell
  // them apart from the function log, which retains minutes. It is the same
  // blind spot that hid the 2026-09-04 outage for nine days, and it is why the
  // web-order confirmation could not be diagnosed from the log alone.
  //
  // recordEmailAttempt never throws, so logging a skip cannot turn a skipped
  // send into a failed order.
  const skip = async (reason: 'no_address' | 'test_customer' | 'not_configured') => {
    log(`skipped_${reason}`)
    await recordEmailAttempt({
      channel: 'storefront',
      template: label,
      // recipient_email is NOT NULL; an absent address is recorded as such
      // rather than silently dropping the row.
      recipient: email || '(no address)',
      status: 'skipped',
      idempotencyKey: args.idempotencyKey,
      metadata: { reference, skip_reason: reason },
    })
    return { sent: false as const, reason }
  }

  if (!email) return await skip('no_address')
  if (args.to.is_test === true && !ownerReadable(email)) return await skip('test_customer')
  const apiKey = Deno.env.get('LOVABLE_API_KEY')
  if (!apiKey) return await skip('not_configured')

  try {
    const html = await renderEmail(args.element)
    const text = await renderEmail(args.element, { plainText: true })
    await sendLovableEmail(
      {
        to: email,
        from: STOREFRONT_FROM,
        sender_domain: STOREFRONT_SENDER_DOMAIN,
        reply_to: STOREFRONT_REPLY_TO,
        subject: args.subject,
        html,
        text,
        purpose: 'transactional',
        label,
        idempotency_key: args.idempotencyKey,
      },
      { apiKey, sendUrl: Deno.env.get('LOVABLE_SEND_URL') },
    )
    log('sent')
    await recordEmailAttempt({ channel: 'storefront', template: label, recipient: email, status: 'sent', idempotencyKey: args.idempotencyKey, metadata: { reference } })
    return { sent: true }
  } catch (error) {
    if (error instanceof EmailAPIError && error.code === 'recipient_suppressed') {
      log('suppressed')
      await recordEmailAttempt({ channel: 'storefront', template: label, recipient: email, status: 'suppressed', idempotencyKey: args.idempotencyKey, metadata: { reference } })
      return { sent: false, reason: 'recipient_suppressed' }
    }
    const detail = (error as Error)?.message ?? String(error)
    log('error', { detail })
    await recordEmailAttempt({ channel: 'storefront', template: label, recipient: email, status: 'failed', idempotencyKey: args.idempotencyKey, error, metadata: { reference } })
    return { sent: false, reason: 'error', detail }
  }
}

// ----------------------------------------------------------------- formatting
// Shared by the three order templates so figures and dates read the same in
// every email. Money is JPY only (web orders are JPY); dates carry the zone.

export function formatJpy(n: number | string | null | undefined): string {
  const v = Math.round(Number(n ?? 0))
  return `¥${v.toLocaleString('en-US')}`
}

/**
 * Deadline in the customer's clock. Japan orders read in JST; overseas orders
 * (the Philippines is the other market) in PHT. Both carry the zone name so a
 * reader in a third place is not misled.
 */
export function formatDeadline(iso: string | null | undefined, region: 'JP' | 'OVERSEAS', lang: Lang): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const timeZone = region === 'JP' ? 'Asia/Tokyo' : 'Asia/Manila'
  const zone = region === 'JP' ? 'JST' : 'PHT'
  if (lang === 'ja') {
    const parts = new Intl.DateTimeFormat('ja-JP', { timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
    return `${parts}（${zone}）`
  }
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return `${parts} ${zone}`
}
