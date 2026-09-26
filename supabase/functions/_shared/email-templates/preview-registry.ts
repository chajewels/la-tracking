/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'

import { OrderReservedEmail, orderReservedSubject } from './order-reserved.tsx'
import { LayawayReservedEmail, layawayReservedSubject } from './layaway-reserved.tsx'
import { OrderConfirmationEmail, orderReadySubject } from './order-confirmation.tsx'
import { LayawayPlanCreatedEmail, layawayReadySubject } from './layaway-plan-created.tsx'
import { OrderCancelledEmail, orderCancelledSubject } from './order-cancelled.tsx'
import { LayawayDeclinedEmail, layawayDeclinedSubject } from './layaway-declined.tsx'
import { OrderReservationLapsedEmail, orderReservationLapsedSubject } from './order-reservation-lapsed.tsx'
import { OrderPaymentDueEmail, orderPaymentDueSubject } from './order-payment-due.tsx'
import { LayawayDepositDueEmail, layawayDepositDueSubject } from './layaway-deposit-due.tsx'
import type { OrderEmailMethod } from './order-shared.tsx'

/**
 * PREVIEWS FOR THE STOREFRONT EMAILS (reserve-first A2, 2026-09-24).
 *
 * The storefront templates are rendered by their callers with
 * sendStorefrontEmail — they are NOT in transactional-email-templates/
 * registry.ts, and must not be: that registry is also what
 * send-transactional-email sends from, and a second way to send a storefront
 * email would bypass its callers' own rules (language, test gate, idempotency
 * keys). This list exists only so preview-transactional-email can render them
 * beside the Hub templates. Nothing sends from it.
 *
 * Every A2 customer email is here, in each language it can go out in.
 */
export interface StorefrontPreview {
  displayName: string
  component: React.ComponentType<any>
  subject: string
  previewData: Record<string, any>
}

const items = [
  { title: 'Pearl drop earrings', title_ja: 'パールドロップピアス', qty: 1, line_total_jpy: 68000 },
]
const methods: OrderEmailMethod[] = [
  {
    id: 'preview-bank',
    method_type: 'bank',
    label_ja: '銀行振込',
    label_en: 'Bank transfer',
    bank: { name: 'Sample Bank', branch: 'Tateishi (123)', account_type: 'Ordinary', account_number: '1234567', account_holder: 'Cha Jewels Co., Ltd.' },
    wallet: null,
    note_ja: null,
    note_en: null,
  },
]
const due = '2026-09-27T05:00:00.000Z'
const schedule = [
  { installment_number: 1, due_date: '2026-10-24', amount: 28000 },
  { installment_number: 2, due_date: '2026-11-24', amount: 28000 },
  { installment_number: 3, due_date: '2026-12-24', amount: 28000 },
]
const orderUrl = 'https://www.chajewelsjp.com/account/orders/preview'
const planUrl = 'https://www.chajewelsjp.com/account/layaway/preview'
const shopUrl = 'https://www.chajewelsjp.com'

export const STOREFRONT_PREVIEWS: Record<string, StorefrontPreview> = {
  'storefront-order-reserved-ja': {
    displayName: 'Web order — reservation received (JA + EN)',
    component: OrderReservedEmail,
    subject: orderReservedSubject('CJ-W-000123'),
    previewData: { lang: 'ja', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, orderUrl },
  },
  'storefront-order-reserved-en': {
    displayName: 'Web order — reservation received (EN)',
    component: OrderReservedEmail,
    subject: orderReservedSubject('CJ-W-000123'),
    previewData: { lang: 'en', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, orderUrl },
  },
  'storefront-order-ready-ja': {
    displayName: 'Web order — confirmed, ready for payment (JA + EN)',
    component: OrderConfirmationEmail,
    subject: orderReadySubject('CJ-W-000123'),
    previewData: { lang: 'ja', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, methods, transferDueAt: due, region: 'JP', orderUrl, variant: 'ready' },
  },
  'storefront-order-ready-en': {
    displayName: 'Web order — confirmed, ready for payment (EN)',
    component: OrderConfirmationEmail,
    subject: orderReadySubject('CJ-W-000123'),
    previewData: { lang: 'en', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, methods, transferDueAt: due, region: 'JP', orderUrl, variant: 'ready' },
  },
  // A peso full-payment order (2026-09-25): lines without prices, shipping and
  // total in ₱, the Philippine accounts (owner decision D1).
  'storefront-order-reserved-php-en': {
    displayName: 'Web order in pesos — reservation received (EN)',
    component: OrderReservedEmail,
    subject: orderReservedSubject('CJ-W-000125'),
    previewData: { lang: 'en', reference: 'CJ-W-000125', items, shippingJpy: 1848, totalJpy: 27076, currency: 'PHP', orderUrl },
  },
  'storefront-order-ready-php-ja': {
    displayName: 'Web order in pesos — confirmed, ready for payment (JA + EN)',
    component: OrderConfirmationEmail,
    subject: orderReadySubject('CJ-W-000125'),
    previewData: { lang: 'ja', reference: 'CJ-W-000125', items, shippingJpy: 1848, totalJpy: 27076, currency: 'PHP', methods, transferDueAt: due, region: 'OVERSEAS', orderUrl, variant: 'ready' },
  },
  'storefront-order-cant-supply-ja': {
    displayName: "Web order — can't supply (JA + EN)",
    component: OrderCancelledEmail,
    subject: orderCancelledSubject('CJ-W-000123'),
    previewData: { lang: 'ja', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, reason: 'The piece did not pass our final inspection.', refundStatus: null, refundNote: null, orderUrl },
  },
  'storefront-order-reservation-lapsed-ja': {
    displayName: 'Web order — not confirmed in 72h (JA + EN)',
    component: OrderReservationLapsedEmail,
    subject: orderReservationLapsedSubject('CJ-W-000123'),
    previewData: { lang: 'ja', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, shopUrl },
  },
  'storefront-order-reservation-lapsed-en': {
    displayName: 'Web order — not confirmed in 72h (EN)',
    component: OrderReservationLapsedEmail,
    subject: orderReservationLapsedSubject('CJ-W-000123'),
    previewData: { lang: 'en', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, shopUrl },
  },
  'storefront-layaway-reserved': {
    displayName: 'Web layaway — reservation received (EN only)',
    component: LayawayReservedEmail,
    subject: layawayReservedSubject('CJ-W-000124'),
    previewData: { reference: 'CJ-W-000124', currency: 'JPY', totalAmount: 120000, deposit: 36000, termMonths: 3, planUrl },
  },
  'storefront-layaway-ready': {
    displayName: 'Web layaway — confirmed, send your deposit (EN only)',
    component: LayawayPlanCreatedEmail,
    subject: layawayReadySubject('CJ-W-000124'),
    previewData: { lang: 'en', reference: 'CJ-W-000124', currency: 'JPY', totalAmount: 120000, deposit: 36000, termMonths: 3, schedule, methods, transferDueAt: due, region: 'JP', planUrl, variant: 'ready' },
  },
  'storefront-layaway-declined': {
    displayName: "Web layaway — can't supply (EN only)",
    component: LayawayDeclinedEmail,
    subject: layawayDeclinedSubject('CJ-W-000124', 'declined'),
    previewData: { reference: 'CJ-W-000124', kind: 'declined', reason: 'The piece did not pass our final inspection.', shopUrl },
  },
  'storefront-layaway-reservation-lapsed': {
    displayName: 'Web layaway — not confirmed in 72h (EN only)',
    component: LayawayDeclinedEmail,
    subject: layawayDeclinedSubject('CJ-W-000124', 'lapsed'),
    previewData: { reference: 'CJ-W-000124', kind: 'lapsed', shopUrl },
  },
  // Stage D payment reminders (2026-10-04, docs/WEB-PAYMENT-REMINDERS.md).
  // Sent by web-payment-reminder-sweep only; the layaway one has no language.
  'storefront-order-payment-due-php-ja': {
    displayName: 'Web order in pesos — payment reminder (JA + EN)',
    component: OrderPaymentDueEmail,
    subject: orderPaymentDueSubject('CJ-W-000125'),
    previewData: { lang: 'ja', reference: 'CJ-W-000125', currency: 'PHP', amount: 27076, methods, transferDueAt: due, region: 'OVERSEAS', orderUrl },
  },
  'storefront-order-payment-due-en': {
    displayName: 'Web order — payment reminder (EN)',
    component: OrderPaymentDueEmail,
    subject: orderPaymentDueSubject('CJ-W-000123'),
    previewData: { lang: 'en', reference: 'CJ-W-000123', currency: 'JPY', amount: 72980, methods, transferDueAt: due, region: 'JP', orderUrl },
  },
  'storefront-layaway-deposit-due': {
    displayName: 'Web layaway — deposit reminder (EN only)',
    component: LayawayDepositDueEmail,
    subject: layawayDepositDueSubject('CJ-W-000124'),
    previewData: { reference: 'CJ-W-000124', currency: 'JPY', deposit: 36000, methods, transferDueAt: due, region: 'JP', planUrl },
  },
}
