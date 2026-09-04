// Managed app-email send wrapper.
//
// Transport: Lovable's managed email API via the scaffolded sendTemplateEmail
// helper (renders the registered React Email template and sends synchronously).
// Suppression, retries, rate limits and unsubscribe are enforced by Lovable.
//
// App behavior preserved from the retired queue: every attempt appends a row to
// email_send_log ('sent' | 'suppressed' | 'failed'). That table is a log only —
// it never gates a send.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { EmailAPIError } from 'npm:@lovable.dev/email-js@0.1.0'
import { sendTemplateEmail } from './transactional-email-templates/send-email.ts'

export interface SendAppEmailOptions {
  templateData?: Record<string, unknown>
  idempotencyKey?: string
  replyTo?: string
}

export interface SendAppEmailResult {
  sent: boolean
  reason?: 'recipient_suppressed' | 'failed'
  error?: string
}

// deno-lint-ignore no-explicit-any
function logClient(): any {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )
}

async function writeLog(
  templateName: string,
  recipientEmail: string,
  status: 'sent' | 'suppressed' | 'failed',
  idempotencyKey?: string,
  errorMessage?: string,
): Promise<void> {
  try {
    const { error } = await logClient().from('email_send_log').insert({
      message_id: null,
      idempotency_key: idempotencyKey ?? null,
      template_name: templateName,
      recipient_email: recipientEmail,
      status,
      error_message: errorMessage ? errorMessage.slice(0, 1000) : null,
    })
    if (error) {
      console.error('[send-app-email] email_send_log insert failed', {
        code: (error as { code?: string }).code,
        message: error.message,
      })
    }
  } catch (e) {
    console.error('[send-app-email] email_send_log insert threw', {
      message: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Sends one registered app-email template to one recipient through Lovable's
 * managed email API. Never throws — mail must never fail the caller's feature
 * work (the retired queue had the same fire-and-forget contract).
 */
export async function sendAppEmail(
  templateName: string,
  recipientEmail: string,
  options: SendAppEmailOptions = {},
): Promise<SendAppEmailResult> {
  const attempt = async (): Promise<SendAppEmailResult> => {
    const result = await sendTemplateEmail(templateName, recipientEmail, {
      templateData: options.templateData as Record<string, unknown> | undefined,
      idempotencyKey: options.idempotencyKey,
      replyTo: options.replyTo,
    })
    if (!result.sent) {
      await writeLog(
        templateName,
        recipientEmail,
        'suppressed',
        options.idempotencyKey,
        'Recipient suppressed by managed delivery',
      )
      return { sent: false, reason: 'recipient_suppressed' }
    }
    await writeLog(templateName, recipientEmail, 'sent', options.idempotencyKey)
    return { sent: true }
  }

  try {
    return await attempt()
  } catch (error) {
    // Rate limited: wait the advertised window once, then retry the send.
    if (error instanceof EmailAPIError && error.status === 429) {
      const waitSeconds = error.retryAfterSeconds ?? 60
      console.warn('[send-app-email] rate limited, waiting before retry', {
        templateName,
        waitSeconds,
      })
      await new Promise((r) => setTimeout(r, waitSeconds * 1000))
      try {
        return await attempt()
      } catch (retryError) {
        const message =
          retryError instanceof Error ? retryError.message : String(retryError)
        console.error('[send-app-email] send failed after rate-limit retry', {
          templateName,
          message,
        })
        await writeLog(
          templateName,
          recipientEmail,
          'failed',
          options.idempotencyKey,
          message,
        )
        return { sent: false, reason: 'failed', error: message }
      }
    }

    const message = error instanceof Error ? error.message : String(error)
    console.error('[send-app-email] send failed', { templateName, message })
    await writeLog(
      templateName,
      recipientEmail,
      'failed',
      options.idempotencyKey,
      message,
    )
    return { sent: false, reason: 'failed', error: message }
  }
}

/**
 * Fetch-shaped adapter used by feature functions that previously POSTed to the
 * retired send-transactional-email function. It sends through the managed API
 * (see sendAppEmail) and returns a Response so existing `.ok` / `.status` /
 * `.text()` handling at the call sites keeps working unchanged.
 */
export async function postAppEmail(payload: {
  templateName?: string | null
  template_name?: string | null
  recipientEmail?: string | null
  recipient_email?: string | null
  idempotencyKey?: string | null
  idempotency_key?: string | null
  templateData?: Record<string, unknown>
  replyTo?: string | null
}): Promise<Response> {
  const templateName = payload.templateName ?? payload.template_name ?? ''
  const recipient = payload.recipientEmail ?? payload.recipient_email ?? ''
  const idempotencyKey = payload.idempotencyKey ?? payload.idempotency_key

  if (!templateName || !recipient) {
    return new Response(
      JSON.stringify({ success: false, error: 'templateName and recipientEmail are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const result = await sendAppEmail(templateName, recipient, {
    templateData: payload.templateData,
    idempotencyKey: idempotencyKey ?? undefined,
    replyTo: payload.replyTo ?? undefined,
  })

  if (result.sent) {
    return new Response(JSON.stringify({ success: true, sent: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (result.reason === 'recipient_suppressed') {
    // Expected outcome, not an error — mirrors the retired function's contract.
    return new Response(
      JSON.stringify({ success: false, reason: 'email_suppressed' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  return new Response(
    JSON.stringify({ success: false, error: result.error ?? 'send failed' }),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  )
}
