import { sendLovableEmail } from 'npm:@lovable.dev/email-js@0.1.0'
import { describeEmailError } from './email-log.ts'

/**
 * ONE in-call retry for transient email-API refusals (owner-approved
 * 2026-10-02). Same payload object, SAME idempotency_key — the API dedupes on
 * it, so a retry can never produce a second email. This is NOT a replay job:
 * nothing is ever re-sent later. Max 2 attempts, never a loop.
 */

const RETRY_DELAY_MS = 2000

export function isTransientEmailError(err: unknown): boolean {
  if (err == null) return false
  const info = describeEmailError(err)
  if (info.type === 'lovable_api_key_registry_lookup_failed') return true
  const status = (err as { status?: unknown })?.status
  if (typeof status === 'number') return status >= 500 && status <= 599
  // No HTTP status: only a genuine network failure counts.
  if (err instanceof TypeError) return true
  const msg = info.message.toLowerCase()
  return /fetch failed|connection reset|econnreset|network error|connection refused|connection closed/.test(msg)
}

type SendFn = typeof sendLovableEmail
type Payload = Parameters<SendFn>[0]
type Opts = Parameters<SendFn>[1]

export interface RetryDeps {
  send?: (payload: Payload, opts: Opts) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
}

export async function sendLovableEmailWithRetry(
  payload: Payload,
  opts: Opts,
  deps: RetryDeps = {},
): Promise<{ retried: boolean; firstErrorType: string | null }> {
  const send = deps.send ?? sendLovableEmail
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  try {
    await send(payload, opts)
    return { retried: false, firstErrorType: null }
  } catch (err) {
    if (!isTransientEmailError(err)) throw err
    const firstErrorType = describeEmailError(err).type ??
      (typeof (err as { status?: unknown })?.status === 'number' ? `http_${(err as { status: number }).status}` : 'network_error')
    const label = (payload as { label?: string })?.label ?? 'email'
    console.warn(`[email-retry] ${label}: transient ${firstErrorType}, retrying once in ${RETRY_DELAY_MS}ms`)
    await sleep(RETRY_DELAY_MS)
    await send(payload, opts) // a second failure propagates
    return { retried: true, firstErrorType }
  }
}
