import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export default function PortalForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [sentEmail, setSentEmail] = useState('');
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error('Please enter your email address');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/portal/reset-password`,
    });
    setLoading(false);
    if (error) {
      toast.error('Failed to send reset email. Please try again.');
      return;
    }
    setSentEmail(email);
    setSent(true);
  };

  if (checkingSession) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#C9A84C' }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#111', border: '1px solid #C9A84C', borderRadius: 12, padding: 40, width: 380, boxSizing: 'border-box' }}>
        <p style={{ color: '#C9A84C', fontFamily: 'Georgia, serif', fontSize: 22, marginBottom: 4, textAlign: 'center' }}>Cha Jewels</p>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, textAlign: 'center', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 28 }}>Customer Portal</p>

        {sent ? (
          <>
            <h2 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6 }}>Check your inbox</h2>
            <p style={{ color: '#888', fontSize: 13, marginBottom: 12 }}>
              A password reset link has been sent to:
            </p>
            <p style={{ color: '#C9A84C', fontSize: 14, marginBottom: 20, wordBreak: 'break-all' }}>{sentEmail}</p>
            <p style={{ color: '#666', fontSize: 12, marginBottom: 24, lineHeight: 1.6 }}>
              Didn't receive it? Check your spam folder, or try again in a few minutes.
            </p>
            <button
              onClick={() => navigate('/portal/login')}
              style={{ width: '100%', padding: 12, background: 'transparent', border: '1px solid #C9A84C', borderRadius: 8, color: '#C9A84C', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            >
              Back to Sign In
            </button>
          </>
        ) : (
          <>
            <h2 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6 }}>Reset password</h2>
            <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>Enter your email to receive a reset link</p>

            <form onSubmit={handleSubmit}>
              <label htmlFor="portal-forgot-email" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Email</label>
              <input
                id="portal-forgot-email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 20, boxSizing: 'border-box', fontSize: 14 }}
              />

              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                style={{ width: '100%', padding: 12, background: '#C9A84C', border: 'none', borderRadius: 8, color: '#0a0a0a', fontWeight: 700, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
              >
                {loading ? 'Sending…' : 'Send Reset Email'}
              </button>
            </form>

            <div style={{ textAlign: 'center', marginTop: 20 }}>
              <button
                onClick={() => navigate('/portal/login')}
                style={{ background: 'none', border: 'none', color: '#C9A84C', fontSize: 12, cursor: 'pointer', padding: 0 }}
              >
                ← Back to Sign In
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
