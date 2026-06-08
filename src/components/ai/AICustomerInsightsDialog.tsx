import { useState } from 'react';
import { Sparkles, Loader2, AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck, Shield } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface Props {
  customerId: string;
  customerName: string;
}

interface InsightResult {
  risk: 'low' | 'medium' | 'high';
  summary: string;
  behavior: string[];
  risk_reasons: string[];
  next_action: string;
  highlights: string[];
  meta?: {
    generated_at: string;
    accounts_analyzed: number;
    payments_analyzed: number;
    penalties_analyzed: number;
  };
}

export default function AICustomerInsightsDialog({ customerId, customerName }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InsightResult | null>(null);

  const generate = async () => {
    setLoading(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('ai-customer-insights', {
        body: { customer_id: customerId },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      setResult(data as InsightResult);
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate insights');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && !result && !loading) generate();
    if (!next) {
      // keep result cached during session; clear only on next open if desired
    }
  };

  const riskMeta = (risk?: string) => {
    switch (risk) {
      case 'high':
        return { label: 'High Risk', Icon: ShieldAlert, cls: 'bg-destructive/10 text-destructive border-destructive/30' };
      case 'medium':
        return { label: 'Medium Risk', Icon: Shield, cls: 'bg-warning/10 text-warning border-warning/30' };
      case 'low':
      default:
        return { label: 'Low Risk', Icon: ShieldCheck, cls: 'bg-success/10 text-success border-success/30' };
    }
  };

  const risk = riskMeta(result?.risk);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="border-primary/30 text-primary hover:bg-primary/10"
        >
          <Sparkles className="h-3.5 w-3.5 mr-1.5" /> AI Insights
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Customer Insights — {customerName}
          </DialogTitle>
          <DialogDescription>
            AI-generated summary of payment behavior, risk level, and recommended next action.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Analyzing account portfolio...
          </div>
        )}

        {!loading && result && (
          <div className="space-y-5 pt-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <Badge variant="outline" className={`${risk.cls} text-xs font-semibold px-3 py-1`}>
                <risk.Icon className="h-3.5 w-3.5 mr-1.5" /> {risk.label}
              </Badge>
              <Button size="sm" variant="ghost" onClick={generate} disabled={loading}>
                <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Regenerate
              </Button>
            </div>

            <section>
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
                Summary
              </h3>
              <p className="text-sm text-foreground leading-relaxed">{result.summary}</p>
            </section>

            {result.behavior?.length > 0 && (
              <section>
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
                  Payment Behavior
                </h3>
                <ul className="space-y-1.5">
                  {result.behavior.map((b, i) => (
                    <li key={i} className="text-sm text-foreground flex gap-2">
                      <span className="text-primary mt-0.5">•</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {result.risk_reasons?.length > 0 && (
              <section>
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3" /> Risk Reasons
                </h3>
                <ul className="space-y-1.5">
                  {result.risk_reasons.map((r, i) => (
                    <li key={i} className="text-sm text-foreground flex gap-2">
                      <span className="text-destructive mt-0.5">•</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {result.highlights?.length > 0 && (
              <section>
                <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 text-success" /> Highlights
                </h3>
                <ul className="space-y-1.5">
                  {result.highlights.map((h, i) => (
                    <li key={i} className="text-sm text-foreground flex gap-2">
                      <span className="text-success mt-0.5">•</span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <h3 className="text-xs uppercase tracking-wider text-primary mb-1 font-semibold">
                Recommended Next Action
              </h3>
              <p className="text-sm text-foreground">{result.next_action}</p>
            </section>

            {result.meta && (
              <p className="text-[10px] text-muted-foreground text-center pt-1">
                Analyzed {result.meta.accounts_analyzed} account(s), {result.meta.payments_analyzed} payment(s),
                {' '}{result.meta.penalties_analyzed} penalty event(s) ·{' '}
                {new Date(result.meta.generated_at).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
