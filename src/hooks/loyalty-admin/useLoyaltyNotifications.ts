import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// loyalty_notifications and loyalty_notification_recipients aren't in the
// generated supabase types.ts yet (added via SQL Editor in Phase 4 C1).
// Cast for typed-table-name calls until the types are regenerated.
// Same pattern used by useLoyaltyRewards / useLoyaltyBanners.
// deno-lint-ignore no-explicit-any
const sb = supabase as any;

// ─────────── Types ───────────────────────────────────────────────

export type NotificationStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'cancelled'
  | 'failed';

export type NotificationCategory =
  | 'info'
  | 'promo'
  | 'tier'
  | 'system'
  | 'reward'
  | 'birthday'
  | 'expiry';

export type AudienceType = 'all' | 'tier' | 'specific';

export interface LoyaltyNotificationRow {
  id: string;
  title: string;
  body: string;
  category: NotificationCategory;
  audience_type: AudienceType;
  audience_tiers: string[] | null;
  audience_member_ids: string[] | null;
  link_target: string | null;
  status: NotificationStatus;
  scheduled_for: string | null;
  sent_at: string | null;
  expires_at: string | null;
  send_email: boolean;
  email_sent: boolean;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoyaltyNotificationStats {
  total: number;
  read_count: number;
  read_rate: number; // 0..1
  email_sent: boolean;
  email_pending: boolean; // send_email=true but email_sent=false yet
}

export interface LoyaltyNotificationWithStats extends LoyaltyNotificationRow {
  stats: LoyaltyNotificationStats;
}

export interface NotificationFilters {
  status?: NotificationStatus[];
  category?: NotificationCategory[];
  audience_type?: AudienceType[];
  created_from?: string; // ISO
  created_to?: string;   // ISO
  limit?: number;        // default 100
}

export interface SendNotificationInput {
  title: string;
  body: string;
  category: NotificationCategory;
  audience_type: AudienceType;
  audience_tiers?: string[] | null;
  audience_member_ids?: string[] | null;
  link_target?: string | null;
  send_email?: boolean;
  scheduled_for?: string | null;
  expires_at?: string | null;
}

export interface AudienceMemberRow {
  member_id: string;
  customer_id: string;
  customer_name: string;
  customer_code: string | null;
  current_tier: string;
  remaining_points: number;
}

export const TIERS = ['Glimmer', 'Radiant', 'Elite', 'Crown VIP'] as const;
export type Tier = typeof TIERS[number];

const EMPTY_STATS: LoyaltyNotificationStats = {
  total: 0,
  read_count: 0,
  read_rate: 0,
  email_sent: false,
  email_pending: false,
};

// ─────────── 1. List with stats ──────────────────────────────────

export function useLoyaltyNotifications(
  filters: NotificationFilters = {},
  enabled: boolean = true,
) {
  const limit = filters.limit ?? 100;
  return useQuery<LoyaltyNotificationWithStats[]>({
    queryKey: ['loyalty-admin-notifications', filters],
    enabled,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      let q = sb
        .from('loyalty_notifications')
        .select(
          'id, title, body, category, audience_type, audience_tiers, audience_member_ids, link_target, status, scheduled_for, sent_at, expires_at, send_email, email_sent, created_by_user_id, created_at, updated_at',
        )
        .order('created_at', { ascending: false })
        .limit(limit);

      if (filters.status && filters.status.length > 0) {
        q = q.in('status', filters.status);
      }
      if (filters.category && filters.category.length > 0) {
        q = q.in('category', filters.category);
      }
      if (filters.audience_type && filters.audience_type.length > 0) {
        q = q.in('audience_type', filters.audience_type);
      }
      if (filters.created_from) q = q.gte('created_at', filters.created_from);
      if (filters.created_to) q = q.lte('created_at', filters.created_to);

      const { data: notifs, error: notifErr } = await q;
      if (notifErr) throw notifErr;
      const rows = (notifs ?? []) as unknown as LoyaltyNotificationRow[];

      // Recipients aggregation. Bounded by notification ids returned above
      // (max `limit` rows × ~464 members ≈ 46k rows max). When this grows,
      // swap to a server-side RPC that returns aggregated counts directly.
      const ids = rows.map((r) => r.id);
      let recipientsByNotif = new Map<string, { total: number; read: number }>();
      if (ids.length > 0) {
        const { data: recipients, error: recErr } = await sb
          .from('loyalty_notification_recipients')
          .select('notification_id, is_read')
          .in('notification_id', ids);
        if (recErr) throw recErr;
        for (const r of (recipients ?? []) as Array<{
          notification_id: string;
          is_read: boolean;
        }>) {
          let entry = recipientsByNotif.get(r.notification_id);
          if (!entry) {
            entry = { total: 0, read: 0 };
            recipientsByNotif.set(r.notification_id, entry);
          }
          entry.total += 1;
          if (r.is_read) entry.read += 1;
        }
      }

      return rows.map<LoyaltyNotificationWithStats>((n) => {
        const agg = recipientsByNotif.get(n.id);
        const total = agg?.total ?? 0;
        const read_count = agg?.read ?? 0;
        return {
          ...n,
          stats: {
            total,
            read_count,
            read_rate: total > 0 ? read_count / total : 0,
            email_sent: n.email_sent,
            email_pending: n.send_email && !n.email_sent && n.status === 'sent',
          },
        };
      });
    },
  });
}

// ─────────── 2. Per-notification stats ───────────────────────────

export function useLoyaltyNotificationStats(
  notificationId: string | null | undefined,
) {
  return useQuery<LoyaltyNotificationStats>({
    queryKey: ['loyalty-admin-notification-stats', notificationId],
    enabled: !!notificationId,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!notificationId) return EMPTY_STATS;

      const [totalRes, readRes, notifRes] = await Promise.all([
        sb
          .from('loyalty_notification_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('notification_id', notificationId),
        sb
          .from('loyalty_notification_recipients')
          .select('id', { count: 'exact', head: true })
          .eq('notification_id', notificationId)
          .eq('is_read', true),
        sb
          .from('loyalty_notifications')
          .select('send_email, email_sent, status')
          .eq('id', notificationId)
          .maybeSingle(),
      ]);

      const total = totalRes.count ?? 0;
      const read_count = readRes.count ?? 0;
      const meta = notifRes.data as
        | { send_email: boolean; email_sent: boolean; status: string }
        | null;

      return {
        total,
        read_count,
        read_rate: total > 0 ? read_count / total : 0,
        email_sent: !!meta?.email_sent,
        email_pending:
          !!meta?.send_email && !meta?.email_sent && meta?.status === 'sent',
      };
    },
  });
}

// ─────────── 3. Send / 4. Update (mutation) ──────────────────────

async function callSendEdgeFn(
  body: SendNotificationInput & { notification_id?: string },
) {
  const { data, error } = await supabase.functions.invoke(
    'send-loyalty-notification',
    { body },
  );
  if (error) throw error;
  if (data?.error) throw new Error(data.detail || data.error);
  return data as {
    success: boolean;
    notification_id: string;
    status: 'sent' | 'scheduled';
    recipient_count?: number;
    email_attempted?: boolean;
    scheduled_for?: string;
  };
}

export function useSendNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendNotificationInput) => callSendEdgeFn(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-notifications'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export function useUpdateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendNotificationInput & { notification_id: string }) =>
      callSendEdgeFn(input),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-notifications'] });
      qc.invalidateQueries({
        queryKey: ['loyalty-admin-notification-stats', vars.notification_id],
      });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

// ─────────── 5. Cancel scheduled ─────────────────────────────────

export function useCancelNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (notification_id: string) => {
      const { data: { user } } = await supabase.auth.getUser();

      // Atomic check-and-update: only flip if still scheduled.
      const { data: updated, error: upErr } = await sb
        .from('loyalty_notifications')
        .update({ status: 'cancelled' })
        .eq('id', notification_id)
        .eq('status', 'scheduled')
        .select('id, title, scheduled_for')
        .maybeSingle();
      if (upErr) throw upErr;
      if (!updated) {
        throw new Error(
          'Cannot cancel: notification is no longer scheduled (already sent, sending, or cancelled).',
        );
      }

      if (user) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_notification',
          entity_id: notification_id,
          action: 'cancelled',
          performed_by_user_id: user.id,
          old_value_json: {
            title: (updated as any).title,
            scheduled_for: (updated as any).scheduled_for,
            status: 'scheduled',
          },
          new_value_json: { status: 'cancelled' },
        });
      }

      return updated as { id: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-notifications'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

// ─────────── 6. Audience picker (members) ────────────────────────

interface RawMemberRow {
  id: string;
  customer_id: string;
  remaining_points: number;
  current_tier: { name: string } | null;
  customers: {
    full_name: string | null;
    customer_code: string | null;
  } | null;
}

export function useLoyaltyMembersForAudience(enabled: boolean = true) {
  return useQuery<AudienceMemberRow[]>({
    queryKey: ['loyalty-admin-audience-members'],
    enabled,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_members')
        .select(
          'id, customer_id, remaining_points, current_tier:current_tier_id(name), customers:customer_id(full_name, customer_code)',
        );
      if (error) throw error;
      const rows = (data ?? []) as unknown as RawMemberRow[];
      return rows.map<AudienceMemberRow>((r) => ({
        member_id: r.id,
        customer_id: r.customer_id,
        customer_name: r.customers?.full_name ?? '—',
        customer_code: r.customers?.customer_code ?? null,
        current_tier: r.current_tier?.name ?? 'Unknown',
        remaining_points: Number(r.remaining_points ?? 0),
      }));
    },
  });
}

// ─────────── 7. Tier list ────────────────────────────────────────

export function useTierList(): readonly Tier[] {
  return TIERS;
}
