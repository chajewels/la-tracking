import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Copy, ExternalLink, MessageCircle, Send, Link2, Check } from 'lucide-react';
import { toast } from 'sonner';

const PORTAL_BASE = 'https://chajewelslayaway.web.app';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerName: string;
  token: string;
  messengerLink?: string | null;
}

function generateActivationMessage(customerName: string, portalUrl: string): string {
  return `✨ Cha Jewels Customer Portal is Ready

Hi ${customerName} 💛

Your Cha Jewels Layaway Portal has been successfully created.

You can now view your account details anytime, including:

✔ Payment Schedule
✔ Remaining Balance
✔ Penalties (if any)
✔ Payment Submission (Upload Receipt)

Access your portal here:
👉 ${portalUrl}

For your security, please do not share this link with others.

You may also use the portal to submit your payment proof after completing your transfer.

If you have any questions or need assistance, feel free to message us anytime.

Thank you for trusting Cha Jewels —
Everyday Layaway, Cha Jewels All the Way 💎`;
}

export default function PortalActivationModal({ open, onOpenChange, customerName, token, messengerLink }: Props) {
  const [copiedMsg, setCopiedMsg] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const portalUrl = `${PORTAL_BASE}/portal?token=${token}`;
  const message = generateActivationMessage(customerName, portalUrl);

  const copyMessage = () => {
    navigator.clipboard.writeText(message);
    setCopiedMsg(true);
    toast.success('Message copied to clipboard');
    setTimeout(() => setCopiedMsg(false), 2000);
  };

  const copyPortalLink = () => {
    navigator.clipboard.writeText(portalUrl);
    setCopiedLink(true);
    toast.success('Portal link copied');
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const openMessenger = () => {
    if (messengerLink) {
      window.open(messengerLink, '_blank');
    } else {
      window.open(`https://m.me/?text=${encodeURIComponent(message)}`, '_blank');
    }
  };

  const openWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const openPortal = () => {
    window.open(portalUrl, '_blank');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Link2 className="h-4 w-4 text-primary" />
            </div>
            <div>
              <DialogTitle className="text-base font-display">Portal Link Generated</DialogTitle>
              <DialogDescription className="text-xs">
                Send the activation message to {customerName}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* Success indicator */}
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-success/10 border border-success/20">
            <Check className="h-4 w-4 text-success flex-shrink-0" />
            <p className="text-xs text-success font-medium">Portal link generated successfully</p>
            <Badge variant="outline" className="ml-auto bg-success/10 text-success border-success/20 text-[10px]">
              Active
            </Badge>
          </div>

          {/* Message preview */}
          <div className="rounded-lg border bg-muted/30 p-3 max-h-56 overflow-y-auto">
            <p className="text-xs whitespace-pre-wrap text-foreground/80 leading-relaxed font-mono">
              {message}
            </p>
          </div>

          {/* Action buttons */}
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" onClick={copyMessage} className="gap-1.5" variant={copiedMsg ? 'secondary' : 'default'}>
              {copiedMsg ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedMsg ? 'Copied!' : 'Copy Message'}
            </Button>
            <Button size="sm" variant="outline" onClick={openMessenger} className="gap-1.5">
              <Send className="h-3.5 w-3.5" /> Open Messenger
            </Button>
            <Button size="sm" variant="outline" onClick={openWhatsApp} className="gap-1.5">
              <MessageCircle className="h-3.5 w-3.5" /> Open WhatsApp
            </Button>
            <Button size="sm" variant="outline" onClick={copyPortalLink} className="gap-1.5">
              {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
              {copiedLink ? 'Copied!' : 'Copy Portal Link'}
            </Button>
          </div>

          <Button size="sm" variant="ghost" onClick={openPortal} className="w-full gap-1.5 text-xs">
            <ExternalLink className="h-3.5 w-3.5" /> Open Customer Portal
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
