import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { toLocationString, type LocationType } from '@/lib/countries';

interface AICommandModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ParsedCommand {
  intent:
    | 'CREATE_CUSTOMER'
    | 'RECORD_PAYMENT'
    | 'CREATE_LAYAWAY_ACCOUNT'
    | 'CREATE_CASH_ORDER'
    | 'ASK_POLICY'
    | 'UNKNOWN';
  confidence: number;
  parameters: Record<string, unknown>;
  display_summary: string;
  answer?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'action';
  content: string;
  intent?: string;
  parsed?: ParsedCommand;
  timestamp: Date;
}

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const VALID_LOCATIONS: readonly LocationType[] = ['japan', 'philippines', 'international'];

function coerceLocationType(value: unknown): LocationType {
  const v = String(value ?? '').trim().toLowerCase();
  return (VALID_LOCATIONS as readonly string[]).includes(v) ? (v as LocationType) : 'philippines';
}

export default function AICommandModal({ open, onOpenChange }: AICommandModalProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<ParsedCommand | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleClose = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setMessages([]);
      setInput('');
      setLoading(false);
      setPendingConfirm(null);
    }
  };

  const pushAssistant = (content: string, parsed?: ParsedCommand) => {
    setMessages((prev) => [
      ...prev,
      {
        id: newId(),
        role: 'assistant',
        content,
        intent: parsed?.intent,
        parsed,
        timestamp: new Date(),
      },
    ]);
  };

  const summarize = (parsed: ParsedCommand): string => {
    if (parsed.intent === 'CREATE_CUSTOMER') {
      const p = parsed.parameters as Record<string, unknown>;
      const name = String(p.full_name ?? 'New customer');
      const bits: string[] = [];
      if (p.mobile_number) bits.push(String(p.mobile_number));
      if (p.email) bits.push(String(p.email));
      if (p.facebook_name) bits.push(`FB: ${String(p.facebook_name)}`);
      if (p.location_type) bits.push(String(p.location_type));
      const detail = bits.length ? ` (${bits.join(' · ')})` : '';
      return `Add customer "${name}"${detail}?`;
    }
    if (parsed.intent === 'RECORD_PAYMENT') {
      const p = parsed.parameters as Record<string, unknown>;
      const amount = p.amount != null ? `${p.currency ?? 'PHP'} ${p.amount}` : 'payment';
      const inv = p.invoice_number ? ` Invoice ${p.invoice_number}` : '';
      const who = p.customer_name ? ` for ${p.customer_name}` : '';
      const via = p.payment_channel ? ` via ${p.payment_channel}` : '';
      const mode = p.payment_mode === 'split' ? ' (split)' : '';
      return `Record ${amount}${inv}${who}${via}${mode}?`;
    }
    if (parsed.intent === 'CREATE_LAYAWAY_ACCOUNT') {
      const p = parsed.parameters as Record<string, unknown>;
      const who = p.customer_name ? ` for ${p.customer_name}` : '';
      const amount = p.amount != null ? ` (${p.currency ?? 'PHP'} ${p.amount})` : '';
      const months = p.plan_months ? ` · ${p.plan_months}M` : '';
      return `Open new layaway account form${who}${amount}${months}?`;
    }
    if (parsed.intent === 'CREATE_CASH_ORDER') {
      const p = parsed.parameters as Record<string, unknown>;
      const who = p.customer_name ? ` for ${p.customer_name}` : '';
      const amount = p.amount != null ? ` (${p.currency ?? 'PHP'} ${p.amount})` : '';
      return `Open new cash order form${who}${amount}?`;
    }
    return parsed.display_summary || 'Confirm action?';
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    setMessages((prev) => [
      ...prev,
      {
        id: newId(),
        role: 'user',
        content: trimmed,
        timestamp: new Date(),
      },
    ]);
    setInput('');
    setPendingConfirm(null);
    setLoading(true);

    try {
      // Build conversation history for context
      const history = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-10) // last 10 messages max
        .map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
        }));

      const { data, error } = await supabase.functions.invoke('ai-command-parser', {
        body: { command: trimmed, history },
      });
      if (error) {
        pushAssistant(error.message || 'AI command failed.');
        return;
      }
      const result = data as ParsedCommand;
      if (!result) {
        pushAssistant('AI returned no result. Please try again.');
        return;
      }

      // Client-side invoice number extraction — more reliable than AI parsing.
      if (result.intent === 'RECORD_PAYMENT' && !result.parameters.invoice_number) {
        const invoiceMatch = trimmed.match(/(?:invoice|inv|account|acct)\s*#?(\d{4,6})(?=\s|$|\b)/i);
        if (invoiceMatch) {
          result.parameters.invoice_number = invoiceMatch[1];
        }
      }

      if (result.intent === 'ASK_POLICY') {
        pushAssistant(result.answer || "I don't have information about that. Please refer to the Policy Hub.");
        return;
      }

      if (result.intent === 'UNKNOWN') {
        pushAssistant(
          "I didn't understand that. Try asking about our policies, or use commands like 'Add customer [name]' or 'Record [amount] PHP Invoice [#] for [name] via [channel]'.",
        );
        return;
      }

      pushAssistant(summarize(result), result);
      setPendingConfirm(result);
    } catch (err) {
      pushAssistant((err as Error).message || 'AI command failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (parsed: ParsedCommand) => {
    if (!parsed || loading) return;
    setLoading(true);

    try {
      if (parsed.intent === 'CREATE_CUSTOMER') {
        const p = parsed.parameters as Record<string, string | undefined>;
        const locationType = coerceLocationType(p.location_type);
        const country = String((p as Record<string, unknown>).country ?? '').trim();
        const locationString = toLocationString(locationType, country) ?? 'philippines';
        const { error } = await supabase
          .from('customers')
          .insert({
            full_name: String(p.full_name ?? '').trim(),
            email: p.email ? String(p.email).trim() : null,
            mobile_number: p.mobile_number ? String(p.mobile_number).trim() : null,
            facebook_name: p.facebook_name ? String(p.facebook_name).trim() : null,
            messenger_link: p.messenger_link ? String(p.messenger_link).trim() : null,
            location: locationString,
          });
        if (error) {
          pushAssistant(`Could not create customer: ${error.message}`);
        } else {
          queryClient.invalidateQueries({ queryKey: ['customers'] });
          pushAssistant(`Customer "${p.full_name}" created successfully.`);
        }
        setPendingConfirm(null);
      } else if (parsed.intent === 'RECORD_PAYMENT') {
        const customerName = String((parsed.parameters as Record<string, unknown>).customer_name ?? '');
        toast.info(`Opening payment form for ${customerName}...`);
        window.dispatchEvent(
          new CustomEvent('open-record-payment-modal', {
            detail: {
              invoice_number: parsed.parameters.invoice_number ?? null,
              customer_name: parsed.parameters.customer_name ?? null,
              payment_channel: parsed.parameters.payment_channel ?? null,
              payment_mode: parsed.parameters.payment_mode ?? 'single',
            },
          }),
        );
        pushAssistant(`Opening payment form for ${customerName || 'customer'}...`);
        setPendingConfirm(null);
        handleClose(false);
      } else if (parsed.intent === 'CREATE_LAYAWAY_ACCOUNT') {
        const p = parsed.parameters as Record<string, unknown>;
        const params = new URLSearchParams();
        if (p.customer_name) params.set('customer_name', String(p.customer_name));
        if (p.amount != null) params.set('amount', String(p.amount));
        if (p.currency) params.set('currency', String(p.currency));
        if (p.plan_months) params.set('plan_months', String(p.plan_months));
        if (p.notes) params.set('notes', String(p.notes));
        toast.info('Opening new layaway account form...');
        pushAssistant('Opening new layaway account form...');
        setPendingConfirm(null);
        handleClose(false);
        navigate(`/accounts/new?${params.toString()}`);
      } else if (parsed.intent === 'CREATE_CASH_ORDER') {
        const p = parsed.parameters as Record<string, unknown>;
        const params = new URLSearchParams();
        if (p.customer_name) params.set('customer_name', String(p.customer_name));
        if (p.amount != null) params.set('amount', String(p.amount));
        if (p.currency) params.set('currency', String(p.currency));
        if (p.notes) params.set('notes', String(p.notes));
        toast.info('Opening new cash order form...');
        pushAssistant('Opening new cash order form...');
        setPendingConfirm(null);
        handleClose(false);
        navigate(`/cash-orders/new?${params.toString()}`);
      }
    } catch (err) {
      pushAssistant((err as Error).message || 'Action failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    pushAssistant('Cancelled.');
    setPendingConfirm(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-md flex flex-col"
        style={{ height: '80vh', maxHeight: '600px' }}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            CA Bot ✨
          </DialogTitle>
          <DialogDescription>
            Your Cha Jewels guide — ask about policies, add a customer, or record a payment.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 px-1 py-2 min-h-0">
          {messages.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-sm space-y-2">
              <Sparkles className="h-8 w-8 mx-auto text-primary/40" />
              <p>Hi! I'm CA. How can I help you today?</p>
              <div className="text-xs space-y-1 text-muted-foreground/70">
                <p>"What is the penalty for late payment?"</p>
                <p>"Add customer Maria Santos +63912345678"</p>
                <p>"Record 5000 PHP Invoice 19106 for Lhouise via GCash"</p>
              </div>
            </div>
          )}

          {messages.map((msg, idx) => {
            const isLast = idx === messages.length - 1;
            const showConfirmButtons =
              msg.role === 'assistant' && pendingConfirm && isLast;
            return (
              <div
                key={msg.id}
                className={cn(
                  'flex flex-col gap-1',
                  msg.role === 'user' ? 'items-end' : 'items-start',
                )}
              >
                <div
                  className={cn(
                    'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground',
                  )}
                >
                  {msg.content}
                </div>

                {showConfirmButtons && (
                  <div className="flex gap-2 mt-1">
                    <Button size="sm" variant="outline" onClick={handleCancel}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="gold-gradient text-primary-foreground"
                      onClick={() => handleConfirm(pendingConfirm)}
                      disabled={loading}
                    >
                      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : '✓ Confirm'}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          {loading && (
            <div className="flex items-start">
              <div className="bg-muted rounded-lg px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Thinking...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="flex-shrink-0 flex gap-2 pt-2 border-t border-border">
          <textarea
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask anything or type a command..."
            rows={2}
            disabled={loading}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm resize-none outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground disabled:opacity-50"
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="self-end"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
