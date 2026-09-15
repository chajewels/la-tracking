import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Portal token expiry (added 2026-09-15, after 447 of 632 active tokens were
 * found to be 30 days from lapsing — 195 of them on one Sunday — with nothing
 * in the Hub watching `expires_at`).
 *
 * Same shape as useEmailHealth: one staff-gated RPC, read by the sidebar pill,
 * the dashboard banner and the Monitoring worklist.
 */
export type PortalTokenStatus = 'ok' | 'watch' | 'soon' | 'urgent' | 'expired' | 'unknown';

export interface PortalTokenReport {
  generated_at: string;
  window_days: number;
  active_tokens: number;
  expiring_in_window: number;
  expiring_in_window_with_live_plan: number;
  bands: { d60: number; d30: number; d14: number; expired: number };
  peak_day: string | null;
  peak_day_count: number;
  peak_day_with_live_plan: number;
  /** Tokens with no recorded authentication. See `last_seen_recording_since`. */
  never_seen: number;
  never_seen_with_live_plan: number;
  /**
   * How many tokens have EVER recorded a last-seen. The write is
   * fire-and-forget, so a stuck zero here means the recording has broken and
   * the deferred lifecycle question is losing data again — the whole reason
   * this figure is surfaced rather than assumed.
   */
  tokens_with_any_last_seen: number;
  last_seen_recording_since: string;
  status: PortalTokenStatus;
}

/** One row of the worklist behind the indicator. */
export interface PortalTokenRow {
  token_id: string;
  customer_id: string;
  customer_code: string | null;
  full_name: string | null;
  email: string | null;
  mobile_number: string | null;
  expires_at: string;
  days_left: number;
  last_used_at: string | null;
  use_count: number;
  has_live_plan: boolean;
  live_plan_count: number;
  /** True when the customer can sign in with a password — they lose nothing when the token lapses. */
  has_password: boolean;
}

export const PORTAL_TOKEN_QUERY_KEY = ['portal-token-health'] as const;
export const PORTAL_TOKEN_LIST_KEY = ['portal-token-list'] as const;

/** Default window is 60 days — see the migration for why it is not 30. */
export function usePortalTokenHealth(days = 60, enabled = true) {
  return useQuery<PortalTokenReport>({
    queryKey: [...PORTAL_TOKEN_QUERY_KEY, days],
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      // Cast: the RPC lands in the auto-generated types on Lovable's next push.
      const rpc = supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc('portal_token_expiry_report', { p_days: days });
      if (error) throw error;
      return data as PortalTokenReport;
    },
  });
}

export function usePortalTokenList(days = 60, enabled = true) {
  return useQuery<PortalTokenRow[]>({
    queryKey: [...PORTAL_TOKEN_LIST_KEY, days],
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const rpc = supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc('portal_tokens_expiring_list', { p_days: days });
      if (error) throw error;
      return (data ?? []) as PortalTokenRow[];
    },
  });
}

export const PORTAL_TOKEN_LABEL: Record<PortalTokenStatus, string> = {
  ok: 'Portal links OK',
  watch: 'Portal links: 60 days',
  soon: 'Portal links expiring',
  urgent: 'Portal links expire soon',
  expired: 'Portal links expired',
  unknown: 'Portal link status unknown',
};

export function portalTokenTone(status: PortalTokenStatus | undefined): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'ok') return 'ok';
  if (status === 'watch' || status === 'soon') return 'warn';
  if (status === 'urgent' || status === 'expired') return 'bad';
  return 'muted';
}

/** A date, in PHT, for a deadline staff work to (CLAUDE.md TIMEZONE STANDARD). */
export function formatPhtDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', day: 'numeric', month: 'short', year: 'numeric',
  }).format(d);
}
