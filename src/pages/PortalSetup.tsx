import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import PageMeta from '@/components/seo/PageMeta';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

type SetupState = 'form' | 'check-email' | 'linking' | 'error-no-customer' | 'error-conflict';

/** Local field helper — schema-specific to this form, kept in-file rather
 *  than promoted to a shared component. */
function Field({
  id, name, label, required, optional, type = 'text', value, onChange, placeholder, autoComplete,
}: {
  id: string; name: string; label: string; required?: boolean; optional?: boolean;
  type?: string; value: string; onChange: (v: string) => void; placeholder?: string; autoComplete?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-[10px] uppercase block text-primary" style={{ letterSpacing: '0.15em' }}>
        {label} {required && <span className="text-primary">*</span>}
        {optional && <span className="normal-case tracking-normal text-muted-foreground/70"> (optional)</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full h-12 px-4 rounded-lg text-sm text-foreground bg-input border border-border outline-none transition-all duration-300 focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </div>
  );
}

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

      // Profile fields travel in Supabase Auth user_metadata (set at
      // signup); the edge function reads them server-side. No request
      // body needed — everything is derived from the verified JWT.
      const res = await fetch(`${SUPABASE_URL}/functions/v1/setup-customer-account`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
        },
        // Defensive 15s timeout to avoid stuck Linking screen if function hangs
        signal: AbortSignal.timeout(15000),
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
        setErrorMessage('This email is already registered for portal access. Please contact support to set up your account.');
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

    if (!email.trim()) {
      toast.error('Please enter your email address');
      return;
    }
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email.trim())) {
      toast.error('Please enter a valid email address');
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

    setLoading(true);
    // Profile fields ride along in Supabase Auth user_metadata so they
    // survive the email-verification round-trip reliably (localStorage
    // handoff was unreliable on mobile / private browsing). The
    // setup-customer-account edge function reads them from auth metadata.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/portal/setup`,
        data: {
          full_name: fullName.trim(),
          mobile_number: mobileNumber.trim() || null,
          facebook_name: facebookName.trim(),
          messenger_link: messengerLink.trim() || null,
          location: location.trim() || null,
          country: country.trim(),
        },
      },
    });
    setLoading(false);

    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (
        msg.includes('already registered') ||
        msg.includes('already been registered') ||
        msg.includes('user already exists') ||
        error.status === 422
      ) {
        toast.error(
          'This email is already registered. Please contact support if you need help accessing your portal account.',
        );
      } else {
        toast.error(error.message);
      }
      return;
    }

    // Supabase Auth returns success (no error) for an already-confirmed
    // email but with an empty identities array and sends no email. Treat
    // that as already-registered instead of falling through to the
    // "Check your email" screen.
    if (!error && data?.user?.identities && data.user.identities.length === 0) {
      toast.error(
        'This email is already registered. Please contact support if you need help accessing your portal account.',
      );
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
      <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background">
        <p className="text-primary text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <>
      <PageMeta
        title="Create account — Cha Jewels Customer Portal"
        description="Create your Cha Jewels customer portal account to manage layaway plans, track payments, and access your statements anytime."
        path="/portal/setup"
      />
      <div className="maison-portal font-body min-h-screen flex items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-sm rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-8 sm:p-10">
          <p className="font-display text-primary text-2xl text-center mb-1" style={{ letterSpacing: '0.3em' }}>Cha Jewels</p>
          <p className="text-[10px] uppercase text-center text-muted-foreground mb-7" style={{ letterSpacing: '0.2em' }}>Customer Portal</p>

          {state === 'form' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">Set up your Cha Jewels Portal account</h1>
              <p className="text-muted-foreground text-sm mb-6">Use the email Cha Jewels has on file for you.</p>

              <form onSubmit={handleSignup} className="space-y-4">
                <Field id="portal-setup-email" name="email" label="Email" required type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" />
                <Field id="portal-setup-fullname" name="full_name" label="Full Name" required value={fullName} onChange={setFullName} placeholder="Your full name" autoComplete="name" />
                <Field id="portal-setup-mobile" name="mobile_number" label="Mobile Number" optional type="tel" value={mobileNumber} onChange={setMobileNumber} placeholder="e.g. 09XX XXX XXXX" autoComplete="tel" />
                <Field id="portal-setup-facebook" name="facebook_name" label="Facebook Name" required value={facebookName} onChange={setFacebookName} placeholder="Name on Facebook" />
                <Field id="portal-setup-messenger" name="messenger_link" label="Messenger Link" optional value={messengerLink} onChange={setMessengerLink} placeholder="m.me/yourprofile" />
                <Field id="portal-setup-location" name="location" label="Location" optional value={location} onChange={setLocation} placeholder="City / area" />
                <Field id="portal-setup-country" name="country" label="Country" required value={country} onChange={setCountry} placeholder="Country" autoComplete="country-name" />
                <Field id="portal-setup-password" name="password" label="Password" type="password" value={password} onChange={setPassword} placeholder="At least 8 characters" autoComplete="new-password" />
                <Field id="portal-setup-confirm" name="confirm" label="Confirm Password" type="password" value={confirm} onChange={setConfirm} placeholder="Confirm your password" autoComplete="new-password" />

                <button
                  type="submit"
                  disabled={loading}
                  aria-busy={loading}
                  className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90 disabled:opacity-50"
                >
                  {loading ? 'Creating account…' : 'Create Account'}
                </button>
              </form>

              <div className="text-center mt-5">
                <button
                  onClick={() => navigate('/portal/login')}
                  className="text-primary text-xs hover:opacity-80 transition-opacity"
                >
                  Already have an account? Sign in
                </button>
              </div>
            </>
          )}

          {state === 'check-email' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">Check your email</h1>
              <p className="text-muted-foreground text-sm mb-3">We sent a verification link to:</p>
              <p className="text-primary text-sm mb-5 break-all">{submittedEmail}</p>
              <p className="text-muted-foreground text-xs leading-relaxed mb-6">
                Click the link in the email to verify your account. Once verified, you'll be linked to your Cha Jewels customer profile automatically.
              </p>
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
          )}

          {state === 'linking' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">Linking your account</h1>
              <p className="text-muted-foreground text-sm mb-6">Just a moment…</p>
              <p className="text-primary text-sm text-center py-5">Please wait</p>
            </>
          )}

          {state === 'error-no-customer' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">Account not found</h1>
              <p role="alert" className="text-destructive text-sm leading-relaxed mb-5">{errorMessage}</p>
              <button
                onClick={handleSignOutAndRetry}
                className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90 mb-3"
              >
                Try Different Email
              </button>
              <p className="text-muted-foreground text-[11px] text-center mt-2">
                Need help? Contact Cha Jewels via Messenger.
              </p>
            </>
          )}

          {state === 'error-conflict' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">Setup error</h1>
              <p role="alert" className="text-destructive text-sm leading-relaxed mb-5">{errorMessage}</p>
              <button
                onClick={handleSignOutAndRetry}
                className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90 mb-3"
              >
                Try Again
              </button>
              <button
                onClick={() => navigate('/portal/login')}
                className="w-full h-12 rounded-lg border border-primary text-primary font-semibold text-sm transition-colors hover:bg-primary/5"
              >
                Back to Sign In
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
