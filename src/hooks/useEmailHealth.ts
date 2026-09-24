import { useQuery } from '@tanstack/react-query';
import { callUntypedRpc } from '@/lib/untyped-rpc';

/**
 * Email delivery health (added 2026-09-13 after the silent nine-day
 * missing_unsubscribe outage). One RPC, email_delivery_report(p_hours),
 * compares the customer emails the Hub should have sent in the window with
 * the attempts accepted / refused in email_send_log. Staff-only (the RPC
 * checks the role itself). Powers the sidebar pill, the dashboard banner and
 * the Settings card.
 */
export type EmailHealthStatus = 'ok' | 'degraded' | 'refused' | 'silent' | 'unknown';

export interface EmailDeliveryReport {
  window_hours: number;
  since: string;
  generated_at: string;
  expected: Record<string, number>;
  expected_total: number;
  sent: number;
  failed: number;
  suppressed: number;
  storefront: { sent: number; failed: number };
  last_sent_at: string | null;
  last_sent_in_window_at: string | null;
  first_failure_in_window_at: string | null;
  last_failure_at: string | null;
  refusal_streak_started_at: string | null;
  newest_error: string | null;
  newest_request_id: string | null;
  status: EmailHealthStatus;
}

export const EMAIL_HEALTH_QUERY_KEY = ['email-health'] as const;

export function useEmailHealth(hours = 24, enabled = true) {
  return useQuery<EmailDeliveryReport>({
    queryKey: [...EMAIL_HEALTH_QUERY_KEY, hours],
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      // Untyped until the RPC lands in the generated types; called as a method
      // (see callUntypedRpc — a detached rpc() throws before any request).
      return callUntypedRpc<EmailDeliveryReport>('email_delivery_report', { p_hours: hours });
    },
  });
}

export const EMAIL_HEALTH_LABEL: Record<EmailHealthStatus, string> = {
  ok: 'Email OK',
  degraded: 'Some emails refused',
  refused: 'Emails refused',
  silent: 'No email attempts logged',
  unknown: 'Email status unknown',
};

export function emailHealthTone(status: EmailHealthStatus | undefined): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'ok') return 'ok';
  if (status === 'degraded' || status === 'silent') return 'warn';
  if (status === 'refused') return 'bad';
  return 'muted';
}

export function formatUtcShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d) + ' PHT';
}
