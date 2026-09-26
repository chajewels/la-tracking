import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../_shared/render-email.ts'
import { createAuthEmailHandler, sendLovableEmail, EmailAPIError, type AuthEmailDefinitions, type AuthEmailHookData } from 'npm:@lovable.dev/email-js@0.1.0'
import { verifyWebhookRequest, WebhookError } from 'npm:@lovable.dev/webhooks-js@0.0.2'
import { SignupEmail } from '../_shared/email-templates/signup.tsx'
import { InviteEmail } from '../_shared/email-templates/invite.tsx'
import { MagicLinkEmail } from '../_shared/email-templates/magic-link.tsx'
import { RecoveryEmail } from '../_shared/email-templates/recovery.tsx'
import { EmailChangeEmail } from '../_shared/email-templates/email-change.tsx'
import { ReauthenticationEmail } from '../_shared/email-templates/reauthentication.tsx'
import { StorefrontMagicLinkEmail } from '../_shared/email-templates/storefront-magic-link.tsx'
import { audienceOf, hostOf, linkTargets, STOREFRONT_ACTION_TYPES, storefrontConfirmUrl, type HookLinkData } from '../_shared/auth-audience.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-lovable-signature, x-lovable-timestamp, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// Configuration
const SITE_NAME = "Cha Jewels Hub"
const SENDER_DOMAIN = "notify.chajewelsjp.com"
const ROOT_DOMAIN = "chajewelsjp.com"
const FROM_DOMAIN = "chajewelsjp.com"
const SITE_URL = `https://${ROOT_DOMAIN}`

// Template mapping for preview mode
const EMAIL_TEMPLATES: Record<string, React.ComponentType<any>> = {
  signup: SignupEmail,
  invite: InviteEmail,
  magiclink: MagicLinkEmail,
  recovery: RecoveryEmail,
  email_change: EmailChangeEmail,
  reauthentication: ReauthenticationEmail,
}

// Sample data for preview mode ONLY (not used in actual email sending).
// URLs are baked in at scaffold time from the project's real data.
// The sample email uses a fixed placeholder (RFC 6761 .test TLD) so the Go backend
// can always find-and-replace it with the actual recipient when sending test emails,
// even if the project's domain has changed since the template was scaffolded.
const SAMPLE_PROJECT_URL = "https://chajewelslayaway.lovable.app"
const SAMPLE_EMAIL = "user@example.test"
const SAMPLE_DATA: Record<string, object> = {
  signup: {
    siteName: SITE_NAME,
    siteUrl: SAMPLE_PROJECT_URL,
    recipient: SAMPLE_EMAIL,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  magiclink: {
    siteName: SITE_NAME,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  recovery: {
    siteName: SITE_NAME,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  invite: {
    siteName: SITE_NAME,
    siteUrl: SAMPLE_PROJECT_URL,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  email_change: {
    siteName: SITE_NAME,
    oldEmail: SAMPLE_EMAIL,
    email: SAMPLE_EMAIL,
    newEmail: SAMPLE_EMAIL,
    confirmationUrl: SAMPLE_PROJECT_URL,
  },
  reauthentication: {
    token: '123456',
  },
}

// Preview endpoint handler - returns rendered HTML without sending email
async function handlePreview(req: Request): Promise<Response> {
  const previewCorsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: previewCorsHeaders })
  }

  const apiKey = Deno.env.get('LOVABLE_API_KEY')
  const authHeader = req.headers.get('Authorization')

  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...previewCorsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let type: string
  try {
    const body = await req.json()
    type = body.type
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
      status: 400,
      headers: { ...previewCorsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const EmailTemplate = EMAIL_TEMPLATES[type]

  if (!EmailTemplate) {
    return new Response(JSON.stringify({ error: `Unknown email type: ${type}` }), {
      status: 400,
      headers: { ...previewCorsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const sampleData = SAMPLE_DATA[type] || {}
  const html = await renderEmail(React.createElement(EmailTemplate, sampleData))

  return new Response(html, {
    status: 200,
    headers: { ...previewCorsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  })
}

// Audience decision (which hosts are the storefront, and the storefront's own
// sign-in link) lives in _shared/auth-audience.ts so it can be tested.

// The SDK handler owns verification, dispatch, and retry semantics; this file
// owns only the email decisions: subjects, templates, and per-type props.
// `from` is handler-wide in the SDK, so the storefront gets its own handler —
// same definitions, different sender name and magic-link email.
const STAFF_EMAILS: AuthEmailDefinitions = {
    signup: {
      subject: 'Confirm your email',
      render: (data) =>
        React.createElement(SignupEmail, {
          siteName: SITE_NAME,
          siteUrl: SITE_URL,
          recipient: data.email,
          confirmationUrl: data.url,
        }),
    },
    invite: {
      subject: "You've been invited",
      render: (data) =>
        React.createElement(InviteEmail, {
          siteName: SITE_NAME,
          siteUrl: SITE_URL,
          confirmationUrl: data.url,
        }),
    },
    magiclink: {
      subject: 'Your login link',
      render: (data) =>
        React.createElement(MagicLinkEmail, {
          siteName: SITE_NAME,
          confirmationUrl: data.url,
        }),
    },
    recovery: {
      subject: 'Reset your password',
      render: (data) =>
        React.createElement(RecoveryEmail, {
          siteName: SITE_NAME,
          confirmationUrl: data.url,
        }),
    },
    email_change: {
      subject: 'Confirm your new email',
      render: (data) =>
        React.createElement(EmailChangeEmail, {
          siteName: SITE_NAME,
          oldEmail: data.old_email ?? '',
          email: data.email,
          newEmail: data.new_email ?? '',
          confirmationUrl: data.url,
        }),
    },
    reauthentication: {
      subject: 'Your verification code',
      render: (data) =>
        React.createElement(ReauthenticationEmail, { token: data.token ?? '' }),
    },
}

const staffHandler = createAuthEmailHandler({
  apiKey: Deno.env.get('LOVABLE_API_KEY')!,
  from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
  senderDomain: SENDER_DOMAIN,
  sendUrl: Deno.env.get('LOVABLE_SEND_URL'),
  emails: STAFF_EMAILS,
})

/**
 * Storefront sign-in emails carry Reply-To sales@chajewelsjp.com, which the
 * SDK's createAuthEmailHandler cannot set. This is that handler's body with
 * the one extra field: the SAME signature verification (verifyWebhookRequest,
 * signed with the API key), the same run_id passed through so Lovable ties the
 * send to the auth run, and the same 400/500 split on failure. Only magiclink
 * and signup reach it — the audience gate below sends every other action type
 * to staffHandler unchanged.
 */
const STOREFRONT_REPLY_TO = 'sales@chajewelsjp.com'
const STOREFRONT_FROM = `Cha Jewels <noreply@${FROM_DOMAIN}>`
const STOREFRONT_SUBJECT = 'Cha Jewels サインインリンク / Your Cha Jewels sign-in link'

type StorefrontHookPayload = { version?: string; run_id?: string; data?: AuthEmailHookData }

async function storefrontHandler(req: Request): Promise<Response> {
  const apiKey = Deno.env.get('LOVABLE_API_KEY')!
  let event: StorefrontHookPayload
  try {
    ({ payload: event } = await verifyWebhookRequest<StorefrontHookPayload>({
      req,
      secret: apiKey,
      parser: (body) => JSON.parse(body) as StorefrontHookPayload,
    }))
  } catch (error) {
    if (error instanceof WebhookError) {
      const status = error.code === 'invalid_signature' || error.code === 'missing_secret' ? 401 : 400
      return Response.json({ error: error.message }, { status })
    }
    console.error('[auth-email-hook] storefront webhook verification failed:', error)
    return Response.json({ error: 'Webhook verification failed' }, { status: 500 })
  }
  if (!event.run_id) return Response.json({ error: 'Missing run_id' }, { status: 400 })
  if (event.version !== '1') return Response.json({ error: `Unsupported payload version: ${event.version}` }, { status: 400 })
  const data = event.data
  if (!data || !STOREFRONT_ACTION_TYPES.has(data.action_type)) {
    return Response.json({ error: `Unknown auth email action type: ${data?.action_type}` }, { status: 400 })
  }
  try {
    // signup (first-time customer) and magiclink are the same email to the
    // customer: the sign-in link they just asked for.
    const element = React.createElement(StorefrontMagicLinkEmail, { confirmationUrl: storefrontConfirmUrl(data) })
    const html = await renderEmail(element)
    const text = await renderEmail(element, { plainText: true })
    await sendLovableEmail(
      {
        run_id: event.run_id,
        to: data.email,
        from: STOREFRONT_FROM,
        sender_domain: SENDER_DOMAIN,
        reply_to: STOREFRONT_REPLY_TO,
        subject: STOREFRONT_SUBJECT,
        html,
        text,
        purpose: 'transactional',
        label: data.action_type,
      },
      { apiKey, sendUrl: Deno.env.get('LOVABLE_SEND_URL') },
    )
  } catch (error) {
    console.error('[auth-email-hook] storefront email send failed:', error)
    if (error instanceof EmailAPIError && !error.retryable) {
      return Response.json({ error: 'Email send rejected' }, { status: 400 })
    }
    return Response.json({ error: 'Failed to send email' }, { status: 500 })
  }
  return Response.json({ success: true, sent: true })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)

  // Handle CORS preflight for main endpoint
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Route to preview handler for /preview path
  if (url.pathname.endsWith('/preview')) {
    return handlePreview(req)
  }

  // Peek at the payload only to choose a sender; the chosen handler verifies
  // the signature on the untouched request before anything is sent, so a
  // forged body can pick a template but never an email.
  const peek = await req.clone().json().catch(() => null) as { data?: HookLinkData } | null
  const data = peek?.data
  const actionType = data?.action_type ?? ''
  const storefront = audienceOf(data) === 'storefront'
  // Audience decision, hosts only — never the token, the path, or the address.
  // This line is what answers "which template went out, and why" in the logs.
  console.log(JSON.stringify({
    audience: storefront ? 'storefront' : 'staff',
    action_type: actionType,
    hosts: data ? linkTargets(data).map(hostOf) : [],
  }))
  return (storefront ? storefrontHandler : staffHandler)(req)
})
