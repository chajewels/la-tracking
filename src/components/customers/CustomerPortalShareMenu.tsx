import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Copy, ExternalLink, Link2, RefreshCw, Send } from 'lucide-react';
import { toast } from 'sonner';
import PortalActivationModal from './PortalActivationModal';

const PORTAL_BASE = 'https://chajewelslayaway.web.app';

interface Props {
  customerId: string;
  customerName: string;
  messengerLink?: string | null;
}

export default function CustomerPortalShareMenu({ customerId, customerName, messengerLink }: Props) {
  const { user } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [showActivationModal, setShowActivationModal] = useState(false);

  const fetchToken = async () => {
    setLoading(true);
    const { data, error } = await (supabase as any)
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

  const generateToken = async () => {
    setGenerating(true);
    try {
      // Deactivate old tokens
      await (supabase as any)
        .from('customer_portal_tokens')
        .update({ is_active: false })
        .eq('customer_id', customerId);

      // Create new token
      const { data, error } = await (supabase as any)
        .from('customer_portal_tokens')
        .insert({ customer_id: customerId, created_by_user_id: user?.id })
        .select()
        .single();

      if (error) throw error;
      setToken(data.token);
      setExpiresAt(data.expires_at);

      // Audit log
      await (supabase as any).from('audit_logs').insert({
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

  const portalUrl = token ? `${PORTAL_BASE}/portal?token=${token}` : null;

  const copyLink = () => {
    if (portalUrl) {
      navigator.clipboard.writeText(portalUrl);
      toast.success('Portal link copied');
    }
  };

  const shareMessenger = () => {
    if (portalUrl) {
      window.open(`https://m.me/?text=${encodeURIComponent(`Hi ${customerName}! Here's your Cha Jewels layaway portal: ${portalUrl}`)}`, '_blank');
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
            {token && !isExpired && (
              <Badge variant="outline" className="bg-success/10 text-success border-success/20 text-[10px]">Active</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
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
        </CardContent>
      </Card>

      {token && (
        <PortalActivationModal
          open={showActivationModal}
          onOpenChange={setShowActivationModal}
          customerName={customerName}
          token={token}
          messengerLink={messengerLink}
        />
      )}
    </>
  );
}
