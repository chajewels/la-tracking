import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { pt } from '@/i18n/portal';

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
      toast.error(pt('auth.errEnterEmail'));
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/portal/reset-password`,
    });
    setLoading(false);
    if (error) {
      toast.error(pt('auth.errResetSendFailed'));
      return;
    }
    setSentEmail(email);
    setSent(true);
  };

  if (checkingSession) {
    return (
      <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background">
        <p className="text-primary text-sm">{pt('common.loading')}</p>
      </div>
    );
  }

  return (
    <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-8 sm:p-10">
        <p className="font-display text-primary text-2xl text-center mb-1" style={{ letterSpacing: '0.3em' }}>{pt('common.chaJewels')}</p>
        <p className="text-[10px] uppercase text-center text-muted-foreground mb-7" style={{ letterSpacing: '0.2em' }}>{pt('common.customerPortal')}</p>

        {sent ? (
          <>
            <h1 className="font-display text-foreground text-lg mb-1.5">{pt('auth.checkInboxTitle')}</h1>
            <p className="text-muted-foreground text-sm mb-3">{pt('auth.resetLinkSentTo')}</p>
            <p className="text-primary text-sm mb-5 break-all">{sentEmail}</p>
            <p className="text-muted-foreground text-xs leading-relaxed mb-6">
              {pt('auth.didntReceive')}
            </p>
            <button
              onClick={() => navigate('/portal/login')}
              className="w-full h-12 rounded-lg border border-primary text-primary font-semibold text-sm transition-colors hover:bg-primary/5"
            >
              {pt('auth.backToSignIn')}
            </button>
          </>
        ) : (
          <>
            <h1 className="font-display text-foreground text-lg mb-1.5">{pt('auth.forgotHeading')}</h1>
            <p className="text-muted-foreground text-sm mb-6">{pt('auth.forgotSubtitle')}</p>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-1.5">
                <label htmlFor="portal-forgot-email" className="text-[10px] uppercase block text-primary" style={{ letterSpacing: '0.2em' }}>{pt('auth.email')}</label>
                <input
                  id="portal-forgot-email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={pt('auth.emailPlaceholder')}
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
                {loading ? pt('auth.sending') : pt('auth.sendResetEmail')}
              </button>
            </form>

            <div className="text-center mt-5">
              <button
                onClick={() => navigate('/portal/login')}
                className="text-primary text-xs hover:opacity-80 transition-opacity"
              >
                {pt('auth.backToSignInArrow')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
