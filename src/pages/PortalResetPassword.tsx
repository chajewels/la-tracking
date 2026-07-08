import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { pt } from '@/i18n/portal';

export default function PortalResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | null = null;

    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        setReady(true);
      } else {
        const { data } = supabase.auth.onAuthStateChange((event, session) => {
          if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
            setReady(true);
          }
        });
        subscription = data.subscription;
      }
    };
    checkSession();

    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  const handleReset = async () => {
    if (password.length < 8) {
      toast.error(pt('auth.errPasswordMin'));
      return;
    }
    if (password !== confirm) {
      toast.error(pt('auth.errPasswordMismatch'));
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(pt('auth.passwordUpdated'));
    navigate('/portal/login', { replace: true });
  };

  if (!ready) {
    return (
      <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background">
        <p className="text-primary text-sm">{pt('auth.verifyingResetLink')}</p>
      </div>
    );
  }

  return (
    <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-8 sm:p-10">
        <p className="font-display text-primary text-2xl text-center mb-1" style={{ letterSpacing: '0.3em' }}>{pt('common.chaJewels')}</p>
        <p className="text-[10px] uppercase text-center text-muted-foreground mb-7" style={{ letterSpacing: '0.2em' }}>{pt('common.customerPortal')}</p>

        <h1 className="font-display text-foreground text-lg mb-1.5">{pt('auth.resetHeading')}</h1>
        <p className="text-muted-foreground text-sm mb-6">{pt('auth.resetSubtitle')}</p>

        <form onSubmit={(e) => { e.preventDefault(); handleReset(); }} className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="portal-reset-password" className="text-[10px] uppercase block text-primary" style={{ letterSpacing: '0.2em' }}>{pt('auth.newPassword')}</label>
            <input
              id="portal-reset-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={pt('auth.min8Chars')}
              autoComplete="new-password"
              className="w-full h-12 px-4 rounded-lg text-sm text-foreground bg-input border border-border outline-none transition-all duration-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="portal-reset-confirm" className="text-[10px] uppercase block text-primary" style={{ letterSpacing: '0.2em' }}>{pt('auth.confirmPassword')}</label>
            <input
              id="portal-reset-confirm"
              name="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={pt('auth.confirmNewPlaceholder')}
              autoComplete="new-password"
              className="w-full h-12 px-4 rounded-lg text-sm text-foreground bg-input border border-border outline-none transition-all duration-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90 disabled:opacity-50"
          >
            {loading ? pt('auth.updating') : pt('auth.updatePassword')}
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
      </div>
    </div>
  );
}
