import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type SetupState = 'form' | 'check-email' | 'linking' | 'error-no-customer' | 'error-conflict';

export default function PortalSetup() {
  const navigate = useNavigate();
  const [state, setState] = useState<SetupState>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [bootstrapping, setBootstrapping] = useState(true);

  // Call setup-customer-account edge function with the current session's JWT
  const linkCustomerAccount = async () => {
    setState('linking');
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setErrorMessage('Authentication session lost. Please sign in again.');
        setState('error-conflict');
        return;
      }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/setup-customer-account`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
        },
      });

      const result = await res.json();

      if (res.ok && result.success) {
        toast.success('Account linked successfully');
        navigate('/portal', { replace: true });
        return;
      }

      // Handle specific error states
      if (res.status === 404) {
        setErrorMessage('We couldn’t find a customer record for this email. Please contact Cha Jewels for help.');
        setState('error-no-customer');
      } else if (res.status === 409) {
        setErrorMessage(result.error || 'This email is already linked to a different account.');
        setState('error-conflict');
      } else {
        setErrorMessage(result.error || 'Failed to link your account. Please try again or contact support.');
        setState('error-conflict');
      }
    } catch (err: any) {
      setErrorMessage('Network error. Please check your connection and try again.');
      setState('error-conflict');
    } finally {
      setLoading(false);
    }
  };

  // On mount: check for existing session
  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session) {
        // User is signed in (verified) — proceed with linking
        linkCustomerAccount();
      } else {
        setBootstrapping(false);
      }
    });

    // Listen for SIGNED_IN event (verification just completed in this tab)
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === 'SIGNED_IN' && session && state === 'check-email') {
        linkCustomerAccount();
      }
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email) {
      toast.error('Please enter your email');
      return;
    }
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      toast.error('Passwords do not match');
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: 'https://portal.chajewelsjp.com/portal/setup',
      },
    });
    setLoading(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    setSubmittedEmail(email);
    setState('check-email');
  };

  const handleSignOutAndRetry = async () => {
    await supabase.auth.signOut();
    setState('form');
    setEmail('');
    setPassword('');
    setConfirm('');
    setErrorMessage('');
  };

  if (bootstrapping) {
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

        {state === 'form' && (
          <>
            <h2 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6 }}>Set up your account</h2>
            <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>Use the email Cha Jewels has on file for you.</p>

            <form onSubmit={handleSignup}>
              <label style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Password</label>
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
                placeholder="Confirm your password"
                autoComplete="new-password"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 20, boxSizing: 'border-box', fontSize: 14 }}
              />

              <button
                type="submit"
                disabled={loading}
                style={{ width: '100%', padding: 12, background: '#C9A84C', border: 'none', borderRadius: 8, color: '#0a0a0a', fontWeight: 700, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}
              >
                {loading ? 'Creating account…' : 'Create Account'}
              </button>
            </form>

            <div style={{ textAlign: 'center', marginTop: 20 }}>
              <button
                onClick={() => navigate('/portal/login')}
                style={{ background: 'none', border: 'none', color: '#C9A84C', fontSize: 12, cursor: 'pointer', padding: 0 }}
              >
                Already have an account? Sign in
              </button>
            </div>
          </>
        )}

        {state === 'check-email' && (
          <>
            <h2 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6 }}>Check your email</h2>
            <p style={{ color: '#888', fontSize: 13, marginBottom: 12 }}>We sent a verification link to:</p>
            <p style={{ color: '#C9A84C', fontSize: 14, marginBottom: 20, wordBreak: 'break-all' }}>{submittedEmail}</p>
            <p style={{ color: '#666', fontSize: 12, marginBottom: 24, lineHeight: 1.6 }}>
              Click the link in the email to verify your account. Once verified, you'll be linked to your Cha Jewels customer profile automatically.
            </p>
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
        )}

        {state === 'linking' && (
          <>
            <h2 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6 }}>Linking your account</h2>
            <p style={{ color: '#888', fontSize: 13, marginBottom: 24 }}>Just a moment…</p>
            <p style={{ color: '#C9A84C', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>Please wait</p>
          </>
        )}

        {state === 'error-no-customer' && (
          <>
            <h2 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6 }}>Account not found</h2>
            <p style={{ color: '#EF4444', fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>{errorMessage}</p>
            <button
              onClick={handleSignOutAndRetry}
              style={{ width: '100%', padding: 12, background: '#C9A84C', border: 'none', borderRadius: 8, color: '#0a0a0a', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 12 }}
            >
              Try Different Email
            </button>
            <p style={{ color: '#666', fontSize: 11, textAlign: 'center', marginTop: 8 }}>
              Need help? Contact Cha Jewels via Messenger.
            </p>
          </>
        )}

        {state === 'error-conflict' && (
          <>
            <h2 style={{ color: '#fff', fontFamily: 'Georgia, serif', fontSize: 18, marginBottom: 6 }}>Setup error</h2>
            <p style={{ color: '#EF4444', fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>{errorMessage}</p>
            <button
              onClick={handleSignOutAndRetry}
              style={{ width: '100%', padding: 12, background: '#C9A84C', border: 'none', borderRadius: 8, color: '#0a0a0a', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 12 }}
            >
              Try Again
            </button>
            <button
              onClick={() => navigate('/portal/login')}
              style={{ width: '100%', padding: 12, background: 'transparent', border: '1px solid #C9A84C', borderRadius: 8, color: '#C9A84C', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            >
              Back to Sign In
            </button>
          </>
        )}
      </div>
    </div>
  );
}
