import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { getPortalLinkForCustomer } from '@/lib/portal-link';
import { Copy, ExternalLink, Link2, Mail, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';
import PortalActivationModal from './PortalActivationModal';

const PORTAL_BASE = 'https://portal.chajewelsjp.com';

interface Props {
  customerId: string;
  customerName: string;
  messengerLink?: string | null;
  customerEmail?: string | null;
  authUserId?: string | null;
  setupLinkSentAt?: string | null;
}

export default function CustomerPortalShareMenu({
  customerId,
  customerName,
  messengerLink,
  customerEmail,
  authUserId,
  setupLinkSentAt,
}: Props) {
  const { user } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [showSetupConfirm, setShowSetupConfirm] = useState(false);
  const [sendingInvite, setSendingInvite] = useState(false);
  const [localSetupSentAt, setLocalSetupSentAt] = useState<string | null>(setupLinkSentAt ?? null);
  const [emailConflict, setEmailConflict] = useState<string | null>(null);
  const [conflictLoading, setConflictLoading] = useState(true);
  const [customerPin, setCustomerPin] = useState<string>('----');

  const fetchToken = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('customer_portal_tokens')
      .select('*')
      .eq('customer_id', customerId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data && !error) {
      const isExpired = data.expires_at && new Date(data.expires_at) < new Date();
      if (!isExpired) {
        setToken(data.token);
        setExpiresAt(data.expires_at);
      } else {
        setToken(null);
        setExpiresAt(null);
      }
    }
    setLoading(false);
  };

  useEffect(() => { fetchToken(); }, [customerId]);

  useEffect(() => {
    setLocalSetupSentAt(setupLinkSentAt ?? null);
  }, [setupLinkSentAt]);

  useEffect(() => {
    if (!customerId) return;
    (async () => {
      const { data } = await supabase
        .from('customers')
        .select('mobile_number')
        .eq('id', customerId)
        .maybeSingle();
      const digits = (data?.mobile_number ?? '').replace(/\D/g, '');
      setCustomerPin(digits.length >= 4 ? digits.slice(-4) : '----');
    })();
  }, [customerId]);

  useEffect(() => {
    if (!customerId || authUserId) {
      // Skip check if already migrated (no conflict possible) or no customer ID
      setEmailConflict(null);
      setConflictLoading(false);
      return;
    }
    setConflictLoading(true);
    (async () => {
      const { data, error } = await supabase.rpc('check_customer_email_conflict' as any, {
        p_customer_id: customerId,
      });
      if (!error) {
        setEmailConflict(data as string | null);
      } else {
        console.warn('[email-conflict-check] failed:', error);
      }
      setConflictLoading(false);
    })();
  }, [customerId, authUserId]);

  const generateToken = async () => {
    setGenerating(true);
    try {
      // Deactivate old tokens
      await supabase
        .from('customer_portal_tokens')
        .update({ is_active: false })
        .eq('customer_id', customerId);

      // Create new token
      const { data, error } = await supabase
        .from('customer_portal_tokens')
        .insert({ customer_id: customerId, created_by_user_id: user?.id })
        .select()
        .single();

      if (error) throw error;
      setToken(data.token);
      setExpiresAt(data.expires_at);

      // Audit log
      await supabase.from('audit_logs').insert({
        action: 'PORTAL_LINK_GENERATED',
        entity_type: 'customer_portal_tokens',
        entity_id: customerId,
        performed_by_user_id: user?.id,
        new_value_json: {
          customer_id: customerId,
          token: data.token,
          generated_by: user?.id,
          timestamp: new Date().toISOString(),
        },
      });

      // Show activation modal instead of simple toast
      setShowActivationModal(true);
    } catch {
      toast.error('Failed to generate portal link');
    }
    setGenerating(false);
  };

  const portalUrl = (authUserId || token)
    ? getPortalLinkForCustomer(
        { auth_user_id: authUserId ?? null, portal_token: token },
        'portal'
      )
    : null;

  const copyLink = () => {
    if (portalUrl) {
      navigator.clipboard.writeText(portalUrl);
      toast.success('Portal link copied');
    }
  };

  const shareMessenger = () => {
    if (portalUrl) {
      window.open(`https://m.me/?text=${encodeURIComponent(`Hi ${customerName}! Here's your Cha Jewels Hub portal: ${portalUrl}`)}`, '_blank');
    }
  };

  function formatLastSent(timestamp: string | null): string | null {
    if (!timestamp) return null;
    const sent = new Date(timestamp).getTime();
    const now = Date.now();
    const diffSec = Math.floor((now - sent) / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  const sendSetupInvite = async () => {
    if (!customerEmail) return;
    setSendingInvite(true);
    try {
      const setupUrl = `${PORTAL_BASE}/portal/setup?email=${encodeURIComponent(customerEmail)}`;
      const { data: customerRow } = await supabase
        .from('customers')
        .select('mobile_number')
        .eq('id', customerId)
        .maybeSingle();
      const digits = (customerRow?.mobile_number ?? '').replace(/\D/g, '');
      const customerPin = digits.length >= 4 ? digits.slice(-4) : '----';
      const { error: invokeError } = await supabase.functions.invoke('send-transactional-email', {
        body: {
          template_name: 'portal-setup-invite',
          recipient_email: customerEmail,
          templateData: { customerName, setupUrl, customerEmail, customerPin },
        },
      });
      if (invokeError) throw invokeError;

      // Tracking update — non-blocking on email success
      const nowIso = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('customers')
        .update({ setup_link_sent_at: nowIso })
        .eq('id', customerId);
      if (updateError) {
        console.warn('[setup-invite] tracking update failed:', updateError);
      }

      setLocalSetupSentAt(nowIso);
      setShowSetupConfirm(false);
      toast.success(`Setup link sent to ${customerEmail}`);
    } catch (err) {
      console.error('[setup-invite] send failed:', err);
      toast.error('Failed to send setup link');
    } finally {
      setSendingInvite(false);
    }
  };

  const isExpired = expiresAt && new Date(expiresAt) < new Date();

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-display flex items-center gap-2">
              <Link2 className="h-4 w-4 text-primary" /> Customer Portal
            </CardTitle>
            {authUserId ? (
              <Badge variant="outline" className="bg-success/10 text-success border-success/20 text-[10px]">
                Migrated
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                Token-based
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {authUserId ? (
            <>
              <p className="text-xs text-muted-foreground">
                Customer signs in with email and password.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(`${PORTAL_BASE}/portal`);
                    toast.success('Portal URL copied');
                  }}
                  className="gap-1.5"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy Portal URL
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(`${PORTAL_BASE}/portal`, '_blank')}
                  className="gap-1.5"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open Portal
                </Button>
              </div>
            </>
          ) : (
            <>
              {loading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : token && !isExpired ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Expires {expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={copyLink} className="gap-1.5">
                      <Copy className="h-3.5 w-3.5" /> Copy Link
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setShowActivationModal(true)} className="gap-1.5">
                      <Send className="h-3.5 w-3.5" /> Send Message
                    </Button>
                    <Button size="sm" variant="outline" onClick={shareMessenger} className="gap-1.5">
                      <Send className="h-3.5 w-3.5" /> Messenger
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => portalUrl && window.open(portalUrl, '_blank')} className="gap-1.5">
                      <ExternalLink className="h-3.5 w-3.5" /> Preview
                    </Button>
                  </div>
                  <Button size="sm" variant="ghost" onClick={generateToken} disabled={generating} className="gap-1.5 text-xs">
                    <RefreshCw className="h-3.5 w-3.5" /> Regenerate Link
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Generate a portal link for this customer to view all their layaway accounts.
                  </p>
                  <Button size="sm" onClick={generateToken} disabled={generating} className="gap-1.5">
                    <Link2 className="h-3.5 w-3.5" /> Generate Portal Link
                  </Button>
                </>
              )}

              <div className="border-t pt-3 mt-3">
                <p className="text-xs font-medium mb-2">Email/Password Setup</p>
                {customerEmail ? (
                  <>
                    {emailConflict === 'staff_conflict' && (
                      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-md p-2 mb-2">
                        <p className="text-xs text-yellow-700 dark:text-yellow-400">
                          ⚠️ This email is registered as a staff account. Migration may fail or cause confusion. Ask the customer to use a different email before sending the setup link.
                        </p>
                      </div>
                    )}
                    {localSetupSentAt && (
                      <p className="text-xs text-muted-foreground mb-2">
                        Last sent: {formatLastSent(localSetupSentAt)}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setShowSetupConfirm(true)}
                        disabled={sendingInvite}
                        className="gap-1.5"
                      >
                        <Mail className="h-3.5 w-3.5" />
                        {sendingInvite ? 'Sending…' : 'Send Setup Link'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const setupUrl = `${PORTAL_BASE}/portal/setup?email=${encodeURIComponent(customerEmail)}`;
                          navigator.clipboard.writeText(setupUrl);
                          toast.success('Setup URL copied');
                        }}
                        className="gap-1.5"
                      >
                        <Copy className="h-3.5 w-3.5" /> Copy Setup URL
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const setupUrl = `${PORTAL_BASE}/portal/setup?email=${encodeURIComponent(customerEmail)}`;
                          const message = `Hi ${customerName}! Set up your Cha Jewels portal access here: ${setupUrl}`;
                          window.open(`https://m.me/?text=${encodeURIComponent(message)}`, '_blank');
                        }}
                        className="gap-1.5"
                      >
                        <Send className="h-3.5 w-3.5" /> Messenger
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    Add email on file to enable email invite
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {token && (
        <PortalActivationModal
          open={showActivationModal}
          onOpenChange={setShowActivationModal}
          customerName={customerName}
          token={token}
          messengerLink={messengerLink}
          customerPin={customerPin}
        />
      )}

      <AlertDialog
        open={showSetupConfirm}
        onOpenChange={(open) => { if (!open && !sendingInvite) setShowSetupConfirm(false); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {emailConflict === 'staff_conflict' ? 'Send setup link anyway?' : 'Send setup link?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {emailConflict === 'staff_conflict' ? (
                <>
                  ⚠️ <strong>Warning:</strong> This email (<strong>{customerEmail}</strong>) is registered as a staff account. The setup link may fail because email/password authentication will conflict with the staff account.
                  <br /><br />
                  Recommended: Ask the customer for a different email first, then update their customer record before sending.
                </>
              ) : (
                <>
                  This will email <strong>{customerEmail}</strong> a link to set
                  up email and password access to their Cha Jewels portal.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sendingInvite}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={sendSetupInvite} disabled={sendingInvite}>
              {sendingInvite ? 'Sending…' : (emailConflict === 'staff_conflict' ? 'Send Anyway' : 'Send')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
