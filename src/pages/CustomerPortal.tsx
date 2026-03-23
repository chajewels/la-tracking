import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertTriangle, Calendar, Check, CheckCircle, ChevronRight, Clock,
  CreditCard, Diamond, FileText, Filter, Search, TrendingUp, X,
  Upload, Send, ArrowLeft, Landmark, Wallet, Eye, MessageSquare, XCircle, Loader2, Image as ImageIcon,
  User, Pencil, Save, Copy, Zap, Phone, MapPin, Mail, Building2, Smartphone,
} from 'lucide-react';
import chaJewelsLogo from '@/assets/cha-jewels-logo.jpeg';
import CountrySelect from '@/components/customers/CountrySelect';
import { LocationType, parseLocation, toLocationString } from '@/lib/countries';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const STATEMENT_BASE = 'https://chajewelslayaway.web.app';

/* ─── Types ─── */
interface PaymentMethod {
  id: string;
  method_name: string;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
  instructions: string | null;
  qr_image_url: string | null;
}

interface Submission {
  id: string;
  submitted_amount: number;
  payment_date: string;
  payment_method: string;
  reference_number: string | null;
  sender_name: string | null;
  notes: string | null;
  proof_url: string | null;
  status: string;
  reviewer_notes: string | null;
  created_at: string;
}

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
  outstanding_penalties: number;
  current_total_payable: number;
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
  submissions: Submission[];
}

interface CustomerProfile {
  full_name: string;
  location: string | null;
  facebook_name: string | null;
  messenger_link: string | null;
  mobile_number: string | null;
  email: string | null;
  notes: string | null;
}

interface PortalData {
  customer_name: string;
  customer_code: string;
  customer_id: string;
  profile: CustomerProfile;
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
  payment_methods: PaymentMethod[];
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

function fmtDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
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

const submissionStatusConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  submitted: { label: 'Submitted', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20', icon: <Send className="h-3 w-3" /> },
  under_review: { label: 'Under Review', color: 'bg-warning/10 text-warning border-warning/20', icon: <Eye className="h-3 w-3" /> },
  confirmed: { label: 'Confirmed by Cha Jewels', color: 'bg-success/10 text-success border-success/20', icon: <CheckCircle className="h-3 w-3" /> },
  rejected: { label: 'Rejected', color: 'bg-destructive/10 text-destructive border-destructive/20', icon: <XCircle className="h-3 w-3" /> },
  needs_clarification: { label: 'Needs Clarification', color: 'bg-warning/10 text-warning border-warning/20', icon: <MessageSquare className="h-3 w-3" /> },
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
  const [portalView, setPortalView] = useState<'accounts' | 'profile'>('accounts');

  const fetchPortal = async () => {
    if (!token) { setError('No access token provided.'); setLoading(false); return; }
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

  useEffect(() => { fetchPortal(); }, [token]);

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

  return (
    <div className="min-h-screen bg-[hsl(var(--background))]">
      {/* Header */}
      <div className="bg-[hsl(var(--card))] border-b border-[hsl(var(--border))]">
        <div className="max-w-3xl mx-auto px-4 py-5 sm:py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={chaJewelsLogo} alt="Cha Jewels" className="h-10 w-10 rounded-lg object-cover shadow-sm" />
              <div>
                <h1 className="text-lg sm:text-xl font-bold font-display text-foreground tracking-tight">
                  Cha Jewels
                </h1>
                <p className="text-[11px] text-muted-foreground">
                  Welcome, <span className="text-foreground font-medium">{data.customer_name}</span>
                </p>
              </div>
            </div>
            <Button
              variant={portalView === 'profile' ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() => setPortalView(portalView === 'profile' ? 'accounts' : 'profile')}
            >
              <User className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{portalView === 'profile' ? 'My Accounts' : 'My Profile'}</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {portalView === 'profile' ? (
          <ProfileEditor
            profile={data.profile}
            portalToken={token!}
            onSaved={(updated) => setData({ ...data, profile: updated, customer_name: updated.full_name })}
          />
        ) : (
          <>
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
          </>
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
              allAccounts={data.accounts}
              paymentMethods={data.payment_methods}
              portalToken={token!}
              onClose={() => setSelectedAccount(null)}
              onRefresh={fetchPortal}
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
  const isOverdue = account.status_label === 'Overdue';
  const pendingSubs = account.submissions?.filter(s => ['submitted', 'under_review'].includes(s.status)).length || 0;

  return (
    <Card className={`shadow-sm hover:shadow-md transition-shadow cursor-pointer group ${isOverdue ? 'ring-1 ring-destructive/30' : ''}`} onClick={onViewDetails}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-xs text-muted-foreground font-medium">Invoice</p>
            <p className="text-base font-bold font-display text-foreground">#{account.invoice_number}</p>
          </div>
          <div className="flex items-center gap-2">
            {pendingSubs > 0 && (
              <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20 text-[10px]">
                {pendingSubs} pending
              </Badge>
            )}
            <Badge variant="outline" className={`text-[10px] ${colorClass}`}>
              {account.status_label}
            </Badge>
          </div>
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
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {(account.outstanding_penalties ?? 0) > 0 ? 'Total Payable' : 'Remaining'}
            </p>
            <p className={`text-sm font-semibold tabular-nums ${(account.outstanding_penalties ?? 0) > 0 ? 'text-warning' : 'text-foreground'}`}>
              {fmt((account.outstanding_penalties ?? 0) > 0 ? (account.current_total_payable ?? account.remaining_balance) : account.remaining_balance, currency)}
            </p>
          </div>
        </div>

        {/* Next Due & Pay Now hint */}
        <div className="flex items-center justify-between pt-2 border-t border-[hsl(var(--border))]">
          {account.next_due_date && account.remaining_balance > 0 ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>Next due: <span className={`font-medium ${isOverdue ? 'text-destructive' : 'text-foreground'}`}>{fmtDate(account.next_due_date)}</span></span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">{account.remaining_balance <= 0 ? 'Fully paid' : 'No upcoming dues'}</span>
          )}
          <div className="flex items-center gap-1.5">
            {account.remaining_balance > 0 && (
              <span className="text-[10px] text-primary font-medium">Pay Now →</span>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Account Detail Panel ─── */
function AccountDetail({ account, allAccounts, paymentMethods, portalToken, onClose, onRefresh }: {
  account: PortalAccount;
  allAccounts: PortalAccount[];
  paymentMethods: PaymentMethod[];
  portalToken: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const currency = account.currency;
  const colorClass = statusColor[account.status_label] || statusColor['Active'];
  const today = new Date().toISOString().split('T')[0];
  const isOverdue = account.status_label === 'Overdue';
  const canPay = account.remaining_balance > 0 && !['completed', 'cancelled', 'forfeited', 'final_forfeited'].includes(account.status);
  const [activeTab, setActiveTab] = useState<'overview' | 'pay' | 'submissions'>('overview');

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

        {/* Overdue Warning */}
        {isOverdue && (
          <div className="mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-destructive">Payment Overdue</p>
              <p className="text-[10px] text-destructive/80 mt-0.5">
                Your payment is past due. Please submit your payment as soon as possible to avoid additional penalties.
              </p>
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <InfoBlock label="Total Amount" value={fmt(account.total_amount, currency)} />
          <InfoBlock label="Remaining Balance" value={fmt(account.remaining_balance, currency)} highlight={isOverdue} />
          {(account.outstanding_penalties ?? 0) > 0 && (
            <InfoBlock label="Outstanding Penalties" value={fmt(account.outstanding_penalties, currency)} highlight />
          )}
          {(account.outstanding_penalties ?? 0) > 0 && (
            <InfoBlock label="Current Total Payable" value={fmt(account.current_total_payable ?? account.remaining_balance, currency)} highlight />
          )}
          <InfoBlock label="Next Due" value={account.next_due_date ? fmtDateLong(account.next_due_date) : '—'} />
          <InfoBlock label="Next Amount" value={account.next_due_amount ? fmt(account.next_due_amount, currency) : '—'} />
        </div>

        {/* Tabs */}
        <div className="mt-4 flex gap-1 bg-muted/30 rounded-lg p-1">
          {(['overview', 'pay', 'submissions'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 text-xs font-medium py-2 rounded-md transition-all ${
                activeTab === tab
                  ? 'bg-[hsl(var(--card))] text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'overview' ? 'Schedule' : tab === 'pay' ? '💳 Pay Now' : `Submissions${account.submissions?.length ? ` (${account.submissions.length})` : ''}`}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {activeTab === 'overview' && (
          <OverviewTab account={account} statementUrl={statementUrl} today={today} />
        )}
        {activeTab === 'pay' && canPay && (
          <PayNowTab
            account={account}
            allAccounts={allAccounts}
            paymentMethods={paymentMethods}
            portalToken={portalToken}
            onSuccess={() => {
              setActiveTab('submissions');
              onRefresh();
            }}
          />
        )}
        {activeTab === 'pay' && !canPay && (
          <div className="text-center py-12">
            <CheckCircle className="h-12 w-12 text-success mx-auto mb-4" />
            <h3 className="text-lg font-semibold font-display text-foreground mb-2">No Payment Due</h3>
            <p className="text-sm text-muted-foreground">This account has no outstanding balance or is not accepting payments at this time.</p>
          </div>
        )}
        {activeTab === 'submissions' && (
          <SubmissionsTab submissions={account.submissions || []} currency={currency} />
        )}
      </div>
    </div>
  );
}

/* ─── Overview Tab ─── */
function OverviewTab({ account, statementUrl, today }: {
  account: PortalAccount; statementUrl: string | null; today: string;
}) {
  const currency = account.currency;
  return (
    <>
      {statementUrl && (
        <a href={statementUrl} target="_blank" rel="noopener noreferrer">
          <Button className="w-full gap-2" variant="default">
            <FileText className="h-4 w-4" /> View Full Statement
          </Button>
        </a>
      )}

      {/* Progress */}
      <div>
        <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
          <span className="font-medium">{fmt(account.total_paid, currency)} paid</span>
          <span>{fmt(account.remaining_balance, currency)} remaining</span>
        </div>
        <Progress value={account.progress_percent} className="h-2.5" />
        <p className="text-[10px] text-muted-foreground mt-1 text-right">
          {account.paid_installments}/{account.total_installments} installments completed
        </p>
      </div>

      {/* Payment Schedule */}
      <div>
        <h3 className="text-sm font-semibold font-display text-foreground mb-3 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-primary" /> Payment Schedule
        </h3>
        <div className="space-y-1.5">
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
                    {p.method && <span className="text-[10px] text-muted-foreground capitalize">{p.method}</span>}
                    {p.reference && <span className="text-[10px] text-muted-foreground">Ref: {p.reference}</span>}
                  </div>
                </div>
                <p className="text-sm font-semibold text-success tabular-nums">{fmt(p.amount, account.currency)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ─── Hardcoded Cha Jewels Payment Methods ─── */
interface ChaPaymentMethod {
  id: string;
  name: string;
  group: 'PH' | 'JP';
  icon: React.ReactNode;
  isFast?: boolean;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  branchName?: string;
  bankCode?: string;
  branchCode?: string;
  accountType?: string;
  recipientAddress?: string;
  phone?: string;
  email?: string;
  extraNumbers?: Array<{ number: string; label: string }>;
  location?: string;
  payId?: string;
}

const CHA_PAYMENT_METHODS: ChaPaymentMethod[] = [
  // Philippines
  {
    id: 'bpi', name: 'BPI', group: 'PH',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'Bank of the Philippine Islands (BPI)',
    accountNumber: '8899-2755-95',
    accountName: 'CHAJEWELSJAPAN JEWELRY AND ACCESSORIES SHOP',
    branchName: 'Rosario Batangas',
    accountType: 'Peso Savings',
    recipientAddress: '296 Calicanto San Juan Batangas 4226',
    phone: '0916-723-5528',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'metrobank', name: 'Metrobank', group: 'PH',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'Metrobank',
    accountNumber: '397-7-397-55124-1',
    accountName: 'CHAJEWELSJAPAN JEWELRY AND ACCESSORIES SHOP',
    branchName: 'Rosario Batangas',
    accountType: 'Peso Savings',
    recipientAddress: '296 Calicanto San Juan Batangas 4226',
    phone: '0916-723-5528',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'bdo', name: 'BDO', group: 'PH',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'BDO Unibank',
    accountNumber: '004970387187',
    accountName: 'CHAJEWELSJAPAN JEWELRY AND ACCESSORIES SHOP',
    branchName: 'San Juan Batangas',
    accountType: 'Peso Savings',
    recipientAddress: 'Calicanto San Juan Batangas',
    phone: '0952-446-8539',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'gcash', name: 'GCash', group: 'PH',
    icon: <Smartphone className="h-5 w-5" />,
    isFast: true,
    extraNumbers: [
      { number: '0916-723-5528', label: 'April Largo' },
      { number: '0915-7511-043', label: 'Cynthia Largo' },
    ],
  },
  {
    id: 'cash-pickup', name: 'Cash Pickup', group: 'PH',
    icon: <MapPin className="h-5 w-5" />,
    accountName: 'Cesar Magsino',
    location: 'San Juan Batangas',
    phone: '0906 032 2808',
  },
  // Japan
  {
    id: 'rakuten', name: 'Rakuten Bank', group: 'JP',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'Rakuten Bank',
    branchName: '第四営業支店',
    bankCode: '0036',
    branchCode: '254',
    accountNumber: '7555832',
    accountType: 'Ordinary (Futsuu)',
    accountName: 'チャ ジュエルズ カブシキガイシャ',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'sumitomo', name: 'Sumitomo Bank', group: 'JP',
    icon: <Building2 className="h-5 w-5" />,
    bankName: 'Sumitomo Bank',
    branchName: '新小岩',
    bankCode: '0009',
    branchCode: '232',
    accountNumber: '7756718',
    accountType: 'Ordinary (Futsuu)',
    accountName: 'ﾁﾔ- ｼﾞﾕｴﾙｽ ﾗﾙｺﾞ ｼﾝﾃｲｱ ﾈﾗ',
    email: 'sales@chajewelsjp.com',
  },
  {
    id: 'paypay', name: 'PayPay', group: 'JP',
    icon: <Smartphone className="h-5 w-5" />,
    isFast: true,
    payId: 'chajewelsjapan',
    phone: '070-8307-3318',
  },
];

function copyToClipboard(text: string, label: string, setCopied: (v: string | null) => void) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  });
}

function buildFullDetails(m: ChaPaymentMethod): string {
  const lines: string[] = [m.name];
  if (m.bankName) lines.push(`Bank: ${m.bankName}`);
  if (m.branchName) lines.push(`Branch: ${m.branchName}`);
  if (m.bankCode) lines.push(`Bank Code: ${m.bankCode}`);
  if (m.branchCode) lines.push(`Branch Code: ${m.branchCode}`);
  if (m.accountNumber) lines.push(`Account #: ${m.accountNumber}`);
  if (m.accountType) lines.push(`Type: ${m.accountType}`);
  if (m.accountName) lines.push(`Name: ${m.accountName}`);
  if (m.recipientAddress) lines.push(`Address: ${m.recipientAddress}`);
  if (m.phone) lines.push(`Phone: ${m.phone}`);
  if (m.email) lines.push(`Email: ${m.email}`);
  if (m.payId) lines.push(`PayPay ID: ${m.payId}`);
  if (m.location) lines.push(`Location: ${m.location}`);
  if (m.extraNumbers) m.extraNumbers.forEach(n => lines.push(`${n.label}: ${n.number}`));
  return lines.join('\n');
}

/* ─── Payment Method Detail Card ─── */
function PaymentMethodCard({ method, onSelect, copiedField, setCopied }: {
  method: ChaPaymentMethod;
  onSelect: () => void;
  copiedField: string | null;
  setCopied: (v: string | null) => void;
}) {
  const CopyBtn = ({ text, label }: { text: string; label: string }) => (
    <button
      onClick={(e) => { e.stopPropagation(); copyToClipboard(text, label, setCopied); }}
      className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors font-medium"
    >
      {copiedField === label ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copiedField === label ? 'Copied!' : `Copy`}
    </button>
  );

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] overflow-hidden hover:border-primary/30 transition-all">
      {/* Header */}
      <div className="p-4 flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 text-primary">
          {method.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{method.name}</p>
            {method.isFast && (
              <Badge variant="outline" className="text-[9px] py-0 h-4 bg-success/10 text-success border-success/20 gap-0.5">
                <Zap className="h-2.5 w-2.5" /> Fast
              </Badge>
            )}
          </div>
          {method.bankName && <p className="text-xs text-muted-foreground">{method.bankName}</p>}
          {method.accountType && !method.bankName && <p className="text-xs text-muted-foreground">{method.accountType}</p>}
        </div>
      </div>

      {/* Details */}
      <div className="px-4 pb-3 space-y-1.5 text-xs">
        {method.accountNumber && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Account #:</span>
            <span className="flex items-center gap-2">
              <span className="font-mono font-medium text-foreground">{method.accountNumber}</span>
              <CopyBtn text={method.accountNumber} label={`${method.id}-acct`} />
            </span>
          </div>
        )}
        {method.accountName && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Name:</span>
            <span className="flex items-center gap-2 min-w-0">
              <span className="font-medium text-foreground text-right truncate">{method.accountName}</span>
              <CopyBtn text={method.accountName} label={`${method.id}-name`} />
            </span>
          </div>
        )}
        {method.branchName && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Branch:</span>
            <span className="font-medium text-foreground">{method.branchName}</span>
          </div>
        )}
        {method.bankCode && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Bank Code:</span>
            <span className="font-mono font-medium text-foreground">{method.bankCode}</span>
          </div>
        )}
        {method.branchCode && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Branch Code:</span>
            <span className="font-mono font-medium text-foreground">{method.branchCode}</span>
          </div>
        )}
        {method.accountType && method.bankName && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Type:</span>
            <span className="text-foreground">{method.accountType}</span>
          </div>
        )}
        {method.payId && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">PayPay ID:</span>
            <span className="flex items-center gap-2">
              <span className="font-mono font-medium text-foreground">{method.payId}</span>
              <CopyBtn text={method.payId} label={`${method.id}-payid`} />
            </span>
          </div>
        )}
        {method.extraNumbers && method.extraNumbers.map((n, i) => (
          <div key={i} className="flex items-center justify-between">
            <span className="text-muted-foreground">{n.label}:</span>
            <span className="flex items-center gap-2">
              <span className="font-mono font-medium text-foreground">{n.number}</span>
              <CopyBtn text={n.number} label={`${method.id}-num-${i}`} />
            </span>
          </div>
        ))}
        {method.recipientAddress && (
          <div className="flex items-start justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Address:</span>
            <span className="text-foreground text-right text-[11px]">{method.recipientAddress}</span>
          </div>
        )}
        {method.location && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Location:</span>
            <span className="text-foreground">{method.location}</span>
          </div>
        )}
        {method.phone && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Phone:</span>
            <span className="flex items-center gap-2">
              <span className="font-medium text-foreground">{method.phone}</span>
              <CopyBtn text={method.phone} label={`${method.id}-phone`} />
            </span>
          </div>
        )}
        {method.email && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Email:</span>
            <span className="text-foreground">{method.email}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 pb-4 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 text-xs gap-1.5"
          onClick={(e) => { e.stopPropagation(); copyToClipboard(buildFullDetails(method), `${method.id}-full`, setCopied); }}
        >
          <Copy className="h-3 w-3" />
          {copiedField === `${method.id}-full` ? 'Copied!' : 'Copy All Details'}
        </Button>
        <Button
          size="sm"
          className="flex-1 text-xs gap-1.5"
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
        >
          <Send className="h-3 w-3" /> Select & Pay
        </Button>
      </div>
    </div>
  );
}

/* ─── Pay Now Tab ─── */
function PayNowTab({ account, allAccounts, paymentMethods: _dbMethods, portalToken, onSuccess }: {
  account: PortalAccount;
  allAccounts: PortalAccount[];
  paymentMethods: PaymentMethod[];
  portalToken: string;
  onSuccess: () => void;
}) {
  const currency = account.currency;
  const [step, setStep] = useState<'methods' | 'form' | 'success'>('methods');
  const [selectedMethodName, setSelectedMethodName] = useState<string>('');
  const [selectedChaMethod, setSelectedChaMethod] = useState<ChaPaymentMethod | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Split payment state
  const [paymentMode, setPaymentMode] = useState<'single' | 'split'>('single');
  const payableAccounts = allAccounts.filter(a =>
    a.remaining_balance > 0 &&
    !['completed', 'cancelled', 'forfeited', 'final_forfeited'].includes(a.status) &&
    a.currency === currency
  );
  const [splitAllocations, setSplitAllocations] = useState<Record<string, string>>({});

  // ── Auto-distribute helper ──
  // Compute due priority and target amount per account
  const getAccountDuePriority = (acct: PortalAccount): { priority: number; label: string; badgeClass: string; targetAmount: number } => {
    const today = new Date().toISOString().split('T')[0];
    const unpaidItems = acct.schedule
      .filter(s => s.status !== 'paid' && s.status !== 'cancelled' && s.paid_amount < s.total_due)
      .sort((a, b) => a.due_date.localeCompare(b.due_date));

    const nextItem = unpaidItems[0];
    if (!nextItem) {
      return { priority: 99, label: '', badgeClass: '', targetAmount: 0 };
    }

    // Target = next installment remaining + outstanding penalties + services
    const nextDueRemaining = nextItem.total_due - nextItem.paid_amount;
    const targetAmount = Math.max(0, nextDueRemaining + (acct.outstanding_penalties || 0) + (acct.total_services || 0));

    const dueDate = nextItem.due_date;
    const todayDate = new Date(today + 'T00:00:00');
    const dueDateObj = new Date(dueDate + 'T00:00:00');
    const diffDays = Math.floor((dueDateObj.getTime() - todayDate.getTime()) / 86400000);

    if (diffDays < 0) {
      const daysOver = Math.abs(diffDays);
      if (daysOver >= 7) {
        return { priority: 1, label: '🔴 Overdue', badgeClass: 'bg-destructive/10 text-destructive border-destructive/20', targetAmount };
      }
      return { priority: 2, label: '🟠 Grace Period', badgeClass: 'bg-amber-500/10 text-amber-600 border-amber-500/20', targetAmount };
    }
    if (diffDays === 0) {
      return { priority: 3, label: '⚠️ Due Today', badgeClass: 'bg-warning/10 text-warning border-warning/20', targetAmount };
    }
    if (diffDays <= 3) {
      return { priority: 4, label: '🟡 Due Soon', badgeClass: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20', targetAmount };
    }
    if (diffDays <= 7) {
      return { priority: 5, label: '🟡 Due Soon', badgeClass: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20', targetAmount };
    }
    return { priority: 6, label: '', badgeClass: '', targetAmount };
  };

  const sortedPayableAccounts = [...payableAccounts].sort((a, b) => {
    const pa = getAccountDuePriority(a);
    const pb = getAccountDuePriority(b);
    if (pa.priority !== pb.priority) return pa.priority - pb.priority;
    // Within same priority: oldest due date first
    return (a.next_due_date || 'z').localeCompare(b.next_due_date || 'z');
  });

  const autoDistribute = () => {
    const totalPayment = parseFloat(amount) || splitTotal || 0;
    if (totalPayment <= 0) return;

    let remaining = totalPayment;
    const newAllocations: Record<string, string> = {};

    for (const acct of sortedPayableAccounts) {
      if (remaining <= 0) break;
      const { targetAmount } = getAccountDuePriority(acct);
      // Use target amount if available, otherwise use remaining balance
      const target = targetAmount > 0 ? Math.min(targetAmount, acct.remaining_balance) : acct.remaining_balance;
      const allocation = Math.min(remaining, target);
      if (allocation > 0) {
        newAllocations[acct.id] = String(Math.round(allocation));
        remaining -= allocation;
      }
    }

    // If remaining > 0 after covering all targets, distribute to accounts with remaining balance
    if (remaining > 0) {
      for (const acct of sortedPayableAccounts) {
        if (remaining <= 0) break;
        const alreadyAllocated = parseFloat(newAllocations[acct.id] || '0');
        const canTakeMore = acct.remaining_balance - alreadyAllocated;
        if (canTakeMore > 0) {
          const extra = Math.min(remaining, canTakeMore);
          newAllocations[acct.id] = String(Math.round(alreadyAllocated + extra));
          remaining -= extra;
        }
      }
    }

    setSplitAllocations(newAllocations);
  };

  const resetAllocations = () => {
    setSplitAllocations({});
  };

  // Filter methods by currency
  const relevantGroup = currency === 'JPY' ? 'JP' : 'PH';
  const primaryMethods = CHA_PAYMENT_METHODS.filter(m => m.group === relevantGroup);
  const otherMethods = CHA_PAYMENT_METHODS.filter(m => m.group !== relevantGroup);

  // Form state
  const [amount, setAmount] = useState(account.next_due_amount ? String(account.next_due_amount) : '');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [senderName, setSenderName] = useState('');
  const [notes, setNotes] = useState('');
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setFormError('File must be less than 10MB');
      return;
    }
    setProofFile(file);
    setFormError(null);
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => setProofPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setProofPreview(null);
    }
  };

  const handleSelectMethod = (m: ChaPaymentMethod) => {
    setSelectedChaMethod(m);
    setSelectedMethodName(m.name);
    setStep('form');
  };

  // Split allocation helpers
  const splitTotal = Object.values(splitAllocations).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);

  const handleSubmit = async () => {
    setFormError(null);

    if (paymentMode === 'single') {
      const parsedAmount = parseFloat(amount);
      if (!parsedAmount || parsedAmount <= 0) { setFormError('Please enter a valid amount.'); return; }
    } else {
      if (splitTotal <= 0) { setFormError('Please allocate amounts to at least one invoice.'); return; }
      const nonZero = Object.entries(splitAllocations).filter(([, v]) => parseFloat(v) > 0);
      if (nonZero.length === 0) { setFormError('Please allocate amounts to at least one invoice.'); return; }
    }

    if (!paymentDate) { setFormError('Please select a payment date.'); return; }
    if (!selectedMethodName) { setFormError('Please select a payment method.'); return; }

    setSubmitting(true);

    try {
      let proofUrl: string | null = null;
      if (proofFile) {
        const ext = proofFile.name.split('.').pop() || 'jpg';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filePath = `${account.id}/${timestamp}_${proofFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;
        const uploadRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/payment-proofs/${filePath}`,
          {
            method: 'POST',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': proofFile.type,
            },
            body: proofFile,
          }
        );
        if (uploadRes.ok) {
          proofUrl = `${SUPABASE_URL}/storage/v1/object/public/payment-proofs/${filePath}`;
        }
      }

      // Build allocations for split
      const isSplit = paymentMode === 'split';
      const allocations = isSplit
        ? Object.entries(splitAllocations)
            .filter(([, v]) => parseFloat(v) > 0)
            .map(([accId, v]) => {
              const acct = payableAccounts.find(a => a.id === accId);
              return {
                account_id: accId,
                invoice_number: acct?.invoice_number || '',
                allocated_amount: parseFloat(v),
              };
            })
        : [];

      const submittedAmount = isSplit ? splitTotal : parseFloat(amount);

      const res = await fetch(`${SUPABASE_URL}/functions/v1/submit-payment`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          portal_token: portalToken,
          account_id: isSplit ? allocations[0]?.account_id : account.id,
          submitted_amount: submittedAmount,
          payment_date: paymentDate,
          payment_method: selectedMethodName,
          reference_number: referenceNumber || null,
          sender_name: senderName || null,
          notes: notes || null,
          proof_url: proofUrl,
          submission_type: isSplit ? 'split' : 'single',
          allocations: isSplit ? allocations : undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setFormError(json.error || 'Submission failed. Please try again.');
        return;
      }

      setStep('success');
      onSuccess();
    } catch {
      setFormError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'success') {
    return (
      <div className="text-center py-10 space-y-4">
        <div className="mx-auto w-16 h-16 rounded-full bg-success/10 flex items-center justify-center">
          <CheckCircle className="h-8 w-8 text-success" />
        </div>
        <h3 className="text-lg font-semibold font-display text-foreground">Payment Submitted!</h3>
        <p className="text-sm text-muted-foreground max-w-xs mx-auto">
          Your submission has been received and is now pending verification by the Cha Jewels team.
        </p>
        {paymentMode === 'split' && (
          <div className="bg-primary/5 border border-primary/10 rounded-lg p-3 text-xs text-foreground max-w-xs mx-auto">
            <p className="font-medium mb-1">Split Payment Summary</p>
            {Object.entries(splitAllocations)
              .filter(([, v]) => parseFloat(v) > 0)
              .map(([accId, v]) => {
                const acct = payableAccounts.find(a => a.id === accId);
                return (
                  <p key={accId} className="text-muted-foreground">
                    #{acct?.invoice_number}: {fmt(parseFloat(v), currency)}
                  </p>
                );
              })}
          </div>
        )}
        <div className="bg-muted/30 rounded-lg p-4 text-xs text-muted-foreground max-w-xs mx-auto">
          <p className="font-medium text-foreground mb-1">What happens next?</p>
          <p>Our team will review your payment proof and confirm within 1–2 business days. You'll see the status update in the Submissions tab.</p>
        </div>
      </div>
    );
  }

  if (step === 'form' && selectedChaMethod) {
    return (
      <div className="space-y-5">
        <button onClick={() => setStep('methods')} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to payment methods
        </button>

        {/* Selected Method Summary */}
        <div className="p-4 rounded-xl bg-primary/5 border border-primary/10 space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Paying via</p>
            {selectedChaMethod.isFast && (
              <Badge variant="outline" className="text-[9px] py-0 h-4 bg-success/10 text-success border-success/20 gap-0.5">
                <Zap className="h-2.5 w-2.5" /> Fast
              </Badge>
            )}
          </div>
          <p className="text-sm font-semibold text-foreground">{selectedChaMethod.name}</p>
          {selectedChaMethod.bankName && <p className="text-xs text-muted-foreground">{selectedChaMethod.bankName}</p>}
          {selectedChaMethod.accountNumber && (
            <div className="flex items-center gap-2">
              <p className="text-xs text-foreground">Account #: <span className="font-mono font-medium">{selectedChaMethod.accountNumber}</span></p>
              <button
                onClick={() => copyToClipboard(selectedChaMethod.accountNumber!, `form-acct`, setCopiedField)}
                className="text-[10px] text-primary hover:text-primary/80 inline-flex items-center gap-0.5"
              >
                {copiedField === 'form-acct' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          )}
          {selectedChaMethod.accountName && (
            <p className="text-xs text-foreground">Name: <span className="font-medium">{selectedChaMethod.accountName}</span></p>
          )}
          {selectedChaMethod.extraNumbers && selectedChaMethod.extraNumbers.map((n, i) => (
            <div key={i} className="flex items-center gap-2">
              <p className="text-xs text-foreground">{n.label}: <span className="font-mono font-medium">{n.number}</span></p>
              <button
                onClick={() => copyToClipboard(n.number, `form-num-${i}`, setCopiedField)}
                className="text-[10px] text-primary hover:text-primary/80 inline-flex items-center gap-0.5"
              >
                {copiedField === `form-num-${i}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          ))}
          {selectedChaMethod.payId && (
            <div className="flex items-center gap-2">
              <p className="text-xs text-foreground">PayPay ID: <span className="font-mono font-medium">{selectedChaMethod.payId}</span></p>
              <button
                onClick={() => copyToClipboard(selectedChaMethod.payId!, `form-payid`, setCopiedField)}
                className="text-[10px] text-primary hover:text-primary/80 inline-flex items-center gap-0.5"
              >
                {copiedField === 'form-payid' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground italic mt-2">After completing your payment, please upload your proof of payment below.</p>
        </div>

        {/* Payment Mode Toggle - only show if multiple payable accounts */}
        {payableAccounts.length > 1 && (
          <div className="flex gap-1 bg-muted/30 rounded-lg p-1">
            <button
              onClick={() => setPaymentMode('single')}
              className={`flex-1 text-xs font-medium py-2 rounded-md transition-all ${
                paymentMode === 'single'
                  ? 'bg-[hsl(var(--card))] text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Single Invoice
            </button>
            <button
              onClick={() => setPaymentMode('split')}
              className={`flex-1 text-xs font-medium py-2 rounded-md transition-all ${
                paymentMode === 'split'
                  ? 'bg-[hsl(var(--card))] text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Split Across Invoices
            </button>
          </div>
        )}

        {/* Form */}
        <div className="space-y-4">
          {paymentMode === 'single' ? (
            <div>
              <Label className="text-xs">Payment Amount <span className="text-destructive">*</span></Label>
              <div className="relative mt-1.5">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  {currency === 'JPY' ? '¥' : '₱'}
                </span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="pl-8"
                  placeholder="0.00"
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Amount due: {account.next_due_amount ? fmt(account.next_due_amount, currency) : fmt(account.remaining_balance, currency)}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Total amount input for split */}
              <div>
                <Label className="text-xs">Total Payment Amount <span className="text-destructive">*</span></Label>
                <div className="relative mt-1.5">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {currency === 'JPY' ? '¥' : '₱'}
                  </span>
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="pl-8"
                    placeholder="Enter total payment"
                  />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Enter total amount then tap "Auto Distribute" or allocate manually below
                </p>
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Allocate Payment per Invoice <span className="text-destructive">*</span></Label>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={autoDistribute}
                    className="text-[10px] font-medium px-2 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  >
                    ⚡ Auto Distribute
                  </button>
                  {Object.values(splitAllocations).some(v => parseFloat(v) > 0) && (
                    <button
                      type="button"
                      onClick={resetAllocations}
                      className="text-[10px] font-medium px-2 py-1 rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              {Object.values(splitAllocations).some(v => parseFloat(v) > 0) && (
                <p className="text-[10px] text-muted-foreground italic -mt-1">Suggested based on due amounts • You can edit manually</p>
              )}
              {sortedPayableAccounts.map((acct) => {
                const duePriority = getAccountDuePriority(acct);
                return (
                  <div key={acct.id} className="p-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-semibold text-foreground">#{acct.invoice_number}</p>
                          {duePriority.label && (
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-medium ${duePriority.badgeClass}`}>
                              {duePriority.label}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          Balance: {fmt(acct.remaining_balance, currency)}
                          {duePriority.targetAmount > 0 && duePriority.targetAmount < acct.remaining_balance && (
                            <span className="ml-1">• Due now: {fmt(duePriority.targetAmount, currency)}</span>
                          )}
                        </p>
                      </div>
                      <div className="relative w-28">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                          {currency === 'JPY' ? '¥' : '₱'}
                        </span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max={acct.remaining_balance}
                          value={splitAllocations[acct.id] || ''}
                          onChange={(e) => setSplitAllocations(prev => ({ ...prev, [acct.id]: e.target.value }))}
                          className="pl-6 text-right text-xs h-8"
                          placeholder="0"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
              {(() => {
                const enteredTotal = parseFloat(amount) || 0;
                const hasMismatch = enteredTotal > 0 && splitTotal > 0 && Math.abs(splitTotal - enteredTotal) > 0.01;
                const isMatch = enteredTotal > 0 && splitTotal > 0 && Math.abs(splitTotal - enteredTotal) <= 0.01;
                return (
                  <div className={`flex items-center justify-between p-3 rounded-lg border ${
                    hasMismatch
                      ? 'bg-destructive/5 border-destructive/30'
                      : isMatch
                        ? 'bg-success/5 border-success/20'
                        : splitTotal > 0
                          ? 'bg-primary/5 border-primary/10'
                          : 'bg-muted/30 border-[hsl(var(--border))]'
                  }`}>
                    <p className="text-xs font-semibold text-foreground">Allocated</p>
                    <div className="text-right">
                      <p className={`text-sm font-bold tabular-nums ${
                        hasMismatch ? 'text-destructive' : isMatch ? 'text-success' : splitTotal > 0 ? 'text-primary' : 'text-muted-foreground'
                      }`}>
                        {fmt(splitTotal, currency)}{enteredTotal > 0 ? ` / ${fmt(enteredTotal, currency)}` : ''}
                      </p>
                      {hasMismatch && (
                        <p className="text-[10px] text-destructive mt-0.5">
                          {splitTotal > enteredTotal ? 'Over-allocated' : 'Under-allocated'} by {fmt(Math.abs(splitTotal - enteredTotal), currency)}
                        </p>
                      )}
                      {isMatch && (
                        <p className="text-[10px] text-success mt-0.5">✓ Amounts match</p>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          <div>
            <Label className="text-xs">Payment Date <span className="text-destructive">*</span></Label>
            <Input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="mt-1.5"
            />
          </div>

          <div>
            <Label className="text-xs">Reference / Transaction Number</Label>
            <Input
              value={referenceNumber}
              onChange={(e) => setReferenceNumber(e.target.value)}
              placeholder="e.g. GCash ref #12345"
              className="mt-1.5"
            />
          </div>

          <div>
            <Label className="text-xs">Sender Name (optional)</Label>
            <Input
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="Name on the sending account"
              className="mt-1.5"
            />
          </div>

          <div>
            <Label className="text-xs">Proof of Payment</Label>
            <div className="mt-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf"
                onChange={handleFileChange}
                className="hidden"
              />
              {proofPreview ? (
                <div className="relative">
                  <img src={proofPreview} alt="Proof" className="w-full h-40 object-cover rounded-lg border border-[hsl(var(--border))]" />
                  <button
                    onClick={() => { setProofFile(null); setProofPreview(null); }}
                    className="absolute top-2 right-2 h-6 w-6 rounded-full bg-background/80 flex items-center justify-center"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : proofFile ? (
                <div className="flex items-center gap-2 p-3 rounded-lg border border-[hsl(var(--border))] bg-muted/30">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-foreground truncate flex-1">{proofFile.name}</span>
                  <button onClick={() => { setProofFile(null); setProofPreview(null); }}>
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full p-6 rounded-lg border-2 border-dashed border-[hsl(var(--border))] hover:border-primary/40 transition-colors flex flex-col items-center gap-2"
                >
                  <Upload className="h-6 w-6 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Tap to upload screenshot or receipt</span>
                  <span className="text-[10px] text-muted-foreground/60">JPG, PNG, or PDF · Max 10MB</span>
                </button>
              )}
            </div>
          </div>

          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional details…"
              className="mt-1.5"
              rows={2}
            />
          </div>

          {formError && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <p className="text-xs text-destructive">{formError}</p>
            </div>
          )}

          <Button
            className="w-full gap-2"
            size="lg"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {submitting ? 'Submitting…' : paymentMode === 'split' ? `Submit Split Payment (${fmt(splitTotal, currency)})` : 'Submit Payment'}
          </Button>
        </div>
      </div>
    );
  }

  // Payment Methods list (grouped)
  return (
    <div className="space-y-5">
      {/* Amount Due Summary */}
      <div className="p-4 rounded-xl bg-primary/5 border border-primary/10 text-center">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Amount Due Now</p>
        <p className="text-2xl font-bold font-display text-primary tabular-nums">
          {account.next_due_amount ? fmt(account.next_due_amount, currency) : fmt(account.remaining_balance, currency)}
        </p>
        {account.next_due_date && (
          <p className="text-xs text-muted-foreground mt-1">Due {fmtDateLong(account.next_due_date)}</p>
        )}
      </div>

      {/* Primary Group */}
      <div>
        <h3 className="text-sm font-semibold font-display text-foreground mb-3 flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary" />
          {relevantGroup === 'PH' ? '🇵🇭 Philippines (Peso Payments)' : '🇯🇵 Japan (JPY Payments)'}
        </h3>
        {relevantGroup === 'PH' && (
          <p className="text-[10px] text-muted-foreground mb-3">Recommended for Peso accounts</p>
        )}
        {relevantGroup === 'JP' && (
          <p className="text-[10px] text-muted-foreground mb-3">Recommended for Yen accounts</p>
        )}
        <div className="space-y-3">
          {primaryMethods.map((method) => (
            <PaymentMethodCard
              key={method.id}
              method={method}
              onSelect={() => handleSelectMethod(method)}
              copiedField={copiedField}
              setCopied={setCopiedField}
            />
          ))}
        </div>
      </div>

      {/* Other Group */}
      {otherMethods.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-foreground mb-3 flex items-center gap-2">
            <Landmark className="h-4 w-4 text-muted-foreground" />
            {relevantGroup === 'PH' ? '🇯🇵 Japan (JPY Payments)' : '🇵🇭 Philippines (Peso Payments)'}
          </h3>
          <p className="text-[10px] text-muted-foreground mb-3">Other available methods</p>
          <div className="space-y-3">
            {otherMethods.map((method) => (
              <PaymentMethodCard
                key={method.id}
                method={method}
                onSelect={() => handleSelectMethod(method)}
                copiedField={copiedField}
                setCopied={setCopiedField}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Submissions Tab ─── */
function SubmissionsTab({ submissions, currency }: { submissions: Submission[]; currency: string }) {
  if (submissions.length === 0) {
    return (
      <div className="text-center py-12">
        <Send className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
        <h3 className="text-sm font-semibold text-foreground mb-1">No Submissions Yet</h3>
        <p className="text-xs text-muted-foreground">Use the Pay Now tab to submit your first payment.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold font-display text-foreground flex items-center gap-2">
        <Send className="h-4 w-4 text-primary" /> Payment Submissions
      </h3>
      {submissions.map((sub) => {
        const cfg = submissionStatusConfig[sub.status] || submissionStatusConfig.submitted;
        return (
          <div key={sub.id} className="p-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] space-y-2.5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold tabular-nums text-foreground">{fmt(sub.submitted_amount, currency)}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{fmtDateTime(sub.created_at)}</p>
              </div>
              <Badge variant="outline" className={`text-[10px] gap-1 ${cfg.color}`}>
                {cfg.icon} {cfg.label}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div>
                <span className="text-muted-foreground">Method: </span>
                <span className="text-foreground">{sub.payment_method}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Date: </span>
                <span className="text-foreground">{fmtDate(sub.payment_date)}</span>
              </div>
              {sub.reference_number && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Ref: </span>
                  <span className="text-foreground font-mono">{sub.reference_number}</span>
                </div>
              )}
            </div>

            {sub.proof_url && (
              <a href={sub.proof_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-[10px] text-primary hover:underline">
                <ImageIcon className="h-3 w-3" /> View proof of payment
              </a>
            )}

            {sub.reviewer_notes && (
              <div className={`p-2.5 rounded-lg text-xs ${
                sub.status === 'rejected' ? 'bg-destructive/5 border border-destructive/10' :
                sub.status === 'needs_clarification' ? 'bg-warning/5 border border-warning/10' :
                'bg-muted/30 border border-[hsl(var(--border))]'
              }`}>
                <p className="text-[10px] text-muted-foreground mb-0.5 font-medium">Message from Cha Jewels:</p>
                <p className="text-foreground">{sub.reviewer_notes}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Info Block ─── */
function InfoBlock({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-sm font-medium ${highlight ? 'text-destructive' : 'text-foreground'}`}>{value}</p>
    </div>
  );
}

/* ─── Profile Editor ─── */
function ProfileEditor({ profile, portalToken, onSaved }: {
  profile: CustomerProfile;
  portalToken: string;
  onSaved: (updated: CustomerProfile) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const parsed = parseLocation(profile.location);
  const [fullName, setFullName] = useState(profile.full_name);
  const [locationType, setLocationType] = useState<LocationType>(parsed.locationType);
  const [country, setCountry] = useState(parsed.country);
  const [facebookName, setFacebookName] = useState(profile.facebook_name || '');
  const [messengerLink, setMessengerLink] = useState(profile.messenger_link || '');
  const [mobileNumber, setMobileNumber] = useState(profile.mobile_number || '');
  const [email, setEmail] = useState(profile.email || '');
  const [notes, setNotes] = useState(profile.notes || '');

  const resetForm = () => {
    const p = parseLocation(profile.location);
    setFullName(profile.full_name);
    setLocationType(p.locationType);
    setCountry(p.country);
    setFacebookName(profile.facebook_name || '');
    setMessengerLink(profile.messenger_link || '');
    setMobileNumber(profile.mobile_number || '');
    setEmail(profile.email || '');
    setNotes(profile.notes || '');
    setFormError(null);
  };

  const handleLocationChange = (v: string) => {
    const lt = v as LocationType;
    setLocationType(lt);
    if (lt !== 'international') setCountry('');
  };

  const handleSave = async () => {
    setFormError(null);
    if (!fullName.trim()) { setFormError('Full Name is required.'); return; }
    if (locationType === 'international' && !country.trim()) { setFormError('Please select a country.'); return; }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFormError('Please enter a valid email address.'); return; }

    setSaving(true);
    try {
      const location = toLocationString(locationType, country);
      const res = await fetch(`${SUPABASE_URL}/functions/v1/customer-portal`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: portalToken,
          action: 'update_profile',
          profile: {
            full_name: fullName.trim(),
            location,
            facebook_name: facebookName.trim() || null,
            messenger_link: messengerLink.trim() || null,
            mobile_number: mobileNumber.trim() || null,
            email: email.trim() || null,
            notes: notes.trim() || null,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) { setFormError(json.error || 'Failed to update profile.'); return; }
      onSaved(json.profile);
      setEditing(false);
      setSuccessMsg(true);
      setTimeout(() => setSuccessMsg(false), 4000);
    } catch {
      setFormError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const locationLabel = locationType === 'japan' ? 'Japan' : locationType === 'philippines' ? 'Philippines' : country || 'International';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold font-display text-foreground flex items-center gap-2">
          <User className="h-5 w-5 text-primary" /> My Profile
        </h2>
        {!editing && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { resetForm(); setEditing(true); setSuccessMsg(false); }}>
            <Pencil className="h-3.5 w-3.5" /> Edit Profile
          </Button>
        )}
      </div>

      {successMsg && (
        <div className="p-3 rounded-lg bg-success/10 border border-success/20 flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-success shrink-0" />
          <p className="text-xs text-success font-medium">Your profile has been updated successfully.</p>
        </div>
      )}

      {!editing ? (
        <Card className="shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <ProfileField label="Full Name" value={profile.full_name} />
            <ProfileField label="Location" value={locationLabel} />
            <ProfileField label="Facebook Name" value={profile.facebook_name} />
            <ProfileField label="Messenger Link" value={profile.messenger_link} />
            <ProfileField label="Mobile Number" value={profile.mobile_number} />
            <ProfileField label="Email" value={profile.email} />
            <ProfileField label="Notes" value={profile.notes} />
          </CardContent>
        </Card>
      ) : (
        <Card className="shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Full Name <span className="text-destructive">*</span></Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Location</Label>
                <Select value={locationType} onValueChange={handleLocationChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="japan">Japan</SelectItem>
                    <SelectItem value="philippines">Philippines</SelectItem>
                    <SelectItem value="international">International</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {locationType === 'international' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Country <span className="text-destructive">*</span></Label>
                  <CountrySelect value={country} onValueChange={setCountry} />
                  <p className="text-[10px] text-muted-foreground">Please select your country for delivery and payment coordination.</p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Facebook Name</Label>
                <Input value={facebookName} onChange={(e) => setFacebookName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Messenger Link</Label>
                <Input value={messengerLink} onChange={(e) => setMessengerLink(e.target.value)} placeholder="m.me/username" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Mobile Number</Label>
                <Input value={mobileNumber} onChange={(e) => setMobileNumber(e.target.value)} placeholder="+63 or +81" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Email</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Any notes for Cha Jewels…" />
            </div>

            {formError && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <p className="text-xs text-destructive">{formError}</p>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving} className="gap-1.5">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {saving ? 'Saving…' : 'Save Changes'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ProfileField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-4">
      <p className="text-xs text-muted-foreground w-32 shrink-0">{label}</p>
      <p className="text-sm text-foreground">{value || <span className="text-muted-foreground/50 italic">Not set</span>}</p>
    </div>
  );
}
