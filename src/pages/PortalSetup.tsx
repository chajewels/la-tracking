import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import PageMeta from '@/components/seo/PageMeta';
import { pt } from '@/i18n/portal';

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
        {optional && <span className="normal-case tracking-normal text-muted-foreground/70">{pt('auth.optional')}</span>}
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
        setErrorMessage(pt('auth.errSessionLost'));
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
        toast.success(pt('auth.accountLinked'));
        navigate('/portal', { replace: true });
        return;
      }

      // Handle specific error states
      if (res.status === 404) {
        setErrorMessage(pt('auth.errNoCustomer'));
        setState('error-no-customer');
      } else if (res.status === 409) {
        setErrorMessage(pt('auth.errConflictRegistered'));
        setState('error-conflict');
      } else {
        setErrorMessage(result.error || pt('auth.errLinkFailed'));
        setState('error-conflict');
      }
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        setErrorMessage(pt('auth.errLinkTimeout'));
      } else {
        setErrorMessage(pt('auth.errNetwork'));
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
      toast.error(pt('auth.errEnterEmail'));
      return;
    }
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email.trim())) {
      toast.error(pt('auth.errInvalidEmail'));
      return;
    }
    if (!fullName.trim()) {
      toast.error(pt('auth.errEnterFullName'));
      return;
    }
    if (!facebookName.trim()) {
      toast.error(pt('auth.errEnterFacebook'));
      return;
    }
    if (!country.trim()) {
      toast.error(pt('auth.errEnterCountry'));
      return;
    }
    if (password.length < 8) {
      toast.error(pt('auth.errPasswordMin'));
      return;
    }
    if (password !== confirm) {
      toast.error(pt('auth.errPasswordMismatch'));
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
        toast.error(pt('auth.errAlreadyRegistered'));
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
        <p className="text-primary text-sm">{pt('common.loading')}</p>
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
          <p className="font-display text-primary text-2xl text-center mb-1" style={{ letterSpacing: '0.3em' }}>{pt('common.chaJewels')}</p>
          <p className="text-[10px] uppercase text-center text-muted-foreground mb-7" style={{ letterSpacing: '0.2em' }}>{pt('common.customerPortal')}</p>

          {state === 'form' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">{pt('auth.setupHeading')}</h1>
              <p className="text-muted-foreground text-sm mb-6">{pt('auth.setupSubtitle')}</p>

              <form onSubmit={handleSignup} className="space-y-4">
                <Field id="portal-setup-email" name="email" label={pt('auth.email')} required type="email" value={email} onChange={setEmail} placeholder={pt('auth.emailPlaceholder')} autoComplete="email" />
                <Field id="portal-setup-fullname" name="full_name" label={pt('auth.fullName')} required value={fullName} onChange={setFullName} placeholder={pt('auth.fullNamePlaceholder')} autoComplete="name" />
                <Field id="portal-setup-mobile" name="mobile_number" label={pt('auth.mobileNumber')} optional type="tel" value={mobileNumber} onChange={setMobileNumber} placeholder={pt('auth.mobilePlaceholder')} autoComplete="tel" />
                <Field id="portal-setup-facebook" name="facebook_name" label={pt('auth.facebookName')} required value={facebookName} onChange={setFacebookName} placeholder={pt('auth.facebookPlaceholder')} />
                <Field id="portal-setup-messenger" name="messenger_link" label={pt('auth.messengerLink')} optional value={messengerLink} onChange={setMessengerLink} placeholder={pt('auth.messengerPlaceholder')} />
                <Field id="portal-setup-location" name="location" label={pt('auth.location')} optional value={location} onChange={setLocation} placeholder={pt('auth.locationPlaceholder')} />
                <Field id="portal-setup-country" name="country" label={pt('auth.country')} required value={country} onChange={setCountry} placeholder={pt('auth.countryPlaceholder')} autoComplete="country-name" />
                <Field id="portal-setup-password" name="password" label={pt('auth.password')} type="password" value={password} onChange={setPassword} placeholder={pt('auth.setupPasswordPlaceholder')} autoComplete="new-password" />
                <Field id="portal-setup-confirm" name="confirm" label={pt('auth.confirmPassword')} type="password" value={confirm} onChange={setConfirm} placeholder={pt('auth.confirmPasswordPlaceholder')} autoComplete="new-password" />

                <button
                  type="submit"
                  disabled={loading}
                  aria-busy={loading}
                  className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90 disabled:opacity-50"
                >
                  {loading ? pt('auth.creatingAccount') : pt('auth.createAccount')}
                </button>
              </form>

              <div className="text-center mt-5">
                <button
                  onClick={() => navigate('/portal/login')}
                  className="text-primary text-xs hover:opacity-80 transition-opacity"
                >
                  {pt('auth.alreadyHaveAccount')}
                </button>
              </div>
            </>
          )}

          {state === 'check-email' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">{pt('auth.checkEmailTitle')}</h1>
              <p className="text-muted-foreground text-sm mb-3">{pt('auth.verificationSentTo')}</p>
              <p className="text-primary text-sm mb-5 break-all">{submittedEmail}</p>
              <p className="text-muted-foreground text-xs leading-relaxed mb-6">
                {pt('auth.verifyInstructions')}
              </p>
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
          )}

          {state === 'linking' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">{pt('auth.linkingTitle')}</h1>
              <p className="text-muted-foreground text-sm mb-6">{pt('auth.justAMoment')}</p>
              <p className="text-primary text-sm text-center py-5">{pt('auth.pleaseWait')}</p>
            </>
          )}

          {state === 'error-no-customer' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">{pt('auth.accountNotFoundTitle')}</h1>
              <p role="alert" className="text-destructive text-sm leading-relaxed mb-5">{errorMessage}</p>
              <button
                onClick={handleSignOutAndRetry}
                className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90 mb-3"
              >
                {pt('auth.tryDifferentEmail')}
              </button>
              <p className="text-muted-foreground text-[11px] text-center mt-2">
                {pt('auth.needHelpMessenger')}
              </p>
            </>
          )}

          {state === 'error-conflict' && (
            <>
              <h1 className="font-display text-foreground text-lg mb-1.5">{pt('auth.setupErrorTitle')}</h1>
              <p role="alert" className="text-destructive text-sm leading-relaxed mb-5">{errorMessage}</p>
              <button
                onClick={handleSignOutAndRetry}
                className="w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90 mb-3"
              >
                {pt('auth.tryAgain')}
              </button>
              <button
                onClick={() => navigate('/portal/login')}
                className="w-full h-12 rounded-lg border border-primary text-primary font-semibold text-sm transition-colors hover:bg-primary/5"
              >
                {pt('auth.backToSignIn')}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
