import { createEmailWebhookHandler } from 'npm:@lovable.dev/email-js@0.1.0'
import { createClient } from 'npm:@supabase/supabase-js@2'

// Terminal delivery outcomes from Lovable's managed email delivery.
// These writes are notification-only bookkeeping in the app's own tables —
// Lovable enforces suppression server-side at send time.

// deno-lint-ignore no-explicit-any
function db(): any {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )
}

type Reason = 'bounce' | 'complaint' | 'unsubscribe'

function statusFor(reason: Reason): 'bounced' | 'complained' | 'suppressed' {
  if (reason === 'bounce') return 'bounced'
  if (reason === 'complaint') return 'complained'
  return 'suppressed'
}

function messageFor(reason: Reason): string {
  switch (reason) {
    case 'bounce':
      return 'Permanent bounce — email address is invalid or rejected'
    case 'complaint':
      return 'Spam complaint — recipient marked email as spam'
    case 'unsubscribe':
      return 'Recipient unsubscribed'
  }
}

async function record(
  eventId: string,
  recipient: string,
  reason: Reason,
  messageId?: string | null,
): Promise<void> {
  const supabase = db()
  const email = recipient.toLowerCase()

  // Idempotent on email — safe for webhook redeliveries.
  const { error: suppressError } = await supabase
    .from('suppressed_emails')
    .upsert({ email, reason, metadata: null }, { onConflict: 'email' })

  if (suppressError) {
    console.error('[handle-email-events] suppressed_emails upsert failed', {
      event_id: eventId,
      code: (suppressError as { code?: string }).code,
      message: suppressError.message,
    })
    // Throw so the delivery is retried.
    throw new Error('Failed to record suppression')
  }

  const { error: logError } = await supabase.from('email_send_log').insert({
    message_id: messageId ?? null,
    template_name: 'system',
    recipient_email: email,
    status: statusFor(reason),
    error_message: messageFor(reason),
    metadata: null,
  })

  if (logError) {
    console.error('[handle-email-events] email_send_log insert failed', {
      event_id: eventId,
      code: (logError as { code?: string }).code,
      message: logError.message,
    })
    throw new Error('Failed to record delivery event')
  }
}

const handler = createEmailWebhookHandler({
  apiKey: Deno.env.get('LOVABLE_API_KEY')!,
  on: {
    'email.bounced': async (event) => {
      await record(
        event.event_id,
        event.data.recipient,
        'bounce',
        event.data.message_id,
      )
    },
    'email.complaint': async (event) => {
      await record(
        event.event_id,
        event.data.recipient,
        'complaint',
        event.data.message_id,
      )
    },
    'email.unsubscribed': async (event) => {
      await record(
        event.event_id,
        event.data.recipient,
        'unsubscribe',
        event.data.message_id,
      )
    },
  },
})

Deno.serve((req) => handler(req))
