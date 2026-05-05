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
      <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#C9A84C' }}>Verifying reset link…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#111', border: '1px solid #C9A84C', borderRadius: 12, padding: 40, width: 380, boxSizing: 'border-box' }}>
        <p style={{ color: '#C9A84C', fontFamily: 'Georgia, serif', fontSize: 22, marginBottom: 4, textAlign: 'center' }}>Cha Jewels</p>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, textAlign: 'center', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 28 }}>Customer Portal</p>

        <h2 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6 }}>Set new password</h2>
        <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>Enter your new password below.</p>

        <label style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>New Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
        />

        <label style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Confirm Password</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm your new password"
          autoComplete="new-password"
          style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 20, boxSizing: 'border-box', fontSize: 14 }}
        />

        <button
          onClick={handleReset}
          disabled={loading}
          style={{ width: '100%', padding: 12, background: '#C9A84C', border: 'none', borderRadius: 8, color: '#0a0a0a', fontWeight: 700, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Updating…' : 'Update Password'}
        </button>

        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button
            onClick={() => navigate('/portal/login')}
            style={{ background: 'none', border: 'none', color: '#C9A84C', fontSize: 12, cursor: 'pointer', padding: 0 }}
          >
            ← Back to Sign In
          </button>
        </div>
      </div>
    </div>
  );
}
