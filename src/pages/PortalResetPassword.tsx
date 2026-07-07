import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      toast.error('Passwords do not match');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Password updated successfully');
    navigate('/portal/login', { replace: true });
  };

  if (!ready) {
    return (
      <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background">
        <p className="text-primary text-sm">Verifying reset link…</p>
      </div>
    );
  }

  return (
    <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-8 sm:p-10">
        <p className="font-display text-primary text-2xl text-center mb-1" style={{ letterSpacing: '0.3em' }}>Cha Jewels</p>
        <p className="text-[10px] uppercase text-center text-muted-foreground mb-7" style={{ letterSpacing: '0.2em' }}>Customer Portal</p>

        <h1 className="font-display text-foreground text-lg mb-1.5">Set a new portal password</h1>
        <p className="text-muted-foreground text-sm mb-6">Enter your new password below.</p>

        <form onSubmit={(e) => { e.preventDefault(); handleReset(); }} className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="portal-reset-password" className="text-[10px] uppercase block text-primary" style={{ letterSpacing: '0.2em' }}>New Password</label>
            <input
              id="portal-reset-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              className="w-full h-12 px-4 rounded-lg text-sm text-foreground bg-input border border-border outline-none transition-all duration-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="portal-reset-confirm" className="text-[10px] uppercase block text-primary" style={{ letterSpacing: '0.2em' }}>Confirm Password</label>
            <input
              id="portal-reset-confirm"
              name="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm your new password"
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
            {loading ? 'Updating…' : 'Update Password'}
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
      </div>
    </div>
  );
}
