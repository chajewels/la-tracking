import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { ArrowLeft, Diamond } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useLoyaltyAccess } from '@/hooks/useLoyaltyAccess';
import { LoyaltyComingSoon } from '@/components/loyalty/LoyaltyComingSoon';
import { LoyaltyJoinPrompt } from '@/components/loyalty/LoyaltyJoinPrompt';
import TierCelebrationModal from '@/components/loyalty/TierCelebrationModal';
import { RedemptionForm } from '@/components/loyalty/RedemptionForm';
import {
  setLoyaltyData,
  TIER_STATIC,
  type TierName,
  type LoyaltyMemberData,
  type LoyaltyTierData,
  type LoyaltyTransactionData,
} from '@/components/loyalty/loyaltyData';
import LoyaltySplashScreen from '@/components/portal/LoyaltySplashScreen';
import LoyaltyBottomNav, {
  type LoyaltyTab,
} from '@/components/loyalty/LoyaltyBottomNav';
import HomeScreen from '@/components/loyalty/screens/HomeScreen';
import RewardsScreen from '@/components/loyalty/screens/RewardsScreen';
import PointsScreen from '@/components/loyalty/screens/PointsScreen';
import NotificationsScreen from '@/components/loyalty/screens/NotificationsScreen';
import ProfileScreen from '@/components/loyalty/screens/ProfileScreen';
import TiersScreen from '@/components/loyalty/screens/TiersScreen';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const P = {
  bg: '#0A0A0A',
  s: '#111111',
  s2: '#1A1A1A',
  br: '#2A2200',
  gp: '#C9A84C',
  gl: '#E8C96D',
  tp: '#F5F0E8',
  ts: '#9A8F7E',
  gr: 'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
} as const;
const CG = "'Cormorant Garamond',Georgia,serif";

interface TierLite {
  name: string;
  points_multiplier: number;
  color_hex: string | null;
}

interface LoyaltyMember {
  id: string;
  customer_id: string;
  cumulative_spend_jpy: number;
  earned_tier_id: string;
  current_tier_id: string;
  is_downgraded: boolean;
  last_purchase_at: string | null;
  prev_purchase_at: string | null;
  total_points_earned: number;
  total_points_redeemed: number;
  total_points_expired: number;
  remaining_points: number;
  enrolled_at: string;
  earned_tier: TierLite | null;
  current_tier: TierLite | null;
}

interface PortalLoyaltyTier {
  name: string;
  min_spend_jpy: number;
  points_multiplier: number;
  color_hex: string | null;
}

interface PortalLoyaltyTx {
  id: string;
  transaction_type: string;
  points_amount: number;
  spend_amount_jpy: number | null;
  invoice_number: string | null;
  tier_at_time: string | null;
  notes: string | null;
  created_at: string;
}

interface PortalData {
  customer_id: string;
  customer_name: string;
  customer_code: string;
  profile: { email: string | null; full_name: string | null } & Record<string, unknown>;
  loyalty_member: LoyaltyMember | null;
  loyalty_tiers: PortalLoyaltyTier[];
  loyalty_transactions: PortalLoyaltyTx[];
  /**
   * Server-resolved beta whitelist flag. customer-portal reads
   * loyalty_beta_members with the service role because the table's RLS
   * denies anon SELECT — the browser-side useLoyaltyAccess check would
   * silently return false for any portal-token session.
   */
  is_loyalty_beta?: boolean;
  /** Phase 4: loyalty notifications fanned out to this member. */
  notifications?: Array<{
    id: string;
    title: string;
    body: string;
    category: string;
    link_target: string | null;
    expires_at: string | null;
    created_at: string;
    is_read: boolean;
    read_at: string | null;
  }>;
  unread_count?: number;
  /**
   * Phase 3.1.1: currently-active multiplier promo for this member.
   * Resolved server-side by customer-portal with the same selection
   * logic as award-loyalty-points. null when no applicable multiplier
   * promo is active. Drives the "Nx BONUS" badge on MemberCard.
   */
  active_promo?: {
    bonus_multiplier: number;
    name: string;
    end_date: string;
  } | null;
}

const tierStorageKey = (customerId: string) => `cha-jewels-last-seen-tier-${customerId}`;

function FullScreenWrap({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-[100dvh] w-full"
      style={{
        background: P.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {children}
    </div>
  );
}

function TopBar({ authMode, token }: {
  authMode: 'session' | 'token' | null;
  token: string;
}) {
  const navigate = useNavigate();
  return (
    <div
      className="flex items-center justify-between px-4 py-3"
      style={{ borderBottom: `1px solid ${P.br}` }}
    >
      <button
        onClick={() => {
          if (authMode === 'session') {
            navigate('/portal');
          } else {
            navigate(`/portal?token=${encodeURIComponent(token)}`);
          }
        }}
        className="flex items-center gap-1 text-sm"
        style={{ color: P.gp }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Portal
      </button>
      <div
        className="flex items-center gap-1.5"
        style={{ fontFamily: CG, color: P.tp, fontSize: '15px', letterSpacing: '0.05em' }}
      >
        <Diamond className="h-4 w-4" style={{ color: P.gp }} />
        Cha Jewels
      </div>
      <div className="w-16" />
    </div>
  );
}

function LoadingState({ message }: { message: string }) {
  return (
    <FullScreenWrap>
      <div className="flex h-[100dvh] flex-col items-center justify-center px-6">
        <Diamond className="h-8 w-8 animate-pulse" style={{ color: P.gp }} />
        <p
          className="mt-4 text-sm"
          style={{ color: P.ts, fontFamily: CG, fontStyle: 'italic' }}
        >
          {message}
        </p>
      </div>
    </FullScreenWrap>
  );
}

interface MemberViewProps {
  data: PortalData;
  member: LoyaltyMember;
  portalToken: string;
}

function MemberView({ data, member, portalToken }: MemberViewProps) {
  const queryClient = useQueryClient();
  const [isRedemptionOpen, setIsRedemptionOpen] = useState(false);
  // 'tiers' is a hidden tab — reached via Home → QuickActions.
  // BottomNav highlights nothing while it is active.
  const [tab, setTab] = useState<LoyaltyTab>('home');

  // ── Build the loyalty data store snapshot ──────────────────────
  const loyaltyMember = data.loyalty_member;
  const loyaltyTiers = data.loyalty_tiers ?? [];
  const loyaltyTxs = data.loyalty_transactions ?? [];

  const sixMonthsAgo = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d;
  }, []);
  const isActive = loyaltyMember?.last_purchase_at
    ? new Date(loyaltyMember.last_purchase_at) > sixMonthsAgo
    : false;

  const tiers = useMemo<LoyaltyTierData[]>(
    () =>
      loyaltyTiers.map((t) => ({
        name: t.name as TierName,
        spendRequired: t.min_spend_jpy,
        multiplier: t.points_multiplier,
        ...TIER_STATIC[t.name as TierName],
      })),
    [loyaltyTiers],
  );

  const currentTierName = (loyaltyMember?.current_tier?.name ?? 'Glimmer') as TierName;
  const currentTierIndex = tiers.findIndex((t) => t.name === currentTierName);
  const nextTier = currentTierIndex >= 0 ? tiers[currentTierIndex + 1] : undefined;
  const cumulative = loyaltyMember?.cumulative_spend_jpy ?? 0;

  const memberData = useMemo<LoyaltyMemberData>(
    () => ({
      // Internal IDs — non-null guaranteed by parent gating
      // (LoyaltyPortal returns LoyaltyJoinPrompt when data.loyalty_member
      // is null, so MemberView renders only when member: LoyaltyMember
      // is real). Sourced from the prop, not from loyaltyMember below,
      // so TypeScript can enforce string (required) without fallbacks.
      id: member.id,
      customer_id: member.customer_id,
      customer_name: data.customer_name || 'Valued Customer',
      member_id: data.customer_code ?? '',
      current_tier: currentTierName,
      is_downgraded: !!loyaltyMember?.is_downgraded,
      available_points: loyaltyMember?.remaining_points ?? 0,
      lifetime_points_earned: loyaltyMember?.total_points_earned ?? 0,
      redeemed_points: loyaltyMember?.total_points_redeemed ?? 0,
      lifetime_spend_yen: cumulative,
      current_multiplier: loyaltyMember?.current_tier?.points_multiplier ?? 1,
      amount_needed_for_next_tier: nextTier
        ? Math.max(0, nextTier.spendRequired - cumulative)
        : 0,
      activity_status: isActive ? 'Active' : 'Inactive',
      email: data.profile?.email ?? null,
      join_date: loyaltyMember?.enrolled_at
        ? new Date(loyaltyMember.enrolled_at).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
          })
        : '—',
      last_purchase_date: loyaltyMember?.last_purchase_at
        ? new Date(loyaltyMember.last_purchase_at).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
          })
        : null,
    }),
    [
      member.id,
      member.customer_id,
      data.customer_name,
      data.customer_code,
      data.profile?.email,
      currentTierName,
      loyaltyMember?.is_downgraded,
      loyaltyMember?.remaining_points,
      loyaltyMember?.total_points_earned,
      loyaltyMember?.total_points_redeemed,
      loyaltyMember?.current_tier?.points_multiplier,
      loyaltyMember?.enrolled_at,
      loyaltyMember?.last_purchase_at,
      cumulative,
      nextTier,
      isActive,
    ],
  );

  const transactions = useMemo<LoyaltyTransactionData[]>(
    () =>
      loyaltyTxs.map((tx) => ({
        id: tx.id,
        date: new Date(tx.created_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        type: (tx.points_amount ?? 0) > 0 ? ('earned' as const) : ('redeemed' as const),
        points: tx.points_amount ?? 0,
        description: tx.invoice_number
          ? `Invoice #${tx.invoice_number}`
          : tx.notes ?? tx.transaction_type,
        source: tx.transaction_type,
        invoice_number: tx.invoice_number ?? null,
        spend_amount_jpy: tx.spend_amount_jpy ?? null,
        tier_multiplier: null,
      })),
    [loyaltyTxs],
  );

  setLoyaltyData(memberData, tiers, transactions, data.active_promo ?? null);

  // ── Tier celebration trigger ────────────────────────────────────
  // Compares the current tier to the value stored in localStorage
  // under a customer-scoped key. Only fires when there's a previously
  // stored tier and it differs from the current one.
  const [celebration, setCelebration] = useState<{ tier: TierName } | null>(null);

  useEffect(() => {
    if (!currentTierName) return;
    const key = tierStorageKey(data.customer_id);
    const lastSeen = (() => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    })();

    if (!lastSeen) {
      try {
        window.localStorage.setItem(key, currentTierName);
      } catch {
        /* ignore quota / private-mode */
      }
      return;
    }

    if (lastSeen !== currentTierName) {
      setCelebration({ tier: currentTierName });
    }
  }, [currentTierName, data.customer_id]);

  function handleCelebrationClose() {
    if (celebration) {
      try {
        window.localStorage.setItem(
          tierStorageKey(data.customer_id),
          celebration.tier,
        );
      } catch {
        /* ignore */
      }
    }
    setCelebration(null);
    queryClient.invalidateQueries({ queryKey: ['portal', portalToken] });
  }

  const canRedeem = (loyaltyMember?.remaining_points ?? 0) > 0;

  return (
    <div className="loyalty-portal">
      <div className="pb-24">
        {tab === 'home' && (
          <HomeScreen
            canRedeem={canRedeem}
            onRedeemClick={() => setIsRedemptionOpen(true)}
            setTab={setTab}
            unreadCount={data.unread_count ?? 0}
            latestUnread={(() => {
              const first = (data.notifications ?? []).find((n) => !n.is_read);
              return first ? { title: first.title, body: first.body } : null;
            })()}
          />
        )}
        {tab === 'rewards' && <RewardsScreen />}
        {tab === 'points' && <PointsScreen />}
        {tab === 'notifications' && (
          <NotificationsScreen
            notifications={data.notifications ?? []}
            portalToken={portalToken}
            sessionId={null}
            onSetTab={setTab}
          />
        )}
        {tab === 'profile' && <ProfileScreen setTab={setTab} />}
        {tab === 'tiers' && <TiersScreen onBack={() => setTab('home')} />}
      </div>

      <LoyaltyBottomNav
        active={tab}
        unreadCount={data.unread_count ?? 0}
        onChange={setTab}
      />

      <RedemptionForm
        isOpen={isRedemptionOpen}
        onClose={() => setIsRedemptionOpen(false)}
        remainingPoints={loyaltyMember?.remaining_points ?? 0}
        customerId={data.customer_id}
        memberId={member.id}
        portalToken={portalToken}
        onSuccess={() =>
          queryClient.invalidateQueries({ queryKey: ['portal', portalToken] })
        }
      />

      <TierCelebrationModal
        tierName={celebration?.tier ?? currentTierName}
        isOpen={celebration !== null}
        onClose={handleCelebrationClose}
      />
    </div>
  );
}

async function fetchPortal(args: {
  authMode: 'session' | 'token';
  token: string;
  accessToken: string | null;
}): Promise<PortalData> {
  let url: string;
  const headers: Record<string, string> = { apikey: SUPABASE_KEY };

  if (args.authMode === 'session' && args.accessToken) {
    // Session-auth path: Bearer JWT in Authorization header, no token param
    url = `${SUPABASE_URL}/functions/v1/customer-portal`;
    headers['Authorization'] = `Bearer ${args.accessToken}`;
  } else if (args.authMode === 'token' && args.token) {
    // Token-auth path: ?token=X URL param (legacy behavior)
    url = `${SUPABASE_URL}/functions/v1/customer-portal?token=${encodeURIComponent(args.token)}`;
  } else {
    throw new Error('No auth provided to fetchPortal');
  }

  const res = await fetch(url, { headers });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || 'Access denied');
  return json as PortalData;
}

export default function LoyaltyPortal() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  // Branded 3-second splash, matching CustomerPortal.tsx. The state hook
  // sits with the other top-level hooks; the conditional early-return
  // happens after every hook below has been registered, to avoid
  // violating the Rules of Hooks when showSplash flips.
  const [showSplash, setShowSplash] = useState(true);

  // ── Auth mode state (Phase B) ──
  // 'session' = signed in via Supabase Auth (email/password customer)
  // 'token'   = legacy ?token= URL param flow
  // null      = bootstrapping OR no auth at all (will redirect to /portal/login)
  const [authMode, setAuthMode] = useState<'session' | 'token' | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  // Bootstrap auth mode on mount: check session first, fall back to token
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session) {
        setAuthMode('session');
        setAccessToken(session.access_token);
      } else if (token) {
        setAuthMode('token');
      } else {
        setAuthMode(null);
      }
      setBootstrapping(false);
    });
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const portalQuery = useQuery({
    queryKey: ['portal', authMode, accessToken, token],
    queryFn: () => fetchPortal({ authMode: authMode!, token, accessToken }),
    enabled: authMode !== null && !bootstrapping,
    staleTime: 30_000,
    refetchOnMount: true,
  });

  // Redirect to portal login when no auth detected, or on fetch error.
  useEffect(() => {
    if (bootstrapping) return;
    if (authMode === null) {
      navigate('/portal/login', { replace: true });
      return;
    }
    if (portalQuery.isError) {
      const msg = (portalQuery.error as Error)?.message || 'Unable to load your loyalty status';
      toast.error(msg);
      navigate('/portal/login', { replace: true });
    }
  }, [bootstrapping, authMode, portalQuery.isError, portalQuery.error, navigate]);

  const access = useLoyaltyAccess(portalQuery.data?.customer_id ?? null);

  const customerForChild = useMemo(() => {
    if (!portalQuery.data) return null;
    return {
      customer_id: portalQuery.data.customer_id,
      email: portalQuery.data.profile?.email ?? null,
    };
  }, [portalQuery.data]);

  // Splash early-return — placed after every hook above so React's Rules
  // of Hooks aren't violated when showSplash flips. Mirrors the placement
  // in CustomerPortal.tsx (line ~397, after fetchPortal's useEffect).
  if (showSplash) {
    return <LoyaltySplashScreen onComplete={() => setShowSplash(false)} />;
  }

  if (portalQuery.isLoading) {
    return <LoadingState message="Validating your access…" />;
  }
  if (!portalQuery.data) {
    // Error already toasted + redirected; render placeholder while route unwinds.
    return <FullScreenWrap><div /></FullScreenWrap>;
  }
  if (access.isLoading) {
    return <LoadingState message="Loading your loyalty status…" />;
  }

  const data = portalQuery.data;
  const member = data.loyalty_member;

  // The hook's access.isBeta is unreliable here — the portal-token
  // session has no auth and RLS blocks loyalty_beta_members reads. Use
  // the server-resolved is_loyalty_beta from customer-portal instead.
  const hasAccess = access.isFeatureEnabled || !!data.is_loyalty_beta;

  // Routing decision:
  //   - !hasAccess              → ComingSoon
  //   - hasAccess && !member    → JoinPrompt
  //   - hasAccess && member     → MemberView (full stack)
  if (!hasAccess) {
    return (
      <FullScreenWrap>
        <TopBar authMode={authMode} token={token} />
        <div className="flex flex-col items-center px-4 py-8 sm:py-12">
          <LoyaltyComingSoon
            customerEmail={customerForChild?.email ?? null}
            customerId={customerForChild?.customer_id ?? null}
          />
        </div>
      </FullScreenWrap>
    );
  }

  if (!member) {
    return (
      <FullScreenWrap>
        <TopBar authMode={authMode} token={token} />
        <div className="flex flex-col items-center px-4 py-8 sm:py-12">
          <LoyaltyJoinPrompt
            portalToken={token}
            customerId={data.customer_id}
          />
        </div>
      </FullScreenWrap>
    );
  }

  return (
    <FullScreenWrap>
      <TopBar authMode={authMode} token={token} />
      <MemberView data={data} member={member} portalToken={token} />
    </FullScreenWrap>
  );
}
