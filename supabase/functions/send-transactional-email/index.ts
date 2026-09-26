import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../_shared/render-email.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { TEMPLATES } from '../_shared/transactional-email-templates/registry.ts'
import { isServiceRole, parseJwtClaims } from '../_shared/jwt-claims.ts'

// Configuration baked in at scaffold time — do NOT change these manually.
// To update, re-run the email domain setup flow.
const SITE_NAME = "chajewelslayaway"
// SENDER_DOMAIN is the verified sender subdomain FQDN (e.g., "notify.example.com").
// It MUST match the subdomain delegated to Lovable's nameservers — never the root domain.
// The email API looks up this exact domain; a mismatch causes "No email domain record found".
const SENDER_DOMAIN = "notify.chajewelsjp.com"
// FROM_DOMAIN is the domain shown in the From: header (e.g., "example.com").
// When display_from_root is enabled, this can be the root domain for cleaner branding,
// even though actual sending uses the subdomain above.
const FROM_DOMAIN = "chajewelsjp.com"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

// Auth note: this function uses verify_jwt = true in config.toml, so Supabase's
// gateway validates the caller's JWT (anon or service_role) before the request
// reaches this code. No in-function auth check is needed.

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // SECURITY: require an Authorization header with EITHER the service-role key
  // (internal edge-function callers / crons) OR a valid authenticated user JWT
  // (portal customers, staff). Plain anon-key callers are rejected — otherwise
  // anyone with the public anon key could spoof company-branded emails to
  // arbitrary recipients with attacker-controlled templateData.
  const authToken = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
  if (!authToken) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  {
    const serviceRoleKeyForAuth = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (!isServiceRole(authToken)) {
      const supabaseUrlForAuth = Deno.env.get('SUPABASE_URL') ?? ''
      const authClient = createClient(supabaseUrlForAuth, serviceRoleKeyForAuth)
      const { data: userData, error: userErr } = await authClient.auth.getUser(authToken)
      if (userErr || !userData?.user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      // Reject customer JWTs — only staff may trigger company-branded emails
      const { data: callerIsStaff } = await authClient.rpc('is_staff', { _user_id: userData.user.id })
      if (!callerIsStaff) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }
  }



  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables')
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Parse request body
  let templateName: string
  let recipientEmail: string
  let idempotencyKey: string
  let messageId: string
  let templateData: Record<string, any> = {}
  try {
    const body = await req.json()
    templateName = body.templateName || body.template_name
    recipientEmail = body.recipientEmail || body.recipient_email
    messageId = crypto.randomUUID()
    idempotencyKey = body.idempotencyKey || body.idempotency_key || messageId
    if (body.templateData && typeof body.templateData === 'object') {
      templateData = body.templateData
    }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON in request body' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (!templateName) {
    return new Response(
      JSON.stringify({ error: 'templateName is required' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 1. Look up template from registry (early — needed to resolve recipient)
  const template = TEMPLATES[templateName]

  if (!template) {
    console.error('Template not found in registry', { templateName })
    return new Response(
      JSON.stringify({
        error: `Template '${templateName}' not found. Available: ${Object.keys(TEMPLATES).join(', ')}`,
      }),
      {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Resolve effective recipient: template-level `to` takes precedence over
  // the caller-provided recipientEmail. This allows notification templates
  // to always send to a fixed address (e.g., site owner from env var).
  const effectiveRecipient = template.to || recipientEmail

  if (!effectiveRecipient) {
    return new Response(
      JSON.stringify({
        error: 'recipientEmail is required (unless the template defines a fixed recipient)',
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Create Supabase client with service role (bypasses RLS)
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // 2. Check suppression list (fail-closed: if we can't verify, don't send)
  const { data: suppressed, error: suppressionError } = await supabase
    .from('suppressed_emails')
    .select('id')
    .eq('email', effectiveRecipient.toLowerCase())
    .maybeSingle()

  if (suppressionError) {
    console.error('Suppression check failed — refusing to send', {
      error: suppressionError,
      effectiveRecipient,
    })
    return new Response(
      JSON.stringify({ error: 'Failed to verify suppression status' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (suppressed) {
    // Log the suppressed attempt
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
    })

    console.log('Email suppressed', { effectiveRecipient, templateName })
    return new Response(
      JSON.stringify({ success: false, reason: 'email_suppressed' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 3. Unsubscribe is handled by Lovable, server-side.
  //
  // READ THIS BEFORE ADDING A TOKEN BACK. The API error `missing_unsubscribe`
  // means TWO OPPOSITE THINGS and the code is identical in both directions —
  // only the message body tells them apart:
  //   OLD meaning: "you sent no unsubscribe mechanism, supply one."
  //   NEW meaning (since 2026-09-01/03): "unsubscribe is managed for you —
  //                do not set unsubscribe_token manually."
  // Ours was the new one, verbatim from email_send_log:
  //   "This project is migrating to Lovable-managed email sending. Publish the
  //    project to complete the migration, then retry; do not set
  //    unsubscribe_token manually."
  // Every send through this queue pipeline was refused from 2026-09-04 02:03
  // until it stopped being called on 09-09; the direct helper
  // (_shared/transactional-email-templates/send-email.ts), which never set a
  // token, sends fine. So the fix is to stop setting one — never to mint one.
  //
  // email_unsubscribe_tokens and handle-email-unsubscribe are LEFT IN PLACE on
  // purpose: unsubscribe links in emails already delivered must keep working.
  // Opt-outs still gate sending here through the suppressed_emails check above.

  // 4. Render React Email template to HTML and plain text
  const html = await renderEmail(
    React.createElement(template.component, templateData)
  )
  const plainText = await renderEmail(
    React.createElement(template.component, templateData),
    { plainText: true }
  )

  // Resolve subject — supports static string or dynamic function
  const resolvedSubject =
    typeof template.subject === 'function'
      ? template.subject(templateData)
      : template.subject

  // Idempotency check — prevent duplicate sends from retry/race (Bug #109 fix, 2026-05-15)
  if (idempotencyKey && idempotencyKey !== messageId) {
    const { data: existingSend } = await supabase
      .from('email_send_log')
      .select('id, status, message_id')
      .eq('idempotency_key', idempotencyKey)
      .in('status', ['pending', 'sent'])
      .limit(1)
      .maybeSingle();
    if (existingSend) {
      console.log('Email deduplicated by idempotency key', {
        idempotencyKey,
        existingMessageId: existingSend.message_id,
      });
      return new Response(
        JSON.stringify({
          success: true,
          deduplicated: true,
          existing_message_id: existingSend.message_id,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  // 5. Enqueue the pre-rendered email for async processing by the dispatcher.
  // The dispatcher (process-email-queue) handles sending, retries, and rate-limit backoff.

  // Log pending BEFORE enqueue so we have a record even if enqueue crashes
  const { error: pendingInsertErr } = await supabase.from('email_send_log').insert({
    message_id: messageId,
    idempotency_key: idempotencyKey,
    template_name: templateName,
    recipient_email: effectiveRecipient,
    status: 'pending',
  });
  if (pendingInsertErr) {
    // Concurrent race: another simultaneous call won the idempotency race
    if ((pendingInsertErr as { code?: string }).code === '23505') {
      console.log('Email deduplicated at INSERT (concurrent race)', { idempotencyKey });
      return new Response(
        JSON.stringify({ success: true, deduplicated: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    console.error('Failed to log pending email', { error: pendingInsertErr });
    throw pendingInsertErr;
  }

  const { error: enqueueError } = await supabase.rpc('enqueue_email', {
    queue_name: 'transactional_emails',
    payload: {
      message_id: messageId,
      to: effectiveRecipient,
      from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      sender_domain: SENDER_DOMAIN,
      subject: resolvedSubject,
      html,
      text: plainText,
      purpose: 'transactional',
      label: templateName,
      idempotency_key: idempotencyKey,
      queued_at: new Date().toISOString(),
    },
  })

  if (enqueueError) {
    console.error('Failed to enqueue email', {
      error: enqueueError,
      templateName,
      effectiveRecipient,
    })

    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'failed',
      error_message: 'Failed to enqueue email',
    })

    return new Response(JSON.stringify({ error: 'Failed to enqueue email' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  console.log('Transactional email enqueued', { templateName, effectiveRecipient })

  return new Response(
    JSON.stringify({ success: true, queued: true }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
})
