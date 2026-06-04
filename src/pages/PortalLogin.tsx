import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import PageMeta from '@/components/seo/PageMeta';

const GOLD = '#D4AF37';
const GOLD_HOVER = '#E8C547';
const INPUT_BORDER = 'rgba(255,255,255,0.08)';

const PORTAL_HERO =
  'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/brand-assets/IMG_4761.jpeg';

export default function PortalLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [mounted, setMounted] = useState(false);

  // If already signed in, redirect to portal immediately
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session) {
        navigate('/portal', { replace: true });
      } else {
        setCheckingSession(false);
      }
    });
    return () => { mounted = false; };
  }, [navigate]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error('Please enter your email and password');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Welcome back to Cha Jewels');
    navigate('/portal', { replace: true });
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen relative flex items-center justify-center">
        <img
          src={PORTAL_HERO}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover lg:object-contain"
        />
        <div
          className="absolute inset-0"
          style={{ background: 'rgba(10,8,6,0.70)' }}
        />
        <p className="relative z-10 text-primary text-sm tracking-[0.2em] uppercase">Loading…</p>
      </div>
    );
  }

  return (
    <>
      <PageMeta
        title="Sign in — Cha Jewels Customer Portal"
        description="Sign in to your Cha Jewels customer portal to view layaway accounts, payment schedules, statements, and submit proof of payment."
        path="/portal/login"
      />
      <div className="min-h-screen relative flex items-center justify-center px-4">
        {/* Full-screen background image with dark overlay */}
        <img
          src={PORTAL_HERO}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover lg:object-contain"
        />
        <div
          className="absolute inset-0"
          style={{ background: 'rgba(10,8,6,0.70)' }}
        />

        {/* Centered card */}
        <div
          className={`glass-panel relative z-10 w-full max-w-sm rounded-2xl p-8 sm:p-10 transition-all duration-700 ${
            mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
          }`}
        >
          {/* Brand block */}
          <div className="text-center mb-8">
            <p
              className="font-display text-primary text-2xl"
              style={{ letterSpacing: '0.3em' }}
            >
              Cha Jewels
            </p>
            <p
              className="text-[10px] uppercase mt-2 text-foreground/50"
              style={{ letterSpacing: '0.2em' }}
            >
              Customer Portal
            </p>
          </div>

          {/* Heading */}
          <h1 className="font-display text-foreground text-lg mb-1">
            Welcome back to your Cha Jewels Portal
          </h1>
          <p className="text-muted-foreground text-sm mb-6">
            Sign in to access your accounts
          </p>

          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-1.5">
              <label
                htmlFor="portal-login-email"
                className="text-[10px] uppercase block text-primary"
                style={{ letterSpacing: '0.2em' }}
              >
                Email
              </label>
              <input
                id="portal-login-email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full h-11 px-4 rounded-lg text-sm text-white bg-white/[0.04] border border-white/[0.08] outline-none transition-all duration-300"
                onFocus={(e) => {
                  e.target.style.borderColor = GOLD;
                  e.target.style.boxShadow = '0 0 0 1px rgba(212,175,55,0.2)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = INPUT_BORDER;
                  e.target.style.boxShadow = 'none';
                }}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="portal-login-password"
                className="text-[10px] uppercase block text-primary"
                style={{ letterSpacing: '0.2em' }}
              >
                Password
              </label>
              <input
                id="portal-login-password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                className="w-full h-11 px-4 rounded-lg text-sm text-white bg-white/[0.04] border border-white/[0.08] outline-none transition-all duration-300"
                onFocus={(e) => {
                  e.target.style.borderColor = GOLD;
                  e.target.style.boxShadow = '0 0 0 1px rgba(212,175,55,0.2)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = INPUT_BORDER;
                  e.target.style.boxShadow = 'none';
                }}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full h-11 rounded-lg bg-primary font-semibold text-sm uppercase transition-all duration-300 disabled:opacity-50"
              style={{
                color: '#0A0A0A',
                letterSpacing: '0.15em',
              }}
              onMouseEnter={(e) => {
                if (loading) return;
                e.currentTarget.style.background = GOLD_HOVER;
                e.currentTarget.style.boxShadow = '0 4px 20px rgba(212,175,55,0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <div className="flex items-center justify-between mt-6">
            <button
              type="button"
              onClick={() => navigate('/portal/forgot-password')}
              className="text-[11px] tracking-wide text-white/50 hover:text-primary transition-colors"
            >
              Forgot password?
            </button>
            <button
              type="button"
              onClick={() => navigate('/portal/setup')}
              className="text-[11px] tracking-wide text-white/50 hover:text-primary transition-colors"
            >
              First time? Set up
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
