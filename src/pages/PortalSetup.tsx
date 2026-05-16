import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type SetupState = 'form' | 'check-email' | 'linking' | 'error-no-customer' | 'error-conflict';

const PROFILE_STASH_KEY = 'portal-setup-profile';

export default function PortalSetup() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialEmail = searchParams.get('email') || '';
  const [state, setState] = useState<SetupState>('form');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fullName, setFullName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [facebookName, setFacebookName] = useState('');
  const [messengerLink, setMessengerLink] = useState('');
  const [location, setLocation] = useState('');
  const [country, setCountry] = useState('');
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

      // The email-verification round-trip reloads the page, wiping
      // form state, before this runs. The profile fields collected at
      // signup are stashed in localStorage so they survive into the
      // new-customer creation path on the edge function.
      let profileBody: Record<string, string> = {};
      try {
        const stashed = localStorage.getItem(PROFILE_STASH_KEY);
        if (stashed) profileBody = JSON.parse(stashed);
      } catch {
        profileBody = {};
      }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/setup-customer-account`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
        },
        body: JSON.stringify(profileBody),
        // Defensive 15s timeout to avoid stuck Linking screen if function hangs
        signal: AbortSignal.timeout(15000),
      });

      const result = await res.json();

      if (res.ok && result.success) {
        try { localStorage.removeItem(PROFILE_STASH_KEY); } catch { /* ignore */ }
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
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        setErrorMessage('Account linking timed out. Please try again — if this keeps happening, contact Cha Jewels for help.');
      } else {
        setErrorMessage('Network error. Please check your connection and try again.');
      }
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
      setBootstrapping(false);
      if (session) {
        // User is signed in (verified) — proceed with linking
        linkCustomerAccount();
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
    if (!fullName.trim()) {
      toast.error('Please enter your full name');
      return;
    }
    if (!facebookName.trim()) {
      toast.error('Please enter your Facebook name');
      return;
    }
    if (!country.trim()) {
      toast.error('Please enter your country');
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

    // Stash profile so it survives the email-verification page reload
    // and reaches setup-customer-account on the new-customer path.
    try {
      const profile: Record<string, string> = { full_name: fullName.trim() };
      if (mobileNumber.trim()) profile.mobile_number = mobileNumber.trim();
      if (facebookName.trim()) profile.facebook_name = facebookName.trim();
      if (messengerLink.trim()) profile.messenger_link = messengerLink.trim();
      if (location.trim()) profile.location = location.trim();
      if (country.trim()) profile.country = country.trim();
      localStorage.setItem(PROFILE_STASH_KEY, JSON.stringify(profile));
    } catch { /* non-fatal — link path still works for existing customers */ }

    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/portal/setup`,
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
              <label htmlFor="portal-setup-email" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Email</label>
              <input
                id="portal-setup-email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label htmlFor="portal-setup-fullname" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Full Name <span style={{ color: '#C9A84C' }}>*</span></label>
              <input
                id="portal-setup-fullname"
                name="full_name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Your full name"
                autoComplete="name"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label htmlFor="portal-setup-mobile" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Mobile Number <span style={{ textTransform: 'none', letterSpacing: 0, color: '#666' }}>(optional)</span></label>
              <input
                id="portal-setup-mobile"
                name="mobile_number"
                type="tel"
                value={mobileNumber}
                onChange={(e) => setMobileNumber(e.target.value)}
                placeholder="e.g. 09XX XXX XXXX"
                autoComplete="tel"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label htmlFor="portal-setup-facebook" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Facebook Name <span style={{ color: '#C9A84C' }}>*</span></label>
              <input
                id="portal-setup-facebook"
                name="facebook_name"
                type="text"
                value={facebookName}
                onChange={(e) => setFacebookName(e.target.value)}
                placeholder="Name on Facebook"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label htmlFor="portal-setup-messenger" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Messenger Link <span style={{ textTransform: 'none', letterSpacing: 0, color: '#666' }}>(optional)</span></label>
              <input
                id="portal-setup-messenger"
                name="messenger_link"
                type="text"
                value={messengerLink}
                onChange={(e) => setMessengerLink(e.target.value)}
                placeholder="m.me/yourprofile"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label htmlFor="portal-setup-location" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Location <span style={{ textTransform: 'none', letterSpacing: 0, color: '#666' }}>(optional)</span></label>
              <input
                id="portal-setup-location"
                name="location"
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City / area"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label htmlFor="portal-setup-country" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Country <span style={{ color: '#C9A84C' }}>*</span></label>
              <input
                id="portal-setup-country"
                name="country"
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="Country"
                autoComplete="country-name"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label htmlFor="portal-setup-password" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Password</label>
              <input
                id="portal-setup-password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                style={{ width: '100%', padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, color: '#fff', marginBottom: 14, boxSizing: 'border-box', fontSize: 14 }}
              />

              <label htmlFor="portal-setup-confirm" style={{ color: '#999', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Confirm Password</label>
              <input
                id="portal-setup-confirm"
                name="confirm"
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
                aria-busy={loading}
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
            <p role="alert" style={{ color: '#EF4444', fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>{errorMessage}</p>
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
            <p role="alert" style={{ color: '#EF4444', fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>{errorMessage}</p>
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
