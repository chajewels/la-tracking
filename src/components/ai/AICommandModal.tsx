import { useState } from 'react';
import { Sparkles, Loader2, CheckCircle, XCircle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface AICommandModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ParsedCommand {
  intent: 'CREATE_CUSTOMER' | 'RECORD_PAYMENT' | 'UNKNOWN';
  confidence: number;
  parameters: Record<string, unknown>;
  display_summary: string;
}

type Step = 'input' | 'confirm' | 'done';

export default function AICommandModal({ open, onOpenChange }: AICommandModalProps) {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('input');
  const [command, setCommand] = useState('');
  const [loading, setLoading] = useState(false);
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [result, setResult] = useState<'success' | 'error' | null>(null);
  const [resultMessage, setResultMessage] = useState('');

  const handleClose = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setStep('input');
      setCommand('');
      setParsed(null);
      setResult(null);
      setResultMessage('');
      setLoading(false);
    }
  };

  const handleParse = async () => {
    if (!command.trim() || loading) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('ai-command-parser', {
        body: { command: command.trim() },
      });
      if (error) {
        toast.error(error.message || 'AI command failed');
        return;
      }
      const result = data as ParsedCommand;
      if (!result || result.intent === 'UNKNOWN') {
        toast.error(
          'Command not recognised. Try: "Add customer [name]" or "Record [amount] payment for [name]"',
        );
        return;
      }
      // Client-side invoice number extraction — more reliable than AI parsing
      // Matches: "Invoice 19106", "invoice #19106", "#19106", "19106" preceded by invoice/account
      if (result.intent === 'RECORD_PAYMENT' && !result.parameters.invoice_number) {
        const invoiceMatch = command.match(/(?:invoice|inv|account|acct)\s*#?(\d{4,6})(?=\s|$|\b)/i);
        if (invoiceMatch) {
          result.parameters.invoice_number = invoiceMatch[1];
        }
      }
      setParsed(result);
      setStep('confirm');
    } catch (err) {
      toast.error((err as Error).message || 'AI command failed');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!parsed || loading) return;
    setLoading(true);

    try {
      if (parsed.intent === 'CREATE_CUSTOMER') {
        const p = parsed.parameters as Record<string, string | undefined>;
        const { error } = await supabase
          .from('customers')
          .insert({
            full_name: String(p.full_name ?? '').trim(),
            email: p.email ? String(p.email).trim() : null,
            mobile_number: p.mobile_number ? String(p.mobile_number).trim() : null,
            facebook_name: p.facebook_name ? String(p.facebook_name).trim() : null,
            messenger_link: p.messenger_link ? String(p.messenger_link).trim() : null,
            location: p.location_type ? String(p.location_type).trim() : 'philippines',
          });
        if (error) {
          setResult('error');
          setResultMessage(error.message);
        } else {
          queryClient.invalidateQueries({ queryKey: ['customers'] });
          setResult('success');
          setResultMessage(`Customer "${p.full_name}" created successfully.`);
        }
        setStep('done');
      } else if (parsed.intent === 'RECORD_PAYMENT') {
        const customerName = String((parsed.parameters as Record<string, unknown>).customer_name ?? '');
        toast.info(`Opening payment form for ${customerName}...`);
        window.dispatchEvent(
          new CustomEvent('open-record-payment-modal', {
            detail: {
              invoice_number: parsed.parameters.invoice_number ?? null,
              customer_name: parsed.parameters.customer_name ?? null,
              payment_channel: parsed.parameters.payment_channel ?? null,
            },
          }),
        );
        handleClose(false);
      }
    } catch (err) {
      setResult('error');
      setResultMessage((err as Error).message || 'Action failed');
      setStep('done');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Command
          </DialogTitle>
          <DialogDescription>
            Type a command in plain English. Examples: "Add customer Maria Santos +63912345678" or "Record 5000 PHP payment for Haruka via BDO"
          </DialogDescription>
        </DialogHeader>

        {step === 'input' && (
          <>
            <textarea
              autoFocus
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleParse();
                }
              }}
              placeholder="Type your command..."
              rows={3}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
            />

            <div className="flex justify-between items-center">
              <span className="text-xs text-muted-foreground">
                Press Enter to parse · Shift+Enter for new line
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => handleClose(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleParse} disabled={loading || !command.trim()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Parse Command'}
                </Button>
              </div>
            </div>
          </>
        )}

        {step === 'confirm' && parsed && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">
                AI Parsed: {parsed.intent === 'CREATE_CUSTOMER' ? 'New Customer' : 'Payment Entry'}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {Math.round(parsed.confidence * 100)}% confidence
              </span>
            </div>

            <p className="text-xs text-muted-foreground border-t border-border pt-2">
              {parsed.display_summary}
            </p>

            <div className="space-y-1.5">
              {Object.entries(parsed.parameters)
                .filter(([, v]) => v !== null && v !== undefined && v !== '')
                .map(([key, value]) => (
                  <div key={key} className="flex justify-between text-sm">
                    <span className="text-muted-foreground capitalize">
                      {key.replace(/_/g, ' ')}
                    </span>
                    <span className="font-medium">{String(value)}</span>
                  </div>
                ))}
            </div>

            <div className="flex gap-2 pt-2 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setStep('input')}
              >
                ← Edit
              </Button>
              <Button
                size="sm"
                className="flex-1 gold-gradient text-primary-foreground"
                onClick={handleConfirm}
                disabled={loading}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : '✓ Confirm'}
              </Button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center space-y-4 py-6">
            {result === 'success' ? (
              <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
            ) : (
              <XCircle className="h-12 w-12 text-destructive mx-auto" />
            )}
            <p className="text-sm font-medium text-foreground">{resultMessage}</p>
            <Button size="sm" variant="outline" onClick={() => handleClose(false)}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
