import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Printer, Check, AlertTriangle, Clock, MessageCircle, Download } from 'lucide-react';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

interface StatementData {
  invoice_number: string;
  customer_name: string;
  currency: string;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  downpayment_amount: number;
  status: string;
  order_date: string;
  payment_plan_months: number;
  total_active_penalties: number;
  total_waived_amount: number;
  total_services: number;
  computed_remaining: number;
  current_total_payable: number;
  schedule: Array<{
    installment_number: number;
    due_date: string;
    base_amount: number;
    penalty_amount: number;
    total_due: number;
    paid_amount: number;
    status: string;
  }>;
  penalties: Array<{
    schedule_id: string;
    amount: number;
    stage: string;
    date: string;
    status: string;
  }>;
  payments: Array<{
    amount: number;
    date: string;
    method: string | null;
  }>;
  services: Array<{
    type: string;
    description: string | null;
    amount: number;
  }>;
}

function fmt(amount: number, currency: string): string {
  if (currency === 'JPY') return `¥${amount.toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
  return `₱${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

function stageLabel(stage: string): string {
  if (stage === 'week1') return 'Week 1';
  if (stage === 'week2') return 'Week 2';
  return stage;
}

const SERVICE_LABELS: Record<string, string> = {
  resize: 'Resize', certificate: 'Certificate', polish: 'Polish',
  change_color: 'Change Color', engraving: 'Engraving', repair: 'Repair', other: 'Other',
};

/**
 * Build 14-day penalty checkpoint dates from a due date.
 */
function buildPenaltyCheckpoints(dueDateStr: string): Date[] {
  const dueDate = new Date(dueDateStr + 'T00:00:00Z');
  const dueDayOfMonth = dueDate.getUTCDate();
  const checkpoints: Date[] = [];
  const p1 = new Date(dueDate); p1.setUTCDate(p1.getUTCDate() + 7); checkpoints.push(p1);
  const p2 = new Date(dueDate); p2.setUTCDate(p2.getUTCDate() + 14); checkpoints.push(p2);
  for (let m = 1; m <= 12; m++) {
    const year = dueDate.getUTCFullYear();
    const month = dueDate.getUTCMonth() + m;
    const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const monthly = new Date(Date.UTC(year, month, Math.min(dueDayOfMonth, maxDay)));
    checkpoints.push(monthly);
    const plus14 = new Date(monthly); plus14.setUTCDate(plus14.getUTCDate() + 14);
    checkpoints.push(plus14);
  }
  return checkpoints;
}

/**
 * Penalty-aware next payment info.
 * 14-day checkpoints only apply to installments that have penalty > 0.
 */
function getNextPaymentInfo(schedule: StatementData['schedule']): { date: string; amount: number; isAdjusted: boolean } | null {
  const today = new Date().toISOString().split('T')[0];
  const todayDate = new Date(today + 'T00:00:00Z');
  const unpaid = schedule
    .filter(s => s.status !== 'paid' && s.status !== 'cancelled' && s.paid_amount < s.total_due)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (unpaid.length === 0) return null;

  const candidates: Array<{ date: Date; amount: number; isAdjusted: boolean }> = [];

  for (const item of unpaid) {
    const hasPenalty = (item.penalty_amount || 0) > 0;
    const isOverdue = item.due_date < today;
    const amt = item.total_due - item.paid_amount;

    if (!isOverdue) {
      candidates.push({ date: new Date(item.due_date + 'T00:00:00Z'), amount: amt, isAdjusted: false });
    } else if (hasPenalty) {
      const nextCp = buildPenaltyCheckpoints(item.due_date).find(cp => cp > todayDate);
      if (nextCp) {
        candidates.push({ date: nextCp, amount: amt, isAdjusted: true });
      }
    } else {
      candidates.push({ date: new Date(item.due_date + 'T00:00:00Z'), amount: amt, isAdjusted: false });
    }
  }

  if (candidates.length === 0) {
    const first = unpaid[0];
    return { date: first.due_date, amount: first.total_due - first.paid_amount, isAdjusted: false };
  }

  candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
  const future = candidates.find(c => c.date >= todayDate);
  if (future) {
    return { date: future.date.toISOString().split('T')[0], amount: future.amount, isAdjusted: future.isAdjusted };
  }
  const latest = candidates[candidates.length - 1];
  return { date: latest.date.toISOString().split('T')[0], amount: latest.amount, isAdjusted: latest.isAdjusted };
}

export default function CustomerStatement() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [data, setData] = useState<StatementData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) { setError('No access token provided.'); setLoading(false); return; }
    const fetchStatement = async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/customer-statement?token=${encodeURIComponent(token)}`, {
          headers: { apikey: SUPABASE_KEY },
        });
        const json = await res.json();
        if (!res.ok) { setError(json.error || 'Access denied'); return; }
        setData(json);
      } catch { setError('Unable to load statement. Please try again.'); }
      finally { setLoading(false); }
    };
    fetchStatement();
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !data) {
    const isExpired = error?.toLowerCase().includes('expired');
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-8 pb-8 text-center">
            <div className="text-2xl font-bold text-foreground mb-1">✨ Cha Jewels</div>
            <p className="text-xs text-muted-foreground mb-6">Layaway Payment Statement</p>
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {isExpired ? 'Statement Link Expired' : 'Invalid Statement Link'}
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              {isExpired
                ? 'This statement link has expired. Please request a new link from Cha Jewels.'
                : 'This link is invalid or no longer active. Please contact Cha Jewels to request a new statement link.'}
            </p>
            <p className="text-xs text-muted-foreground/70">
              If you believe this is a mistake, please reach out to your Cha Jewels representative.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const nextPayment = getNextPaymentInfo(data.schedule);
  const totalLayaway = data.total_amount;
  const currentTotalPayable = data.current_total_payable ?? (data.computed_remaining + data.total_active_penalties);

  return (
    <div className="min-h-screen bg-background">
      {/* Action buttons - hidden on print */}
      <div className="print:hidden fixed top-4 right-4 z-50 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4 mr-2" /> Print
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Download className="h-4 w-4 mr-2" /> Save PDF
        </Button>
      </div>

      <div ref={printRef} className="max-w-2xl mx-auto p-4 sm:p-8 print:p-4">
        {/* Brand Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground font-display tracking-tight">
            ✨ Cha Jewels
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Layaway Payment Statement</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Generated {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        {/* Account Summary */}
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-base font-display">Invoice #{data.invoice_number}</CardTitle>
              <Badge variant="outline" className={
                data.status === 'completed' ? 'bg-primary/10 text-primary border-primary/20' :
                data.status === 'overdue' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                data.status === 'forfeited' ? 'bg-orange-500/10 text-orange-500 border-orange-500/20' :
                'bg-success/10 text-success border-success/20'
              }>
                {data.status === 'active' ? 'Active' :
                 data.status === 'overdue' ? 'Overdue' :
                 data.status === 'completed' ? 'Completed' :
                 data.status.charAt(0).toUpperCase() + data.status.slice(1)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">Customer: <span className="text-foreground font-medium">{data.customer_name}</span></p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Total Layaway</p>
                <p className="text-sm font-bold text-foreground font-display tabular-nums">{fmt(totalLayaway, data.currency)}</p>
              </div>
              <div className="rounded-lg bg-success/5 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Total Paid</p>
                <p className="text-sm font-bold text-success font-display tabular-nums">{fmt(data.total_paid, data.currency)}</p>
              </div>
              <div className="rounded-lg bg-primary/5 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Remaining Balance</p>
                <p className="text-sm font-bold text-foreground font-display tabular-nums">{fmt(data.computed_remaining, data.currency)}</p>
              </div>
              {data.total_active_penalties > 0 && (
                <div className="rounded-lg bg-destructive/5 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Outstanding Penalties</p>
                  <p className="text-sm font-bold text-destructive font-display tabular-nums">{fmt(data.total_active_penalties, data.currency)}</p>
                </div>
              )}
              {data.total_active_penalties > 0 && (
                <div className="rounded-lg bg-warning/5 border border-warning/20 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Current Total Payable</p>
                  <p className="text-sm font-bold text-warning font-display tabular-nums">{fmt(currentTotalPayable, data.currency)}</p>
                  <p className="text-[9px] text-muted-foreground mt-0.5">Principal + Penalties</p>
                </div>
              )}
              {data.total_waived_amount > 0 && (
                <div className="rounded-lg bg-info/5 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Waived</p>
                  <p className="text-sm font-bold text-info font-display tabular-nums">{fmt(data.total_waived_amount, data.currency)}</p>
                </div>
              )}
              {data.total_services > 0 && (
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Services</p>
                  <p className="text-sm font-bold text-foreground font-display tabular-nums">{fmt(data.total_services, data.currency)}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Next Payment Banner */}
        {nextPayment && (
          <Card className="mb-6 border-primary/30 bg-primary/5">
            <CardContent className="pt-4 pb-4">
              <p className="text-[11px] text-muted-foreground mb-2.5">
                These are your next payment follow-up checkpoints if your account remains unpaid.
              </p>
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 shrink-0 mt-0.5">
                  <Clock className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Next Payment: {fmt(nextPayment.amount, data.currency)}
                  </p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Please note your next monthly payment is on{' '}
                    <span className="font-medium text-foreground">
                      {new Date(nextPayment.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                    </span>.
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Please expect another payment reminder from us.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Payment Timeline */}
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-display">Payment Schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {/* Downpayment */}
              {data.downpayment_amount > 0 && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/10">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-primary text-xs font-bold shrink-0">DP</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">30% Downpayment</p>
                    <p className="text-xs text-muted-foreground">Due on order date</p>
                  </div>
                  <p className="text-sm font-semibold text-primary tabular-nums">{fmt(data.downpayment_amount, data.currency)}</p>
                </div>
              )}

              {data.schedule.map((item) => {
                const isPaid = item.status === 'paid' || (item.paid_amount > 0 && item.paid_amount >= item.total_due);
                const remaining = Math.max(0, item.total_due - item.paid_amount);
                const today = new Date().toISOString().split('T')[0];
                const isOverdue = !isPaid && item.due_date < today && item.status !== 'cancelled';

                // Find penalties for this installment
                const installmentPenalties = data.penalties.filter(p => {
                  // Match by schedule - since we don't have schedule_id, match by installment
                  return true; // We'll show penalty_amount from schedule directly
                });

                return (
                  <div key={item.installment_number}
                    className={`p-3 rounded-lg border ${
                      isPaid ? 'bg-success/5 border-success/10' :
                      isOverdue ? 'bg-destructive/5 border-destructive/10' :
                      'bg-card border-border'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0 ${
                        isPaid ? 'bg-success/20 text-success' :
                        isOverdue ? 'bg-destructive/20 text-destructive' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {isPaid ? <Check className="h-3.5 w-3.5" /> : item.installment_number}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">
                            Installment {item.installment_number}
                          </p>
                          {isPaid && <Badge variant="outline" className="text-[10px] py-0 h-4 bg-success/10 text-success border-success/20">Paid</Badge>}
                          {isOverdue && <Badge variant="outline" className="text-[10px] py-0 h-4 bg-destructive/10 text-destructive border-destructive/20">Overdue</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {new Date(item.due_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                        </p>
                        {/* Breakdown */}
                        <div className="mt-1.5 text-xs text-muted-foreground space-y-0.5">
                          <p>Base: {fmt(item.base_amount, data.currency)}</p>
                          {item.penalty_amount > 0 && (
                            <p className="text-destructive">Penalty: {fmt(item.penalty_amount, data.currency)}</p>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-sm font-semibold tabular-nums ${isPaid ? 'text-success' : 'text-foreground'}`}>
                          {fmt(isPaid ? Math.max(item.paid_amount, item.total_due) : item.total_due, data.currency)}
                        </p>
                        {!isPaid && item.paid_amount > 0 && (
                          <p className="text-[10px] text-muted-foreground">
                            Paid: {fmt(item.paid_amount, data.currency)}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Penalty Transparency */}
        {data.penalties.length > 0 && (
          <Card className="mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-display">Penalty Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {data.penalties.map((p, idx) => (
                  <div key={idx} className={`flex items-center justify-between p-2.5 rounded-lg border ${
                    p.status === 'waived' ? 'bg-info/5 border-info/10' :
                    p.status === 'paid' ? 'bg-success/5 border-success/10' :
                    'bg-destructive/5 border-destructive/10'
                  }`}>
                    <div>
                      <p className="text-xs font-medium text-foreground">{stageLabel(p.stage)} Penalty</p>
                      <p className="text-[10px] text-muted-foreground">
                        Applied {new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                      {p.status === 'waived' && (
                        <p className="text-[10px] text-info mt-0.5">✓ Waived by Cha Jewels</p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-semibold tabular-nums ${
                        p.status === 'waived' ? 'line-through text-muted-foreground' : 'text-destructive'
                      }`}>
                        {fmt(p.amount, data.currency)}
                      </p>
                      <Badge variant="outline" className={`text-[10px] py-0 h-4 ${
                        p.status === 'waived' ? 'bg-info/10 text-info border-info/20' :
                        p.status === 'paid' ? 'bg-success/10 text-success border-success/20' :
                        'bg-destructive/10 text-destructive border-destructive/20'
                      }`}>
                        {p.status === 'waived' ? 'Waived' : p.status === 'paid' ? 'Paid' : 'Active'}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Services */}
        {data.services.length > 0 && (
          <Card className="mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-display">Additional Services</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {data.services.map((s, idx) => (
                  <div key={idx} className="flex items-center justify-between p-2.5 rounded-lg border border-border">
                    <div>
                      <p className="text-xs font-medium text-foreground">{SERVICE_LABELS[s.type] || s.type}</p>
                      {s.description && <p className="text-[10px] text-muted-foreground">{s.description}</p>}
                    </div>
                    <p className="text-sm font-semibold tabular-nums text-foreground">{fmt(s.amount, data.currency)}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Payment History */}
        {data.payments.length > 0 && (
          <Card className="mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-display">Payment History</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5">
                {data.payments.map((p, idx) => (
                  <div key={idx} className="flex items-center justify-between p-2.5 rounded-lg border border-success/10 bg-success/5">
                    <div>
                      <p className="text-xs text-muted-foreground">
                        {new Date(p.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                      </p>
                      {p.method && <p className="text-[10px] text-muted-foreground capitalize">{p.method}</p>}
                    </div>
                    <p className="text-sm font-semibold text-success tabular-nums">{fmt(p.amount, data.currency)}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Footer with quick actions */}
        <div className="text-center mt-8 pb-8 print:pb-4">
          <p className="text-xs text-muted-foreground mb-4">
            Thank you for your continued trust in Cha Jewels. 💛
          </p>
          <div className="print:hidden flex flex-wrap justify-center gap-2 mb-4">
            <a href="https://m.me/chajewels" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="text-xs">
                <MessageCircle className="h-3.5 w-3.5 mr-1.5" /> Contact Cha Jewels
              </Button>
            </a>
          </div>
          <p className="text-[10px] text-muted-foreground">
            For questions about your layaway, please contact us via Messenger.
          </p>
        </div>
      </div>
    </div>
  );
}
