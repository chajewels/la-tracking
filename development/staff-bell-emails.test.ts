/**
 * STAFF BELL EMAILS (V11b) + BOUNCE BELL (V13), owner decisions 2026-10-08.
 * Pure rules + source wiring. The SQL half (fan-out, recipients, claim/finish,
 * bounce bell, guard, setter) is development/sql/staff-bell-emails-acceptance.sql.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/staff-bell-emails.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  staffBellEmailKey, staffBellFinishOutcome, staffBellHubUrl, staffBellSubject, staffBellWhen,
} from '../supabase/functions/_shared/staff-bell-email-rules.ts'
import { TEMPLATES } from '../supabase/functions/_shared/transactional-email-templates/registry.ts'

Deno.test('key: one per (bell, recipient), case-insensitive on the address', () => {
  assertEquals(staffBellEmailKey('b1', 'Brenda@Example.com '), 'staff-bell-b1-brenda@example.com')
  assertEquals(staffBellEmailKey('b1', 'brenda@example.com'), staffBellEmailKey('b1', 'BRENDA@example.com'))
})

Deno.test('outcome: sent → sent; a suppressed staff address is skipped, never retried; anything else retries', () => {
  assertEquals(staffBellFinishOutcome({ sent: true }), 'sent')
  assertEquals(staffBellFinishOutcome({ sent: false, reason: 'recipient_suppressed' }), 'skipped')
  assertEquals(staffBellFinishOutcome({ sent: false, reason: 'rate_limited' }), 'retry')
})

Deno.test('hub link: card / square bells → Website settings; bounce → Settings; an order id → the order; never portal.*', () => {
  assert(staffBellHubUrl({ bell_type: 'card_refund_after_credit', metadata: { cash_order_id: 'o1' } }).endsWith('/website?tab=settings'))
  assert(staffBellHubUrl({ bell_type: 'email_bounced', metadata: null }).endsWith('/settings?tab=general'))
  assert(staffBellHubUrl({ bell_type: 'refund_email_failed', metadata: { cash_order_id: 'o1' } }).endsWith('/cash-orders/o1'))
  assert(staffBellHubUrl({ bell_type: 'web_order_refund', metadata: { cash_order_id: 'o2' } }).endsWith('/cash-orders/o2'))
  assert(staffBellHubUrl({ bell_type: 'something_else', metadata: {} }).endsWith('/dashboard'))
  for (const t of ['card_refund_pending', 'email_bounced', 'x']) assert(!staffBellHubUrl({ bell_type: t, metadata: null }).includes('portal.'))
})

Deno.test('subject carries the title and invoice; time is shown in JST', () => {
  assertEquals(staffBellSubject({ title: 'Card refund completed', invoice_number: 'TEST-1' }), '[Hub bell] Card refund completed · TEST-1')
  assertEquals(staffBellSubject({ title: 'X', invoice_number: null }), '[Hub bell] X')
  assertEquals(staffBellWhen('2026-10-08T08:33:54Z'), '08 Oct 2026, 17:33 JST')
  assertEquals(staffBellWhen('garbage'), 'garbage')
})

Deno.test('template: registered, internal audience, subject matches the rule, English only', () => {
  const t = TEMPLATES['staff-bell']
  assert(t, 'staff-bell is registered')
  assertEquals(t.audience, 'internal')
  const subject = typeof t.subject === 'function' ? t.subject({ title: 'T', invoiceNumber: 'I' }) : t.subject
  assertEquals(subject, '[Hub bell] T · I')
  const src = Deno.readTextFileSync(new URL('../supabase/functions/_shared/transactional-email-templates/staff-bell.tsx', import.meta.url))
  assert(!/[぀-ヿ一-鿿]/.test(src), 'no Japanese in a staff email')
  assert(!src.includes('portal.chajewelsjp.com'), 'never a customer link')
})

Deno.test('wiring: the edge function claims, sends with the key, and finishes every row', () => {
  const src = Deno.readTextFileSync(new URL('../supabase/functions/staff-bell-emails/index.ts', import.meta.url))
  const code = src.replace(/^\s*(\*|\/\/|\/\*\*).*$/gm, '')
  assert(code.includes('rpc("claim_staff_bell_emails"'), 'claims through the RPC')
  assert(code.includes('sendTemplateEmail("staff-bell", b.recipient'), 'one email per recipient')
  assert(code.includes('idempotencyKey: staffBellEmailKey(b.bell_id, b.recipient)'), 'same key on retry')
  assert(code.includes('rpc("finish_staff_bell_email"'), 'every row is finished')
  assert(code.includes('allowServiceRole: true'), 'cron / trigger caller')
  assert(code.includes('requirePermission(ctx, "system_health")'), 'human callers need a real permission')
})

Deno.test('wiring: migration fans out on insert, bells on bounce, guards the settings, and sweeps hourly at :16', () => {
  const sql = Deno.readTextFileSync(new URL('../supabase/migrations/20261127100000_staff_bell_emails_and_bounce_bell.sql', import.meta.url))
  const code = sql.replace(/^\s*--.*$/gm, '')
  assert(code.includes('AFTER INSERT ON public.staff_notifications'), 'fan-out trigger')
  assert(code.includes('AFTER INSERT ON public.email_send_log'), 'bounce trigger')
  assert(code.includes("NEW.status IN ('bounced','complained')"), 'bounce + complaint')
  assert(code.includes("NEW.status = 'suppressed' AND NEW.template_name LIKE 'order-update-refund%'"), 'a suppressed refund email rings too')
  assert(code.includes("'email_bounced'"), 'bell type')
  assert(code.includes("cron.schedule('staff-bell-emails-sweep', '16 * * * *'"), 'hourly fallback at :16')
  assert(code.includes("vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'"), 'Vault key at fire time')
  assert(code.includes('"addresses":["bumagatbrenda@gmail.com"],"roles":["admin"]'), 'owner recipients: Brenda + admins')
  assert(!code.includes('SUPABASE_SERVICE_ROLE_KEY'), 'no embedded key')
})
