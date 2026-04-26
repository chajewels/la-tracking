import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Diamond } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useLoyaltyAccess } from '@/hooks/useLoyaltyAccess';
import { LoyaltyComingSoon } from '@/components/loyalty/LoyaltyComingSoon';
import { LoyaltyJoinPrompt } from '@/components/loyalty/LoyaltyJoinPrompt';
import { MemberCard } from '@/components/loyalty/MemberCard';
import { PointsSnapshot } from '@/components/loyalty/PointsSnapshot';
import { VipProgressSection, type TierRow } from '@/components/loyalty/VipProgressSection';
import { RecentActivity, type LoyaltyTxRow } from '@/components/loyalty/RecentActivity';
import { RedemptionForm } from '@/components/loyalty/RedemptionForm';
import { TierCelebrationModal } from '@/components/loyalty/TierCelebrationModal';
import SplashScreen from '@/components/portal/SplashScreen';

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

interface PortalData {
  customer_id: string;
  customer_name: string;
  customer_code: string;
  profile: { email: string | null; full_name: string | null } & Record<string, unknown>;
  loyalty_member: LoyaltyMember | null;
  loyalty_tiers: TierRow[];
  loyalty_transactions: LoyaltyTxRow[];
  /**
   * Server-resolved beta whitelist flag. customer-portal reads
   * loyalty_beta_members with the service role because the table's RLS
   * denies anon SELECT — the browser-side useLoyaltyAccess check would
   * silently return false for any portal-token session.
   */
  is_loyalty_beta?: boolean;
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

function TopBar({ token }: { token: string }) {
  const navigate = useNavigate();
  return (
    <div
      className="flex items-center justify-between px-4 py-3"
      style={{ borderBottom: `1px solid ${P.br}` }}
    >
      <button
        onClick={() => navigate(`/portal?token=${encodeURIComponent(token)}`)}
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

  const currentTier = member.current_tier;
  const currentTierName = currentTier?.name ?? '';
  const multiplier = currentTier?.points_multiplier ?? 1;

  // Tier celebration trigger — compares the current tier to the value
  // stored in localStorage under a customer-scoped key. Only fires when
  // there's a previously stored tier and it differs from the current one.
  const [celebration, setCelebration] = useState<{ oldTier: string; newTier: string } | null>(
    null,
  );

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
      setCelebration({ oldTier: lastSeen, newTier: currentTierName });
    }
  }, [currentTierName, data.customer_id]);

  function handleCelebrationClose() {
    if (celebration) {
      try {
        window.localStorage.setItem(
          tierStorageKey(data.customer_id),
          celebration.newTier,
        );
      } catch {
        /* ignore */
      }
    }
    setCelebration(null);
    queryClient.invalidateQueries({ queryKey: ['portal', portalToken] });
  }

  const canRedeem = member.remaining_points > 0;

  return (
    <>
      <div className="flex flex-col items-center gap-6 px-4 py-6 sm:py-10">
        <MemberCard
          customerName={data.customer_name}
          customerCode={data.customer_code}
          tierName={currentTierName || 'Glimmer'}
          isDowngraded={member.is_downgraded}
        />

        <PointsSnapshot
          remainingPoints={member.remaining_points}
          totalEarned={member.total_points_earned}
          totalRedeemed={member.total_points_redeemed}
        />

        <VipProgressSection
          currentTierName={currentTierName || 'Glimmer'}
          cumulativeSpendJpy={member.cumulative_spend_jpy}
          tiers={data.loyalty_tiers}
        />

        <Button
          onClick={() => setIsRedemptionOpen(true)}
          disabled={!canRedeem}
          className="w-full max-w-md"
          style={{
            background: canRedeem ? P.gr : P.s2,
            color: canRedeem ? '#1A1500' : P.ts,
            fontWeight: 600,
            border: 'none',
          }}
        >
          {canRedeem ? '💎 Redeem Points' : 'No points to redeem yet'}
        </Button>

        <RecentActivity transactions={data.loyalty_transactions} maxItems={10} />
      </div>

      <RedemptionForm
        isOpen={isRedemptionOpen}
        onClose={() => setIsRedemptionOpen(false)}
        remainingPoints={member.remaining_points}
        customerId={data.customer_id}
        memberId={member.id}
        portalToken={portalToken}
        onSuccess={() =>
          queryClient.invalidateQueries({ queryKey: ['portal', portalToken] })
        }
      />

      <TierCelebrationModal
        isOpen={celebration !== null}
        onClose={handleCelebrationClose}
        oldTier={celebration?.oldTier ?? ''}
        newTier={celebration?.newTier ?? ''}
        multiplier={multiplier}
      />
    </>
  );
}

async function fetchPortal(token: string): Promise<PortalData> {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/customer-portal?token=${encodeURIComponent(token)}`,
    { headers: { apikey: SUPABASE_KEY } },
  );
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

  const portalQuery = useQuery({
    queryKey: ['portal', token],
    queryFn: () => fetchPortal(token),
    enabled: !!token,
    staleTime: 30_000,
    refetchOnMount: true,
  });

  // Bail out + redirect if token missing or fetch failed.
  useEffect(() => {
    if (!token) {
      toast.error('No access token provided');
      navigate('/');
      return;
    }
    if (portalQuery.isError) {
      const msg = (portalQuery.error as Error)?.message || 'Unable to load your loyalty status';
      toast.error(msg);
      navigate('/');
    }
  }, [token, portalQuery.isError, portalQuery.error, navigate]);

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
    return <SplashScreen onComplete={() => setShowSplash(false)} />;
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
        <TopBar token={token} />
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
        <TopBar token={token} />
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
      <TopBar token={token} />
      <MemberView data={data} member={member} portalToken={token} />
    </FullScreenWrap>
  );
}
