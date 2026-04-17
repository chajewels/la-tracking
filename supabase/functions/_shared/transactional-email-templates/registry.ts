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

export const TEMPLATES: Record<string, TemplateEntry> = {
  'payment-reminder': paymentReminder,
  'payment-submitted': paymentSubmitted,
  'payment-confirmed': paymentConfirmed,
  'payment-rejected': paymentRejected,
  'payment-needs-clarification': paymentNeedsClarification,
}
