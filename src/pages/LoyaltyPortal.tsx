import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Diamond } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useLoyaltyAccess } from '@/hooks/useLoyaltyAccess';
import { LoyaltyComingSoon } from '@/components/loyalty/LoyaltyComingSoon';
import { LoyaltyJoinPrompt } from '@/components/loyalty/LoyaltyJoinPrompt';

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

interface PortalCustomer {
  customer_id: string;
  customer_name: string;
  email: string | null;
}

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

function MemberPlaceholder({ customerName }: { customerName: string }) {
  return (
    <div
      className="mx-auto w-full max-w-md rounded-2xl p-6 sm:p-8"
      style={{
        background: P.s,
        border: `1px solid ${P.br}`,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div
        className="mb-2 text-center text-2xl sm:text-3xl"
        style={{ fontFamily: CG, color: P.tp, letterSpacing: '0.02em' }}
      >
        Welcome back, {customerName.split(' ')[0]}
      </div>
      <p className="mb-6 text-center text-sm" style={{ color: P.ts }}>
        Your loyalty hub is just around the corner.
      </p>
      <div
        className="rounded-md px-4 py-3 text-center text-xs"
        style={{ background: P.s2, color: P.ts, border: `1px dashed ${P.br}` }}
      >
        &lt;MemberCard /&gt; placeholder — Phase 3.3 will port this from cha-jewels-circle
      </div>
    </div>
  );
}

export default function LoyaltyPortal() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [customer, setCustomer] = useState<PortalCustomer | null>(null);
  const [validating, setValidating] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function validate() {
      if (!token) {
        toast.error('No access token provided');
        navigate('/');
        return;
      }
      try {
        const res = await fetch(
          `${SUPABASE_URL}/functions/v1/customer-portal?token=${encodeURIComponent(token)}`,
          { headers: { apikey: SUPABASE_KEY } },
        );
        const json = await res.json();
        if (!res.ok) {
          toast.error(json.error || 'Access denied');
          navigate('/');
          return;
        }
        if (cancelled) return;
        setCustomer({
          customer_id: json.customer_id,
          customer_name: json.customer_name || json.profile?.full_name || 'Valued Customer',
          email: json.profile?.email ?? null,
        });
      } catch {
        if (cancelled) return;
        toast.error('Unable to load your loyalty status. Please try again.');
        navigate('/');
      } finally {
        if (!cancelled) setValidating(false);
      }
    }
    validate();
    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  const access = useLoyaltyAccess(customer?.customer_id ?? null);

  if (validating) {
    return <LoadingState message="Validating your access…" />;
  }
  if (!customer) {
    // Validation already toasted + redirected; render nothing while it unwinds.
    return <FullScreenWrap><div /></FullScreenWrap>;
  }
  if (access.isLoading) {
    return <LoadingState message="Loading your loyalty status…" />;
  }

  const body = !access.hasAccess ? (
    <LoyaltyComingSoon customerEmail={customer.email} customerId={customer.customer_id} />
  ) : access.isMember ? (
    <MemberPlaceholder customerName={customer.customer_name} />
  ) : (
    <LoyaltyJoinPrompt
      portalToken={token}
      customerId={customer.customer_id}
    />
  );

  return (
    <FullScreenWrap>
      <TopBar token={token} />
      <div className="flex flex-col items-center px-4 py-8 sm:py-12">
        {body}
        <div className="mt-6">
          <Button
            variant="ghost"
            onClick={() => navigate(`/portal?token=${encodeURIComponent(token)}`)}
            style={{ color: P.ts }}
          >
            ← Back to Portal
          </Button>
        </div>
      </div>
    </FullScreenWrap>
  );
}
