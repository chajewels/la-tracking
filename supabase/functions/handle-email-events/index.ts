import { createClient } from 'npm:@supabase/supabase-js@2'
import { createEmailWebhookHandler } from 'npm:@lovable.dev/email-js@0.1.0'
import { withdrawCartRemindersForAddress } from '../_shared/cart-reminder-unsubscribe.ts'

// Lovable email events. Suppression itself (suppressed_emails) is written by
// handle-email-suppression; this handler reacts to the events only.
const handler = createEmailWebhookHandler({
  apiKey: Deno.env.get('LOVABLE_API_KEY')!,
  on: {
    // Throw on failure so the delivery is retried.
    'email.bounced': async (event) => {
      console.log('Email bounced', { event_id: event.event_id })
    },
    'email.complaint': async (event) => {
      console.log('Email complaint', { event_id: event.event_id })
    },
    // Cart reminders (docs/CART-REMINDERS.md): the provider's unsubscribe
    // withdraws our promotional consent for that address and rings a staff
    // bell — the address may now be suppressed for order emails too.
    'email.unsubscribed': async (event) => {
      console.log('Email unsubscribed', { event_id: event.event_id })
      const recipient = (event as { data?: { recipient?: string } }).data?.recipient
      if (recipient) {
        const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        await withdrawCartRemindersForAddress(supabase, recipient, 'handle-email-events')
      }
    },
  },
})

Deno.serve((req) => handler(req))
