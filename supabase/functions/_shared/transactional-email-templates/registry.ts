/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'

export interface TemplateEntry {
  component: React.ComponentType<any>
  subject: string | ((data: Record<string, any>) => string)
  to?: string
  displayName?: string
  previewData?: Record<string, any>
}

import { template as paymentReminder } from './payment-reminder.tsx'
import { template as paymentSubmitted } from './payment-submitted.tsx'
import { template as paymentConfirmed } from './payment-confirmed.tsx'
import { template as paymentRejected } from './payment-rejected.tsx'
import { template as paymentNeedsClarification } from './payment-needs-clarification.tsx'
import { template as paymentReceipt } from './payment-receipt.tsx'
import { template as paymentVoided } from './payment-voided.tsx'
import { template as penaltyApplied } from './penalty-applied.tsx'
import { template as penaltyEscalation } from './penalty-escalation.tsx'
import { template as penaltyWaived } from './penalty-waived.tsx'
import { template as accountForfeited } from './account-forfeited.tsx'
import { template as extensionGranted } from './extension-granted.tsx'
import { template as extensionRequested } from './extension-requested.tsx'
import { template as cashPaymentSubmitted } from './cash-payment-submitted.tsx'
import { template as cashPaymentConfirmed } from './cash-payment-confirmed.tsx'
import { template as cashOrderExpired } from './cash-order-expired.tsx'
import { template as loyaltyWelcome } from './loyalty-welcome.tsx'
import { template as loyaltyEarned } from './loyalty-earned.tsx'
import { template as loyaltyBonus } from './loyalty-bonus.tsx'
import { template as loyaltyTierUpgrade } from './loyalty-tier-upgrade.tsx'
import { template as loyaltyTierDowngrade } from './loyalty-tier-downgrade.tsx'
import { template as loyaltyTierRevoked } from './loyalty-tier-revoked.tsx'
import { template as loyaltyPreExpire } from './loyalty-pre-expire.tsx'
import { template as loyaltyExpireDeduct } from './loyalty-expire-deduct.tsx'
import { template as loyaltyRedeem } from './loyalty-redeem.tsx'
import { template as loyaltyRedemptionVoided } from './loyalty-redemption-voided.tsx'
import { template as loyaltyBroadcast } from './loyalty-broadcast.tsx'
import { PortalSetupInviteEmail } from './portal-setup-invite.tsx'

export const TEMPLATES: Record<string, TemplateEntry> = {
  'payment-reminder': paymentReminder,
  'payment-submitted': paymentSubmitted,
  'payment-confirmed': paymentConfirmed,
  'payment-rejected': paymentRejected,
  'payment-needs-clarification': paymentNeedsClarification,
  'payment-receipt': paymentReceipt,
  'payment-voided': paymentVoided,
  'penalty-applied': penaltyApplied,
  'penalty-escalation': penaltyEscalation,
  'penalty-waived': penaltyWaived,
  'account-forfeited': accountForfeited,
  'extension-granted': extensionGranted,
  'extension-requested': extensionRequested,
  'cash-payment-submitted': cashPaymentSubmitted,
  'cash-payment-confirmed': cashPaymentConfirmed,
  'cash-order-expired': cashOrderExpired,
  'loyalty-welcome': loyaltyWelcome,
  'loyalty-earned': loyaltyEarned,
  'loyalty-bonus': loyaltyBonus,
  'loyalty-tier-upgrade': loyaltyTierUpgrade,
  'loyalty-tier-downgrade': loyaltyTierDowngrade,
  'loyalty-tier-revoked': loyaltyTierRevoked,
  'loyalty-pre-expire': loyaltyPreExpire,
  'loyalty-expire-deduct': loyaltyExpireDeduct,
  'loyalty-redeem': loyaltyRedeem,
  'loyalty-redemption-voided': loyaltyRedemptionVoided,
  'loyalty-broadcast': loyaltyBroadcast,
  'portal-setup-invite': {
    component: PortalSetupInviteEmail,
    subject: 'Set up your Cha Jewels portal access',
  },
  'payment-grace-period': {
    ...paymentReminder,
    subject: (data: Record<string, any>) =>
      `⏳ Grace Period Reminder — INV #${data.invoiceNumber || ''}`,
    displayName: 'Payment Grace Period',
    previewData: {
      customerName: 'Maria Santos',
      invoiceNumber: '18456',
      dueDate: 'Apr 15, 2026',
      amountDue: '6,500',
      currency: 'JPY',
      type: 'grace_period',
      graceEndDate: 'Apr 22, 2026',
      portalUrl: 'https://portal.chajewelsjp.com/portal?invoice=18456',
    },
  },
}
