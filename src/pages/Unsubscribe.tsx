import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { CheckCircle, XCircle, Loader2, MailOff } from 'lucide-react';

export default function Unsubscribe() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<'loading' | 'valid' | 'already' | 'invalid' | 'done' | 'error'>('loading');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    const validate = async () => {
      try {
        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/handle-email-unsubscribe?token=${token}`,
          { headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY } }
        );
        const data = await resp.json();
        if (!resp.ok) { setStatus('invalid'); return; }
        if (data.valid === false && data.reason === 'already_unsubscribed') { setStatus('already'); return; }
        if (data.valid) { setStatus('valid'); return; }
        setStatus('invalid');
      } catch { setStatus('error'); }
    };
    validate();
  }, [token]);

  const handleUnsubscribe = async () => {
    if (!token) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('handle-email-unsubscribe', {
        body: { token },
      });
      if (error) throw error;
      if (data?.success) setStatus('done');
      else if (data?.reason === 'already_unsubscribed') setStatus('already');
      else setStatus('error');
    } catch { setStatus('error'); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full rounded-2xl border border-border bg-card p-8 text-center space-y-6 shadow-lg">
        <div className="text-2xl font-bold text-foreground font-display">💎 Cha Jewels</div>

        {status === 'loading' && (
          <div className="space-y-3">
            <Loader2 className="h-10 w-10 mx-auto text-primary animate-spin" />
            <p className="text-muted-foreground text-sm">Verifying your request...</p>
          </div>
        )}

        {status === 'valid' && (
          <div className="space-y-4">
            <MailOff className="h-12 w-12 mx-auto text-warning" />
            <h2 className="text-lg font-semibold text-foreground">Unsubscribe from emails?</h2>
            <p className="text-sm text-muted-foreground">
              You will no longer receive payment reminder emails from Cha Jewels.
            </p>
            <Button onClick={handleUnsubscribe} disabled={submitting} className="w-full">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Confirm Unsubscribe
            </Button>
          </div>
        )}

        {status === 'done' && (
          <div className="space-y-3">
            <CheckCircle className="h-12 w-12 mx-auto text-success" />
            <h2 className="text-lg font-semibold text-foreground">Unsubscribed</h2>
            <p className="text-sm text-muted-foreground">
              You've been removed from our email list. You won't receive further reminder emails.
            </p>
          </div>
        )}

        {status === 'already' && (
          <div className="space-y-3">
            <CheckCircle className="h-12 w-12 mx-auto text-muted-foreground" />
            <h2 className="text-lg font-semibold text-foreground">Already Unsubscribed</h2>
            <p className="text-sm text-muted-foreground">
              You've already been unsubscribed from our email list.
            </p>
          </div>
        )}

        {(status === 'invalid' || status === 'error') && (
          <div className="space-y-3">
            <XCircle className="h-12 w-12 mx-auto text-destructive" />
            <h2 className="text-lg font-semibold text-foreground">
              {status === 'invalid' ? 'Invalid Link' : 'Something Went Wrong'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {status === 'invalid'
                ? 'This unsubscribe link is invalid or has expired.'
                : 'Please try again later or contact us for help.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
