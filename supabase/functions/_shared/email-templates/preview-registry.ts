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
import { CartReminderEmail, cartReminderSubject } from './cart-reminder.tsx'
import { OrderPaymentNotAcceptedEmail, orderPaymentNotAcceptedSubject } from './order-payment-not-accepted.tsx'
import { OrderUpdateEmail, orderUpdateSubject } from './order-update.tsx'
import { LayawayUpdateEmail, layawayUpdateSubject } from './layaway-update.tsx'
import { WebLoyaltyEmail, webLoyaltySubject } from './web-loyalty.tsx'
import { StoreCreditIssuedEmail, storeCreditIssuedSubject } from './store-credit-issued.tsx'

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
const cartUrl = 'https://www.chajewelsjp.com/cart/restore'
const unsubscribeUrl = 'https://www.chajewelsjp.com/cart-reminders/unsubscribe?token=preview'
const cartItems = [
  {
    name: 'Pearl drop earrings', name_ja: 'パールドロップピアス', size: null, stone: 'Akoya pearl', qty: 1,
    image_url: null, price_jpy: 68000, price_php: 27016, down_payment_jpy: 20400, down_payment_php: 8105, down_payment_pct: 0.3,
  },
]

export const STOREFRONT_PREVIEWS: Record<string, StorefrontPreview> = {
  'storefront-order-reserved-ja': {
    displayName: 'Web order — reservation received (JA + EN)',
    component: OrderReservedEmail,
    subject: orderReservedSubject('CJ-W-000123', 'ja'),
    previewData: { lang: 'ja', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, orderUrl },
  },
  'storefront-order-reserved-en': {
    displayName: 'Web order — reservation received (EN)',
    component: OrderReservedEmail,
    subject: orderReservedSubject('CJ-W-000123', 'en'),
    previewData: { lang: 'en', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, orderUrl },
  },
  'storefront-order-ready-ja': {
    displayName: 'Web order — confirmed, ready for payment (JA + EN)',
    component: OrderConfirmationEmail,
    subject: orderReadySubject('CJ-W-000123', 'ja'),
    previewData: { lang: 'ja', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, methods, transferDueAt: due, region: 'JP', orderUrl, variant: 'ready' },
  },
  'storefront-order-ready-en': {
    displayName: 'Web order — confirmed, ready for payment (EN)',
    component: OrderConfirmationEmail,
    subject: orderReadySubject('CJ-W-000123', 'en'),
    previewData: { lang: 'en', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, methods, transferDueAt: due, region: 'JP', orderUrl, variant: 'ready' },
  },
  // A peso full-payment order (2026-09-25): lines without prices, shipping and
  // total in ₱, the Philippine accounts (owner decision D1).
  'storefront-order-reserved-php-en': {
    displayName: 'Web order in pesos — reservation received (EN)',
    component: OrderReservedEmail,
    subject: orderReservedSubject('CJ-W-000125', 'en'),
    previewData: { lang: 'en', reference: 'CJ-W-000125', items, shippingJpy: 1848, totalJpy: 27076, currency: 'PHP', orderUrl },
  },
  'storefront-order-ready-php-ja': {
    displayName: 'Web order in pesos — confirmed, ready for payment (JA + EN)',
    component: OrderConfirmationEmail,
    subject: orderReadySubject('CJ-W-000125', 'ja'),
    previewData: { lang: 'ja', reference: 'CJ-W-000125', items, shippingJpy: 1848, totalJpy: 27076, currency: 'PHP', methods, transferDueAt: due, region: 'OVERSEAS', orderUrl, variant: 'ready' },
  },
  'storefront-order-cant-supply-ja': {
    displayName: "Web order — can't supply (JA + EN)",
    component: OrderCancelledEmail,
    subject: orderCancelledSubject('CJ-W-000123', 'ja'),
    previewData: { lang: 'ja', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, reason: 'The piece did not pass our final inspection.', refundStatus: null, refundNote: null, orderUrl },
  },
  'storefront-order-reservation-lapsed-ja': {
    displayName: 'Web order — not confirmed in 72h (JA + EN)',
    component: OrderReservationLapsedEmail,
    subject: orderReservationLapsedSubject('CJ-W-000123', 'ja'),
    previewData: { lang: 'ja', reference: 'CJ-W-000123', items, shippingJpy: 4980, totalJpy: 72980, shopUrl },
  },
  'storefront-order-reservation-lapsed-en': {
    displayName: 'Web order — not confirmed in 72h (EN)',
    component: OrderReservationLapsedEmail,
    subject: orderReservationLapsedSubject('CJ-W-000123', 'en'),
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
    previewData: { reference: 'CJ-W-000124', currency: 'JPY', totalAmount: 120000, deposit: 36000, termMonths: 3, schedule, methods, transferDueAt: due, region: 'JP', planUrl, variant: 'ready' },
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
    subject: orderPaymentDueSubject('CJ-W-000125', 'ja'),
    previewData: { lang: 'ja', reference: 'CJ-W-000125', currency: 'PHP', amount: 27076, methods, transferDueAt: due, region: 'OVERSEAS', orderUrl },
  },
  // A rejected payment on a web order (owner 2026-10-05; _shared/payment-rejected-email.ts).
  'storefront-order-payment-not-accepted-paidy-ja': {
    displayName: 'Web order — Paidy payment rejected by staff (JA + EN)',
    component: OrderPaymentNotAcceptedEmail,
    subject: orderPaymentNotAcceptedSubject('CJ-W-000126', 'ja'),
    previewData: { lang: 'ja', reference: 'CJ-W-000126', method: 'paidy', kind: 'staff', amount: 980, currency: 'JPY', reason: 'お届け先の番地を確認させてください。', remaining: 980, transferDueAt: due, region: 'JP', orderUrl },
  },
  'storefront-order-payment-not-accepted-card-en': {
    displayName: 'Web order — card hold released by Square (EN)',
    component: OrderPaymentNotAcceptedEmail,
    subject: orderPaymentNotAcceptedSubject('CJ-W-000127', 'en'),
    previewData: { lang: 'en', reference: 'CJ-W-000127', method: 'card', kind: 'provider_ended', amount: 18980, currency: 'JPY', reason: null, remaining: 18980, transferDueAt: due, region: 'JP', orderUrl },
  },
  'storefront-order-payment-not-accepted-transfer-en': {
    displayName: 'Web order — bank transfer rejected by staff (EN)',
    component: OrderPaymentNotAcceptedEmail,
    subject: orderPaymentNotAcceptedSubject('CJ-W-000128', 'en'),
    previewData: { lang: 'en', reference: 'CJ-W-000128', method: 'transfer', kind: 'staff', amount: 72980, currency: 'JPY', reason: 'The receipt shows a different amount. Please reply with the receipt for ¥72,980.', remaining: 72980, transferDueAt: due, region: 'JP', orderUrl },
  },
  // Payment lifecycle H4: generic web-order / web-layaway updates
  // (_shared/order-update-email.ts). One entry per variant.
  'storefront-order-update-needs-info-ja': {
    displayName: 'Web order — payment needs clarification (JA + EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('needs_info', 'CJ-W-000129', 'ja'),
    previewData: { lang: 'ja', variant: 'needs_info', reference: 'CJ-W-000129', currency: 'JPY', amount: 72980, message: 'お振込名義を教えてください。', deadline: due, region: 'JP', orderUrl },
  },
  'storefront-order-update-deadline-moved-ja': {
    displayName: 'Web order — payment deadline moved (JA + EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('deadline_moved', 'CJ-W-000129', 'ja'),
    previewData: { lang: 'ja', variant: 'deadline_moved', reference: 'CJ-W-000129', currency: 'JPY', amount: 72980, deadline: due, region: 'JP', orderUrl },
  },
  'storefront-order-update-shipped-en': {
    displayName: 'Web order — shipped, with tracking (EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('shipped', 'CJ-W-000129', 'en'),
    previewData: { lang: 'en', variant: 'shipped', reference: 'CJ-W-000129', currency: 'JPY', region: 'JP', courier: 'Yamato Transport', trackingNumber: '4725-7551-6733', trackingUrl: 'https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno=472575516733', orderUrl },
  },
  'storefront-order-update-details-received-ja': {
    displayName: 'Web order — staff recorded her payment, awaiting check (JA + EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('details_received', 'CJ-W-000129', 'ja'),
    previewData: { lang: 'ja', variant: 'details_received', reference: 'CJ-W-000129', currency: 'JPY', amount: 72980, region: 'JP', orderUrl },
  },
  'storefront-layaway-update-rejected': {
    displayName: 'Web layaway — payment rejected (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('rejected', 'CJ-W-000124'),
    previewData: { variant: 'rejected', reference: 'CJ-W-000124', currency: 'PHP', amount: 8000, message: 'The receipt shows a different amount.', planUrl },
  },
  'storefront-layaway-update-needs-info': {
    displayName: 'Web layaway — payment needs clarification (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('needs_info', 'CJ-W-000124'),
    previewData: { variant: 'needs_info', reference: 'CJ-W-000124', currency: 'JPY', amount: 36000, message: 'Please send the receipt for the second transfer.', planUrl },
  },
  'storefront-layaway-update-deadline-moved': {
    displayName: 'Web layaway — deposit deadline moved (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('deadline_moved', 'CJ-W-000124'),
    previewData: { variant: 'deadline_moved', reference: 'CJ-W-000124', currency: 'JPY', amount: 36000, deadline: due, planUrl },
  },
  'storefront-layaway-update-shipped': {
    displayName: 'Web layaway — shipped, with tracking (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('shipped', 'CJ-W-000124'),
    previewData: { variant: 'shipped', reference: 'CJ-W-000124', currency: 'PHP', courier: 'Pabitbit', trackingNumber: 'LBC123456', trackingUrl: 'https://www.lbcexpress.com/track/?tracking_no=LBC123456', planUrl },
  },
  // Addendum §9 (owner directive 2026-10-06): every new customer email.
  'storefront-order-update-payment-submitted-card-ja': {
    displayName: 'Web order — card payment received, hold not charged yet (JA + EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('payment_submitted', 'CJ-W-000130', 'ja'),
    previewData: { lang: 'ja', variant: 'payment_submitted', reference: 'CJ-W-000130', currency: 'JPY', amount: 72980, method: 'card', cardBrand: 'VISA', cardLast4: '1111', holdUntil: due, region: 'JP', orderUrl },
  },
  'storefront-order-update-payment-submitted-paidy-ja': {
    displayName: 'Web order — Paidy payment received (JA + EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('payment_submitted', 'CJ-W-000130', 'ja'),
    previewData: { lang: 'ja', variant: 'payment_submitted', reference: 'CJ-W-000130', currency: 'JPY', amount: 72980, method: 'paidy', region: 'JP', orderUrl },
  },
  'storefront-order-update-payment-voided-ja': {
    displayName: 'Web order — payment record voided by staff (JA + EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('payment_voided', 'CJ-W-000130', 'ja'),
    previewData: { lang: 'ja', variant: 'payment_voided', reference: 'CJ-W-000130', currency: 'JPY', amount: 30000, message: '二重に記録されていたため', balance: 42980, region: 'JP', orderUrl },
  },
  'storefront-order-update-payment-restored-en': {
    displayName: 'Web order — payment record restored (EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('payment_restored', 'CJ-W-000130', 'en'),
    previewData: { lang: 'en', variant: 'payment_restored', reference: 'CJ-W-000130', currency: 'JPY', amount: 30000, balance: 12980, region: 'JP', orderUrl },
  },
  'storefront-order-update-refund-issued-ja': {
    displayName: 'Web order — refund sent (staff marked it issued) (JA + EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('refund_issued', 'CJ-W-000130', 'ja'),
    previewData: { lang: 'ja', variant: 'refund_issued', reference: 'CJ-W-000130', currency: 'JPY', amount: 72980, refundMethod: 'bank_transfer', refundDate: '2026-10-06', region: 'JP', orderUrl },
  },
  'storefront-order-update-refund-received-ja': {
    displayName: 'Web order — refund made in the Square / Paidy dashboard (JA + EN)',
    component: OrderUpdateEmail,
    subject: orderUpdateSubject('refund_received', 'CJ-W-000130', 'ja'),
    previewData: { lang: 'ja', variant: 'refund_received', reference: 'CJ-W-000130', currency: 'JPY', amount: 72980, refundMethod: 'card', region: 'JP', orderUrl },
  },
  'storefront-order-cancelled-neutral-ja': {
    displayName: 'Web order — cancelled automatically, payment not confirmed (JA + EN)',
    component: OrderCancelledEmail,
    subject: orderCancelledSubject('CJ-W-000130', 'ja'),
    previewData: { lang: 'ja', reference: 'CJ-W-000130', items, shippingJpy: 0, totalJpy: 72980, reason: 'x', reasonByLang: { ja: 'お支払いを確認できなかったため', en: 'We could not confirm your payment' }, refundStatus: null, refundNote: null, orderUrl },
  },
  'storefront-layaway-update-details-received': {
    displayName: 'Web layaway — payment details received (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('details_received', 'CJ-W-000124'),
    previewData: { variant: 'details_received', reference: 'CJ-W-000124', currency: 'JPY', amount: 28000, planUrl },
  },
  'storefront-layaway-update-reminder': {
    displayName: 'Web layaway — instalment reminder, grace period (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('reminder', 'CJ-W-000124', { reminderStage: 'grace_period' }),
    previewData: { variant: 'reminder', reminderStage: 'grace_period', reference: 'CJ-W-000124', currency: 'JPY', amount: 28000, dueDate: '2026-10-24', graceEnd: '2026-10-31', daysOverdue: 3, planUrl },
  },
  'storefront-layaway-update-penalty': {
    displayName: 'Web layaway — late fee applied (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('penalty', 'CJ-W-000124', { penaltyStage: 'applied' }),
    previewData: { variant: 'penalty', penaltyStage: 'applied', reference: 'CJ-W-000124', currency: 'JPY', amount: 1000, totalPenalty: 1000, dueDate: '2026-10-24', daysOverdue: 8, remaining: 85000, planUrl },
  },
  'storefront-layaway-update-penalty-final': {
    displayName: 'Web layaway — final notice (P8) (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('penalty', 'CJ-W-000124', { penaltyStage: 'P8' }),
    previewData: { variant: 'penalty', penaltyStage: 'P8', reference: 'CJ-W-000124', currency: 'PHP', totalPenalty: 3000, dueDate: '2026-07-24', daysOverdue: 92, remaining: 45000, planUrl },
  },
  'storefront-layaway-update-penalty-reinstated': {
    displayName: 'Web layaway — waived late fee reinstated (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('penalty_reinstated', 'CJ-W-000124'),
    previewData: { variant: 'penalty_reinstated', reference: 'CJ-W-000124', currency: 'JPY', amount: 1000, remaining: 85000, planUrl },
  },
  'storefront-layaway-update-penalty-waived': {
    displayName: 'Web layaway — late fee waived (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('penalty_waived', 'CJ-W-000124'),
    previewData: { variant: 'penalty_waived', reference: 'CJ-W-000124', currency: 'JPY', amount: 1000, graceEnd: '2026-10-31', remaining: 84000, planUrl },
  },
  'storefront-layaway-update-payment-voided': {
    displayName: 'Web layaway — payment voided (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('payment_voided', 'CJ-W-000124'),
    previewData: { variant: 'payment_voided', reference: 'CJ-W-000124', currency: 'JPY', amount: 28000, message: 'Duplicate record — the original payment was already recorded.', remaining: 56000, planUrl },
  },
  'storefront-layaway-update-reactivated': {
    displayName: 'Web layaway — plan reactivated (EN only)',
    component: LayawayUpdateEmail,
    subject: layawayUpdateSubject('reactivated', 'CJ-W-000124'),
    previewData: { variant: 'reactivated', reference: 'CJ-W-000124', currency: 'JPY', deadline: '2026-12-24', remaining: 84000, planUrl },
  },
  'storefront-web-loyalty-earned-ja': {
    displayName: 'Web order — loyalty points earned (JA + EN)',
    component: WebLoyaltyEmail,
    subject: webLoyaltySubject('earned', 'CJ-W-000130', 'ja'),
    previewData: { lang: 'ja', variant: 'earned', reference: 'CJ-W-000130', points: 1400, balance: 13400, level: 'Radiant', multiplier: 2, loyaltyUrl: 'https://www.chajewelsjp.com/loyalty' },
  },
  'storefront-web-loyalty-tier-upgrade-en': {
    displayName: 'Web plan — membership level up (EN)',
    component: WebLoyaltyEmail,
    subject: webLoyaltySubject('tier_upgrade', 'CJ-W-000124', 'en'),
    previewData: { lang: 'en', variant: 'tier_upgrade', reference: 'CJ-W-000124', previousLevel: 'Glimmer', level: 'Radiant', multiplier: 2, balance: 13400, loyaltyUrl: 'https://www.chajewelsjp.com/loyalty' },
  },
  'storefront-store-credit-issued-ja': {
    displayName: 'Store credit issued by staff (JA + EN)',
    component: StoreCreditIssuedEmail,
    subject: storeCreditIssuedSubject('ja'),
    previewData: { lang: 'ja', amount: 25000, currency: 'JPY', expiresAt: '2027-10-06T00:00:00.000Z' },
  },
  'storefront-order-payment-due-en': {
    displayName: 'Web order — payment reminder (EN)',
    component: OrderPaymentDueEmail,
    subject: orderPaymentDueSubject('CJ-W-000123', 'en'),
    previewData: { lang: 'en', reference: 'CJ-W-000123', currency: 'JPY', amount: 72980, methods, transferDueAt: due, region: 'JP', orderUrl },
  },
  'storefront-layaway-deposit-due': {
    displayName: 'Web layaway — deposit reminder (EN only)',
    component: LayawayDepositDueEmail,
    subject: layawayDepositDueSubject('CJ-W-000124'),
    previewData: { reference: 'CJ-W-000124', currency: 'JPY', deposit: 36000, methods, transferDueAt: due, region: 'JP', planUrl },
  },
  // Cart reminders (stages A/B, docs/CART-REMINDERS.md). ONE language per
  // email. The figures below are sample Hub output, the shape
  // cart-reminder-emails.ts attaches at send time (never computed in-template).
  'storefront-cart-reminder-ja': {
    displayName: 'Cart reminder — stage A (JA, yen only)',
    component: CartReminderEmail,
    subject: cartReminderSubject('ja'),
    previewData: { lang: 'ja', form: 'stage_a', items: cartItems, reserveFirst: true, reachedCheckout: false, cartUrl, unsubscribeUrl },
  },
  'storefront-cart-reminder-en': {
    displayName: 'Cart reminder — stage A (EN, ¥ (₱) + reserve line)',
    component: CartReminderEmail,
    subject: cartReminderSubject('en'),
    previewData: { lang: 'en', form: 'stage_a', items: cartItems, reserveFirst: true, reachedCheckout: false, cartUrl, unsubscribeUrl },
  },
  'storefront-cart-reminder-en-layaway': {
    displayName: 'Cart reminder — stage B, layaway chosen (EN, plan panel)',
    component: CartReminderEmail,
    subject: cartReminderSubject('en'),
    previewData: {
      lang: 'en', form: 'layaway', items: cartItems, reserveFirst: true, reachedCheckout: true, cartUrl, unsubscribeUrl,
      plan: { currency: 'JPY', deposit: 20400, monthly: 15867, lastMonth: 15866, termMonths: 3, total: 68000 },
    },
  },
  'storefront-cart-reminder-ja-php': {
    displayName: 'Cart reminder — stage B, full payment in pesos (JA)',
    component: CartReminderEmail,
    subject: cartReminderSubject('ja'),
    previewData: { lang: 'ja', form: 'full_php', items: cartItems, reserveFirst: true, reachedCheckout: true, cartUrl, unsubscribeUrl },
  },
}
