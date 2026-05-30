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
      <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#C9A84C' }}>Loading…</p>
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
    <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#111', border: '1px solid #C9A84C', borderRadius: 12, padding: 40, width: 380, boxSizing: 'border-box' }}>
        <p style={{ color: '#C9A84C', fontFamily: 'Georgia, serif', fontSize: 22, marginBottom: 4, textAlign: 'center' }}>Cha Jewels</p>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, textAlign: 'center', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 28 }}>Customer Portal</p>

        <h1 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6, fontWeight: 400 }}>Welcome back to your Cha Jewels Portal</h1>
        <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>Sign in to access your accounts</p>

        <form onSubmit={handleLogin}>
          <label htmlFor="portal-login-email" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Email</label>
          <input
            id="portal-login-email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
          />

          <label htmlFor="portal-login-password" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Password</label>
          <input
            id="portal-login-password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            autoComplete="current-password"
            style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 20, boxSizing: 'border-box', fontSize: 14 }}
          />

          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            style={{ width: '100%', padding: 12, background: '#C9A84C', border: 'none', borderRadius: 8, color: '#0a0a0a', fontWeight: 700, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
          <button
            onClick={() => navigate('/portal/forgot-password')}
            style={{ background: 'none', border: 'none', color: '#C9A84C', fontSize: 12, cursor: 'pointer', padding: 0 }}
          >
            Forgot password?
          </button>
          <button
            onClick={() => navigate('/portal/setup')}
            style={{ background: 'none', border: 'none', color: '#C9A84C', fontSize: 12, cursor: 'pointer', padding: 0 }}
          >
            First time? Set up
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
