import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();

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
    if (password.length < 8) return toast.error('Password must be at least 8 characters');
    if (password !== confirm) return toast.error('Passwords do not match');
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success('Password updated successfully');
    navigate('/login');
  };

  if (!ready) return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#C9A84C' }}>Verifying reset link...</p>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#111', border: '1px solid #C9A84C', borderRadius: 12, padding: 40, width: 380 }}>
        <h2 style={{ color: '#C9A84C', fontFamily: 'Georgia, serif', marginBottom: 8 }}>Set New Password</h2>
        <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>Enter your new password below.</p>
        <input type="password" placeholder="New password (min 8 chars)" value={password}
          onChange={e => setPassword(e.target.value)}
          style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 12, boxSizing: 'border-box' }} />
        <input type="password" placeholder="Confirm new password" value={confirm}
          onChange={e => setConfirm(e.target.value)}
          style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 20, boxSizing: 'border-box' }} />
        <button onClick={handleReset} disabled={loading}
          style={{ width: '100%', padding: '12px', background: '#C9A84C', border: 'none', borderRadius: 8, color: '#0a0a0a', fontWeight: 700, cursor: 'pointer' }}>
          {loading ? 'Updating...' : 'Update Password'}
        </button>
        <p style={{ textAlign: 'center', marginTop: 16 }}>
          <a href="/login" style={{ color: '#C9A84C', fontSize: 13 }}>Back to Login</a>
        </p>
      </div>
    </div>
  );
}
