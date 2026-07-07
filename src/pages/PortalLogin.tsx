import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import PageMeta from '@/components/seo/PageMeta';

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
      <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background">
        <p className="text-primary text-sm tracking-[0.2em] uppercase">Loading…</p>
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
      <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background px-4 py-10">
        <div
          className={`w-full max-w-sm rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-8 sm:p-10 transition-all duration-500 ${
            mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
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
              className="text-[10px] uppercase mt-2 text-muted-foreground"
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
                className="w-full h-12 px-4 rounded-lg text-sm text-foreground bg-input border border-border outline-none transition-all duration-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
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
                className="w-full h-12 px-4 rounded-lg text-sm text-foreground bg-input border border-border outline-none transition-all duration-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm uppercase transition-all duration-300 hover:opacity-90 disabled:opacity-50"
              style={{ letterSpacing: '0.15em' }}
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <div className="flex items-center justify-between mt-6">
            <button
              type="button"
              onClick={() => navigate('/portal/forgot-password')}
              className="text-[11px] tracking-wide text-muted-foreground hover:text-primary transition-colors"
            >
              Forgot password?
            </button>
            <button
              type="button"
              onClick={() => navigate('/portal/setup')}
              className="text-[11px] tracking-wide text-muted-foreground hover:text-primary transition-colors"
            >
              First time? Set up
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
