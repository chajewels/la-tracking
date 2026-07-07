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
      <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background">
        <p className="text-primary text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-8 sm:p-10">
        <p className="font-display text-primary text-2xl text-center mb-1" style={{ letterSpacing: '0.3em' }}>Cha Jewels</p>
        <p className="text-[10px] uppercase text-center text-muted-foreground mb-7" style={{ letterSpacing: '0.2em' }}>Customer Portal</p>

        {sent ? (
          <>
            <h1 className="font-display text-foreground text-lg mb-1.5">Check your inbox</h1>
            <p className="text-muted-foreground text-sm mb-3">A password reset link has been sent to:</p>
            <p className="text-primary text-sm mb-5 break-all">{sentEmail}</p>
            <p className="text-muted-foreground text-xs leading-relaxed mb-6">
              Didn't receive it? Check your spam folder, or try again in a few minutes.
            </p>
            <button
              onClick={() => navigate('/portal/login')}
              className="w-full h-12 rounded-lg border border-primary text-primary font-semibold text-sm transition-colors hover:bg-primary/5"
            >
              Back to Sign In
            </button>
          </>
        ) : (
          <>
            <h1 className="font-display text-foreground text-lg mb-1.5">Reset your portal password</h1>
            <p className="text-muted-foreground text-sm mb-6">Enter your email to receive a reset link</p>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-1.5">
                <label htmlFor="portal-forgot-email" className="text-[10px] uppercase block text-primary" style={{ letterSpacing: '0.2em' }}>Email</label>
                <input
                  id="portal-forgot-email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className="w-full h-12 px-4 rounded-lg text-sm text-foreground bg-input border border-border outline-none transition-all duration-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90 disabled:opacity-50"
              >
                {loading ? 'Sending…' : 'Send Reset Email'}
              </button>
            </form>

            <div className="text-center mt-5">
              <button
                onClick={() => navigate('/portal/login')}
                className="text-primary text-xs hover:opacity-80 transition-opacity"
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
