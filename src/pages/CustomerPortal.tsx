import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertTriangle, Calendar, Check, ChevronRight, Clock,
  CreditCard, Diamond, FileText, Filter, Search, TrendingUp, X,
} from 'lucide-react';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const STATEMENT_BASE = 'https://chajewelslayaway.web.app';

interface PortalAccount {
  id: string;
  invoice_number: string;
  currency: string;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  downpayment_amount: number;
  order_date: string;
  payment_plan_months: number;
  status: string;
  status_label: string;
  progress_percent: number;
  paid_installments: number;
  total_installments: number;
  total_services: number;
  next_due_date: string | null;
  next_due_amount: number | null;
  statement_token: string | null;
  schedule: Array<{
    installment_number: number;
    due_date: string;
    base_amount: number;
    penalty_amount: number;
    total_due: number;
    paid_amount: number;
    status: string;
  }>;
  payments: Array<{
    amount: number;
    date: string;
    method: string | null;
    reference: string | null;
    remarks: string | null;
  }>;
}

interface PortalData {
  customer_name: string;
  customer_code: string;
  summary: {
    total_active: number;
    total_completed: number;
    total_outstanding: number;
    total_accounts: number;
    next_due_date: string | null;
    next_due_invoice: string | null;
    primary_currency: string;
  };
  accounts: PortalAccount[];
}

function fmt(amount: number, currency: string): string {
  if (currency === 'JPY') return `¥${amount.toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
  return `₱${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtDateLong(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

const statusColor: Record<string, string> = {
  'Active': 'bg-success/10 text-success border-success/20',
  'Fully Paid': 'bg-primary/10 text-primary border-primary/20',
  'Overdue': 'bg-destructive/10 text-destructive border-destructive/20',
  'Final Settlement': 'bg-warning/10 text-warning border-warning/20',
  'Forfeited': 'bg-destructive/10 text-destructive border-destructive/20',
  'Cancelled': 'bg-muted text-muted-foreground border-border',
};

const installmentStatusColor: Record<string, string> = {
  'paid': 'bg-success/10 text-success border-success/20',
  'overdue': 'bg-destructive/10 text-destructive border-destructive/20',
  'partially_paid': 'bg-warning/10 text-warning border-warning/20',
  'pending': 'bg-muted/50 text-muted-foreground border-border',
  'cancelled': 'bg-muted/30 text-muted-foreground/50 border-border/50',
};

const installmentStatusLabel: Record<string, string> = {
  'paid': 'Paid',
  'overdue': 'Overdue',
  'partially_paid': 'Partial',
  'pending': 'Upcoming',
  'cancelled': 'Cancelled',
};

export default function CustomerPortal() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState<PortalAccount | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<string>('newest');

  useEffect(() => {
    if (!token) { setError('No access token provided.'); setLoading(false); return; }
    const fetchPortal = async () => {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/functions/v1/customer-portal?token=${encodeURIComponent(token)}`,
          { headers: { apikey: SUPABASE_KEY } },
        );
        const json = await res.json();
        if (!res.ok) { setError(json.error || 'Access denied'); return; }
        setData(json);
      } catch { setError('Unable to load your accounts. Please try again.'); }
      finally { setLoading(false); }
    };
    fetchPortal();
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[hsl(var(--background))]">
        <Diamond className="h-8 w-8 text-primary animate-pulse mb-3" />
        <p className="text-sm text-muted-foreground">Loading your accounts…</p>
      </div>
    );
  }

  if (error || !data) {
    const isExpired = error?.toLowerCase().includes('expired');
    return (
      <div className="min-h-screen flex items-center justify-center bg-[hsl(var(--background))] p-4">
        <Card className="max-w-md w-full shadow-lg">
          <CardContent className="pt-10 pb-10 text-center">
            <Diamond className="h-8 w-8 text-primary mx-auto mb-2" />
            <div className="text-xl font-bold text-foreground mb-1 font-display">Cha Jewels</div>
            <p className="text-xs text-muted-foreground mb-8">My Layaway Accounts</p>
            <AlertTriangle className="h-10 w-10 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {isExpired ? 'Portal Link Expired' : 'Invalid Portal Link'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isExpired
                ? 'This portal link has expired. Please request a new link from Cha Jewels.'
                : 'This link is invalid or no longer active. Please contact Cha Jewels for a new portal link.'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Filter & sort accounts
  let filtered = data.accounts.filter((a) => {
    if (statusFilter !== 'all' && a.status_label !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return a.invoice_number.toLowerCase().includes(q);
    }
    return true;
  });

  filtered = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case 'oldest': return a.order_date.localeCompare(b.order_date);
      case 'due_soon': return (a.next_due_date || 'z').localeCompare(b.next_due_date || 'z');
      case 'balance': return b.remaining_balance - a.remaining_balance;
      default: return b.order_date.localeCompare(a.order_date);
    }
  });

  const currency = data.summary.primary_currency;
  const today = new Date().toISOString().split('T')[0];

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      {/* Header */}
      <div className="bg-[hsl(var(--card))] border-b border-[hsl(var(--border))]">
        <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
          <div className="flex items-center gap-3 mb-1">
            <Diamond className="h-6 w-6 text-primary" />
            <h1 className="text-xl sm:text-2xl font-bold font-display text-foreground tracking-tight">
              Cha Jewels
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-9">
            Welcome back, <span className="text-foreground font-medium">{data.customer_name}</span>
          </p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryTile label="Active Accounts" value={String(data.summary.total_active)} icon={<TrendingUp className="h-4 w-4" />} />
          <SummaryTile label="Outstanding" value={fmt(data.summary.total_outstanding, currency)} icon={<CreditCard className="h-4 w-4" />} accent />
          <SummaryTile label="Completed" value={String(data.summary.total_completed)} icon={<Check className="h-4 w-4" />} />
          <SummaryTile
            label="Next Due"
            value={data.summary.next_due_date ? fmtDate(data.summary.next_due_date) : '—'}
            icon={<Calendar className="h-4 w-4" />}
            sub={data.summary.next_due_invoice ? `#${data.summary.next_due_invoice}` : undefined}
          />
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search invoice number…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-[hsl(var(--card))]"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[150px] bg-[hsl(var(--card))]">
              <Filter className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="Active">Active</SelectItem>
              <SelectItem value="Overdue">Overdue</SelectItem>
              <SelectItem value="Fully Paid">Fully Paid</SelectItem>
              <SelectItem value="Final Settlement">Final Settlement</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-full sm:w-[150px] bg-[hsl(var(--card))]">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest First</SelectItem>
              <SelectItem value="oldest">Oldest First</SelectItem>
              <SelectItem value="due_soon">Due Soon</SelectItem>
              <SelectItem value="balance">Highest Balance</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Account Cards */}
        {filtered.length === 0 ? (
          <Card className="shadow-sm">
            <CardContent className="py-16 text-center">
              <Diamond className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-1 font-display">
                {data.accounts.length === 0
                  ? "You don't have any layaway accounts yet."
                  : 'No accounts match your search.'}
              </h3>
              <p className="text-sm text-muted-foreground">
                {data.accounts.length === 0
                  ? 'Visit Cha Jewels to start your first layaway plan.'
                  : 'Try adjusting your filters.'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                onViewDetails={() => setSelectedAccount(account)}
              />
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="text-center py-6">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} Cha Jewels · Layaway Portal
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-1">
            For questions, please contact your Cha Jewels representative.
          </p>
        </div>
      </div>

      {/* Detail Sheet */}
      <Sheet open={!!selectedAccount} onOpenChange={(open) => !open && setSelectedAccount(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto p-0">
          {selectedAccount && (
            <AccountDetail
              account={selectedAccount}
              onClose={() => setSelectedAccount(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ─── Summary Tile ─── */
function SummaryTile({ label, value, icon, accent, sub }: {
  label: string; value: string; icon: React.ReactNode; accent?: boolean; sub?: string;
}) {
  return (
    <div className={`rounded-xl border p-3.5 ${accent ? 'border-primary/20 bg-primary/5' : 'bg-[hsl(var(--card))] border-[hsl(var(--border))]'}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
      </div>
      <p className={`text-base sm:text-lg font-bold font-display tabular-nums ${accent ? 'text-primary' : 'text-foreground'}`}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

/* ─── Account Card ─── */
function AccountCard({ account, onViewDetails }: { account: PortalAccount; onViewDetails: () => void }) {
  const currency = account.currency;
  const colorClass = statusColor[account.status_label] || statusColor['Active'];

  return (
    <Card className="shadow-sm hover:shadow-md transition-shadow cursor-pointer group" onClick={onViewDetails}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-xs text-muted-foreground font-medium">Invoice</p>
            <p className="text-base font-bold font-display text-foreground">#{account.invoice_number}</p>
          </div>
          <Badge variant="outline" className={`text-[10px] ${colorClass}`}>
            {account.status_label}
          </Badge>
        </div>

        {/* Progress */}
        <div className="mb-3">
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1.5">
            <span>{account.progress_percent}% paid</span>
            <span>{account.paid_installments}/{account.total_installments} installments</span>
          </div>
          <Progress value={account.progress_percent} className="h-2" />
        </div>

        {/* Amounts */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">{fmt(account.total_amount, currency)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Paid</p>
            <p className="text-sm font-semibold tabular-nums text-success">{fmt(account.total_paid, currency)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Remaining</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">{fmt(account.remaining_balance, currency)}</p>
          </div>
        </div>

        {/* Next Due & Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-[hsl(var(--border))]">
          {account.next_due_date ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>Next due: <span className="text-foreground font-medium">{fmtDate(account.next_due_date)}</span></span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">No upcoming dues</span>
          )}
          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Account Detail Panel ─── */
function AccountDetail({ account, onClose }: { account: PortalAccount; onClose: () => void }) {
  const currency = account.currency;
  const colorClass = statusColor[account.status_label] || statusColor['Active'];
  const today = new Date().toISOString().split('T')[0];

  const statementUrl = account.statement_token
    ? `${STATEMENT_BASE}/statement?token=${account.statement_token}`
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 pt-5 pb-4 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <SheetHeader className="mb-0">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Invoice</p>
              <SheetTitle className="text-xl font-display">#{account.invoice_number}</SheetTitle>
            </div>
            <Badge variant="outline" className={`text-xs ${colorClass}`}>{account.status_label}</Badge>
          </div>
        </SheetHeader>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <InfoBlock label="Order Date" value={fmtDateLong(account.order_date)} />
          <InfoBlock label="Plan" value={`${account.payment_plan_months} months`} />
          <InfoBlock label="Total Amount" value={fmt(account.total_amount, currency)} />
          <InfoBlock label="Downpayment" value={fmt(account.downpayment_amount, currency)} />
        </div>

        {/* Progress */}
        <div className="mt-4">
          <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
            <span className="font-medium">{fmt(account.total_paid, currency)} paid</span>
            <span>{fmt(account.remaining_balance, currency)} remaining</span>
          </div>
          <Progress value={account.progress_percent} className="h-2.5" />
          <p className="text-[10px] text-muted-foreground mt-1 text-right">
            {account.paid_installments}/{account.total_installments} installments completed
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Statement CTA */}
        {statementUrl && (
          <a href={statementUrl} target="_blank" rel="noopener noreferrer">
            <Button className="w-full gap-2" variant="default">
              <FileText className="h-4 w-4" /> View Full Statement
            </Button>
          </a>
        )}

        {/* Payment Schedule */}
        <div>
          <h3 className="text-sm font-semibold font-display text-foreground mb-3 flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" /> Payment Schedule
          </h3>
          <div className="space-y-1.5">
            {/* Downpayment */}
            {account.downpayment_amount > 0 && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/5 border border-primary/10">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-primary text-xs font-bold shrink-0">DP</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Downpayment</p>
                  <p className="text-xs text-muted-foreground">Due on order</p>
                </div>
                <p className="text-sm font-semibold text-primary tabular-nums">{fmt(account.downpayment_amount, currency)}</p>
              </div>
            )}
            {account.schedule.map((item) => {
              const isPaid = item.status === 'paid';
              const isOverdue = !isPaid && item.due_date < today && item.status !== 'cancelled';
              const effectiveStatus = isOverdue ? 'overdue' : item.status;
              const sColor = installmentStatusColor[effectiveStatus] || installmentStatusColor['pending'];
              const sLabel = isOverdue ? 'Overdue' : (installmentStatusLabel[item.status] || item.status);

              // Check if due within 7 days
              const dueDate = new Date(item.due_date + 'T00:00:00Z');
              const todayDate = new Date(today + 'T00:00:00Z');
              const diffDays = Math.ceil((dueDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));
              const isDueSoon = !isPaid && !isOverdue && diffDays >= 0 && diffDays <= 7 && item.status !== 'cancelled';

              return (
                <div key={item.installment_number}
                  className={`flex items-center gap-3 p-3 rounded-lg border ${
                    isPaid ? 'bg-success/5 border-success/10' :
                    isOverdue ? 'bg-destructive/5 border-destructive/10' :
                    isDueSoon ? 'bg-warning/5 border-warning/10' :
                    'bg-[hsl(var(--card))] border-[hsl(var(--border))]'
                  }`}
                >
                  <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0 ${
                    isPaid ? 'bg-success/20 text-success' :
                    isOverdue ? 'bg-destructive/20 text-destructive' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    {isPaid ? <Check className="h-3.5 w-3.5" /> : item.installment_number}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground">Month {item.installment_number}</p>
                      <Badge variant="outline" className={`text-[9px] py-0 h-4 ${sColor}`}>
                        {isDueSoon ? 'Due Soon' : sLabel}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{fmtDate(item.due_date)}</p>
                    {item.penalty_amount > 0 && (
                      <p className="text-[10px] text-destructive mt-0.5">+{fmt(item.penalty_amount, currency)} penalty</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-sm font-semibold tabular-nums ${isPaid ? 'text-success' : 'text-foreground'}`}>
                      {fmt(item.base_amount, currency)}
                    </p>
                    {!isPaid && item.paid_amount > 0 && (
                      <p className="text-[10px] text-muted-foreground">Paid: {fmt(item.paid_amount, currency)}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Payment History */}
        {account.payments.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold font-display text-foreground mb-3 flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" /> Payment History
            </h3>
            <div className="space-y-1.5">
              {account.payments.map((p, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-[hsl(var(--card))] border border-[hsl(var(--border))]">
                  <div>
                    <p className="text-sm font-medium text-foreground">{fmtDate(p.date)}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {p.method && (
                        <span className="text-[10px] text-muted-foreground capitalize">{p.method}</span>
                      )}
                      {p.reference && (
                        <span className="text-[10px] text-muted-foreground">Ref: {p.reference}</span>
                      )}
                    </div>
                    {p.remarks && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">{p.remarks}</p>
                    )}
                  </div>
                  <p className="text-sm font-semibold text-success tabular-nums">{fmt(p.amount, currency)}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Info Block ─── */
function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}
