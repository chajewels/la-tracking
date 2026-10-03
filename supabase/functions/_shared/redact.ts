/**
 * Log redaction for personal data.
 *
 * WHY (Lovable scan 2026-10-03, 31 INFO_LEAKAGE findings): every edge
 * function wrote the customer's full email address to the function log when
 * an email was suppressed or failed. Those logs are visible to anyone with
 * dashboard access and are retained; the address is already recorded, where
 * it belongs, in email_send_log (recordEmailAttempt) and customers. The log
 * line only needs enough to recognise the recipient while debugging.
 *
 * maskEmail("juan.delacruz@gmail.com") → "j***z@gmail.com"
 * maskEmail("ab@x.io")                 → "a***@x.io"
 * maskEmail("")  / null / undefined     → "(none)"
 * Anything without "@" is treated as an opaque value and masked the same way.
 *
 * Use it in EVERY console.log / console.warn / console.error that would
 * otherwise carry an email address. Guarded by
 * development/log-redaction.test.ts (CI).
 */
export function maskEmail(value: unknown): string {
  const s = value == null ? "" : String(value).trim();
  if (!s) return "(none)";
  const at = s.lastIndexOf("@");
  const local = at > 0 ? s.slice(0, at) : s;
  const domain = at > 0 ? s.slice(at) : "";
  const first = local.charAt(0);
  const last = local.length > 2 ? local.charAt(local.length - 1) : "";
  return `${first}***${last}${domain}`;
}
