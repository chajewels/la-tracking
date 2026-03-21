import { useState, useCallback, useEffect } from 'react';
import { Copy, ExternalLink, RefreshCw, MessageCircle, Mail, FileText, Share2, CheckCircle, Clock, AlertTriangle, Phone, ShieldAlert, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { computeRemainingBalance, getNextPaymentStatementDate } from '@/lib/business-rules';

// Production base URL for statement links — ensures correct domain regardless of preview/dev environment
const STATEMENT_BASE_URL = import.meta.env.PROD
  ? 'https://chajewelslayaway.web.app'
  : window.location.origin;

function buildStatementUrl(token: string): string {
  return `${STATEMENT_BASE_URL}/statement?token=${token}`;
}

interface TokenInfo {
  token: string;
  created_at: string;
  expires_at: string | null;
  is_active: boolean;
}

interface Props {
  accountId: string;
  invoiceNumber: string;
  customerName: string;
  currency: Currency;
  remainingBalance: number;
  totalPaid: number;
  totalAmount: number;
  scheduleItems: any[];
  messengerLink?: string | null;
}

export default function StatementShareMenu({
  accountId, invoiceNumber, customerName, currency,
  remainingBalance, totalPaid, totalAmount, scheduleItems, messengerLink,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [tokenStatus, setTokenStatus] = useState<'active' | 'expired' | 'inactive' | 'missing'>('missing');
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  // Fetch existing token info on mount
  useEffect(() => {
    const fetchToken = async () => {
      const { data } = await supabase
        .from('statement_tokens')
        .select('token, created_at, expires_at, is_active')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!data) {
        setTokenStatus('missing');
        setTokenInfo(null);
        return;
      }

      setTokenInfo(data);
      const isExpired = data.expires_at ? new Date(data.expires_at) < new Date() : false;
      if (!data.is_active) {
        setTokenStatus('inactive');
      } else if (isExpired) {
        setTokenStatus('expired');
      } else {
        setTokenStatus('active');
        setLink(buildStatementUrl(data.token));
      }
    };
    fetchToken();
  }, [accountId]);

  const forceCreateToken = useCallback(async (): Promise<string> => {
    // Deactivate all existing tokens first
    await supabase
      .from('statement_tokens')
      .update({ is_active: false })
      .eq('account_id', accountId);

    const userId = (await supabase.auth.getUser()).data.user?.id;
    const { data: newToken, error } = await supabase
      .from('statement_tokens')
      .insert({ account_id: accountId, created_by_user_id: userId })
      .select('token, created_at, expires_at, is_active')
      .single();
    if (error) throw error;
    setTokenInfo(newToken);
    setTokenStatus('active');
    const url = `${window.location.origin}/statement?token=${newToken.token}`;
    setLink(url);

    const expiryStr = newToken.expires_at
      ? new Date(newToken.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Never';
    toast.success(`✅ New token generated — expires ${expiryStr}`, { duration: 5000 });

    // Audit log
    await supabase.from('audit_logs').insert({
      entity_type: 'statement_token',
      entity_id: accountId,
      action: 'force_create_statement_token',
      new_value_json: { token_prefix: newToken.token.substring(0, 8), expires_at: newToken.expires_at },
      performed_by_user_id: userId,
    });

    return url;
  }, [accountId]);

  const generateOrReuseToken = useCallback(async (): Promise<string> => {
    // Check existing active, non-expired token
    const { data: existing } = await supabase
      .from('statement_tokens')
      .select('token, created_at, expires_at, is_active')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .maybeSingle();

    // If exists but expired or inactive, auto-create fresh one
    if (existing) {
      const isExpired = existing.expires_at ? new Date(existing.expires_at) < new Date() : false;
      if (!isExpired) {
        setTokenInfo(existing);
        setTokenStatus('active');
        const url = `${window.location.origin}/statement?token=${existing.token}`;
        setLink(url);
        return url;
      }
    }

    // No valid token found — force create a new one (safe fallback)
    return await forceCreateToken();
  }, [accountId, forceCreateToken]);

  const handleCopyLink = useCallback(async () => {
    setLoading(true);
    try {
      const url = await generateOrReuseToken();
      await navigator.clipboard.writeText(url);
      toast.success('Statement link copied!');
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate link');
    } finally {
      setLoading(false);
    }
  }, [generateOrReuseToken]);

  const handleOpenStatement = useCallback(async () => {
    setLoading(true);
    try {
      const url = await generateOrReuseToken();
      window.open(url, '_blank');
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate link');
    } finally {
      setLoading(false);
    }
  }, [generateOrReuseToken]);

  const handleForceRegenerate = useCallback(async () => {
    setLoading(true);
    try {
      const url = await forceCreateToken();
      await navigator.clipboard.writeText(url);
    } catch (err: any) {
      toast.error(err.message || 'Failed to regenerate');
    } finally {
      setLoading(false);
      setRegenerateOpen(false);
    }
  }, [forceCreateToken]);

  const buildReadyMessage = useCallback(async (): Promise<string> => {
    const url = link || await generateOrReuseToken();
    const nextStatement = getNextPaymentStatementDate(scheduleItems);
    const nextDateStr = nextStatement
      ? new Date(nextStatement.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : null;

    let msg = `Hi ${customerName.split(' ')[0]} 💎\n\n`;
    msg += `Here is your updated Cha Jewels layaway statement:\n\n`;
    msg += `${url}\n\n`;
    msg += `📋 Invoice #${invoiceNumber}\n`;
    msg += `💰 Total Paid: ${formatCurrency(totalPaid, currency)}\n`;
    msg += `📊 Remaining: ${formatCurrency(remainingBalance, currency)}\n`;
    if (nextDateStr) {
      msg += `📅 Next Payment: ${nextDateStr}\n`;
    }
    msg += `\nYou can view your full balance, payment history, penalties, waivers, and next payment schedule anytime using the link above.\n\n`;
    msg += `Thank you for your continued trust in Cha Jewels! ✨`;
    return msg;
  }, [link, generateOrReuseToken, scheduleItems, customerName, invoiceNumber, totalPaid, remainingBalance, currency]);

  const handleCopyMessage = useCallback(async () => {
    setLoading(true);
    try {
      const msg = await buildReadyMessage();
      await navigator.clipboard.writeText(msg);
      toast.success('Ready-made message copied!');
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  }, [buildReadyMessage]);

  const handleShareMessenger = useCallback(async () => {
    setLoading(true);
    try {
      await generateOrReuseToken();
      if (messengerLink) {
        const msg = await buildReadyMessage();
        await navigator.clipboard.writeText(msg);
        toast.success('Message copied! Opening Messenger...');
        window.open(messengerLink, '_blank');
      } else {
        await navigator.clipboard.writeText(await buildReadyMessage());
        toast.success('Message copied to clipboard! Paste in Messenger.');
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  }, [generateOrReuseToken, messengerLink, buildReadyMessage]);

  const handleShareWhatsApp = useCallback(async () => {
    setLoading(true);
    try {
      const msg = await buildReadyMessage();
      const waUrl = `https://wa.me/?text=${encodeURIComponent(msg)}`;
      window.open(waUrl, '_blank');
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  }, [buildReadyMessage]);

  const handleShareEmail = useCallback(async () => {
    setLoading(true);
    try {
      const msg = await buildReadyMessage();
      const subject = `Cha Jewels - Layaway Statement for Invoice #${invoiceNumber}`;
      const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(msg)}`;
      window.location.href = mailto;
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  }, [buildReadyMessage, invoiceNumber]);

  const statusConfig = {
    active: { label: 'Active', className: 'bg-success/10 text-success border-success/20', icon: CheckCircle },
    expired: { label: 'Expired', className: 'bg-destructive/10 text-destructive border-destructive/20', icon: AlertTriangle },
    inactive: { label: 'Inactive', className: 'bg-muted text-muted-foreground border-muted', icon: ShieldAlert },
    missing: { label: 'No Link', className: 'bg-muted text-muted-foreground border-muted', icon: Clock },
  };

  const statusCfg = statusConfig[tokenStatus];
  const StatusIcon = statusCfg.icon;

  return (
    <>
      <div className="flex items-center gap-1.5 flex-wrap">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="border-primary/30 text-primary hover:bg-primary/10"
              disabled={loading}
            >
              <FileText className="h-4 w-4 mr-2" />
              {loading ? 'Loading...' : 'Customer Statement'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {/* Token Status Header */}
            <div className="px-2 py-2 border-b border-border">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className={`text-[10px] py-0.5 h-5 ${statusCfg.className}`}>
                  <StatusIcon className="h-3 w-3 mr-1" /> {statusCfg.label}
                </Badge>
              </div>
              {tokenInfo && (
                <div className="text-[10px] text-muted-foreground space-y-0.5">
                  <div>Created: {new Date(tokenInfo.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                  {tokenInfo.expires_at && (
                    <div>Expires: {new Date(tokenInfo.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                  )}
                </div>
              )}
              {!tokenInfo && (
                <p className="text-[10px] text-muted-foreground">No statement link generated yet.</p>
              )}
            </div>

            <DropdownMenuLabel className="text-xs">Share Statement</DropdownMenuLabel>
            <DropdownMenuItem onClick={handleCopyLink}>
              <Copy className="h-4 w-4 mr-2" /> Copy Link
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleOpenStatement}>
              <ExternalLink className="h-4 w-4 mr-2" /> Open Statement
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCopyMessage}>
              <Share2 className="h-4 w-4 mr-2" /> Copy Ready-Made Message
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Send Via</DropdownMenuLabel>
            <DropdownMenuItem onClick={handleShareMessenger}>
              <MessageCircle className="h-4 w-4 mr-2" /> Messenger
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleShareWhatsApp}>
              <Phone className="h-4 w-4 mr-2" /> WhatsApp
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleShareEmail}>
              <Mail className="h-4 w-4 mr-2" /> Email
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setMessageOpen(true)}>
              <FileText className="h-4 w-4 mr-2" /> Preview Message
            </DropdownMenuItem>

            {/* Force New Token - always available */}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Troubleshooting</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => setRegenerateOpen(true)}
              className="text-destructive focus:text-destructive"
            >
              <Zap className="h-4 w-4 mr-2" /> Force New Link
              {(tokenStatus === 'expired' || tokenStatus === 'inactive') && (
                <Badge variant="outline" className="ml-auto text-[9px] py-0 h-4 bg-destructive/10 text-destructive border-destructive/20">
                  Recommended
                </Badge>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Compact token status badge */}
        <Badge
          variant="outline"
          className={`text-[10px] py-0.5 h-5 ${statusCfg.className}`}
          title={tokenInfo?.expires_at
            ? `Expires: ${new Date(tokenInfo.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
            : tokenStatus === 'missing' ? 'No link generated' : undefined}
        >
          <StatusIcon className="h-3 w-3 mr-1" /> {statusCfg.label}
        </Badge>
        {tokenInfo?.expires_at && tokenStatus === 'active' && (
          <span className="text-[10px] text-muted-foreground hidden sm:inline">
            Expires {new Date(tokenInfo.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      {/* Regenerate / Force New Confirmation */}
      <AlertDialog open={regenerateOpen} onOpenChange={setRegenerateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Generate New Statement Link?</AlertDialogTitle>
            <AlertDialogDescription>
              {tokenStatus === 'active'
                ? 'This will invalidate the current active link. Anyone with the old link will no longer be able to access the statement. A new link will be generated and copied to your clipboard.'
                : 'The current link is no longer valid. A fresh link will be generated and copied to your clipboard.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleForceRegenerate} disabled={loading}>
              {loading ? 'Generating...' : 'Generate New Link'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Message Preview Dialog */}
      <MessagePreviewDialog
        open={messageOpen}
        onOpenChange={setMessageOpen}
        buildMessage={buildReadyMessage}
      />
    </>
  );
}

function MessagePreviewDialog({
  open, onOpenChange, buildMessage,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  buildMessage: () => Promise<string>;
}) {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    buildMessage().then(m => { setMessage(m); setLoading(false); }).catch(() => setLoading(false));
  }, [open, buildMessage]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message);
    toast.success('Message copied!');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Customer Statement Message</DialogTitle>
          <DialogDescription>Preview and copy the ready-made message for sharing.</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : (
          <>
            <Textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              className="min-h-[240px] text-xs font-mono"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              <Button onClick={handleCopy}>
                <Copy className="h-4 w-4 mr-2" /> Copy Message
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
