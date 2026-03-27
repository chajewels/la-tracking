import { useState, useEffect, useRef, useMemo, memo, useCallback, lazy, Suspense } from 'react';
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
  account_id: string;
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
  customer_edited_at: string | null;
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
    accumulated_amount_spent: number;
    total_accounts: number;
    next_due_date: string | null;
    next_due_invoice: string | null;
    primary_currency: string;
  };
  accounts: PortalAccount[];
  payment_methods: PaymentMethod[];
}

function fmt(amount: number, currency: string): string {
  const n = Number(amount);
  const isWhole = n % 1 === 0;
  if (currency === 'JPY') return `¥${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  return `₱${n.toLocaleString('en-US', { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: isWhole ? 0 : 2 })}`;
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

// ─── Portal Luxury Theme ───
const P = {
  bg:  '#0A0A0A',
  s:   '#111111',
  s2:  '#1A1A1A',
  br:  '#2A2200',
  gp:  '#C9A84C',
  gl:  '#E8C96D',
  gd:  '#8B6914',
  tp:  '#F5F0E8',
  ts:  '#9A8F7E',
  gr:  'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
} as const;
const CG = "'Cormorant Garamond',Georgia,serif";

const statusColor: Record<string, string> = {
  'Active':          'text-[#C9A84C] border-[#C9A84C]/50 bg-transparent',
  'Fully Paid':      'text-[#5CB86A] border-[#5CB86A]/40 bg-transparent',
  'Overdue':         'text-[#E74C3C] border-[#E74C3C]/50 bg-transparent',
  'Final Settlement':'text-[#E8C96D] border-[#C9A84C]/40 bg-transparent',
  'Forfeited':       'text-[#E74C3C] border-[#E74C3C]/50 bg-transparent',
  'Cancelled':       'text-[#555] border-[#333] bg-transparent',
};

const installmentStatusColor: Record<string, string> = {
  'paid':          'text-[#5CB86A] border-[#5CB86A]/30 bg-transparent',
  'overdue':       'text-[#E74C3C] border-[#E74C3C]/30 bg-transparent',
  'partially_paid':'text-[#E8C96D] border-[#C9A84C]/30 bg-transparent',
  'pending':       'text-[#9A8F7E] border-[#2A2200] bg-transparent',
  'cancelled':     'text-[#444] border-[#222] bg-transparent',
};

const installmentStatusLabel: Record<string, string> = {
  'paid': 'Paid',
  'overdue': 'Overdue',
  'partially_paid': 'Partial',
  'pending': 'Upcoming',
  'cancelled': 'Cancelled',
};

const submissionStatusConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  submitted:           { label: 'Submitted',              color: 'text-[#7EA8C9] border-[#7EA8C9]/30 bg-transparent', icon: <Send className="h-3 w-3" /> },
  under_review:        { label: 'Under Review',           color: 'text-[#E8C96D] border-[#C9A84C]/30 bg-transparent', icon: <Eye className="h-3 w-3" /> },
  confirmed:           { label: 'Confirmed by Cha Jewels',color: 'text-[#5CB86A] border-[#5CB86A]/30 bg-transparent', icon: <CheckCircle className="h-3 w-3" /> },
  rejected:            { label: 'Rejected',               color: 'text-[#E74C3C] border-[#E74C3C]/30 bg-transparent', icon: <XCircle className="h-3 w-3" /> },
  needs_clarification: { label: 'Needs Clarification',    color: 'text-[#E8C96D] border-[#C9A84C]/30 bg-transparent', icon: <MessageSquare className="h-3 w-3" /> },
};

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function CustomerPortal() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState<PortalAccount | null>(null);
  const [initialDetailTab, setInitialDetailTab] = useState<'overview' | 'pay' | 'submissions'>('overview');
  const [initialPaymentMode, setInitialPaymentMode] = useState<'single' | 'split'>('single');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<string>('newest');
  const [portalView, setPortalView] = useState<'accounts' | 'profile'>('accounts');

  const openAccountPay = (account: PortalAccount, mode: 'single' | 'split' = 'single') => {
    setInitialDetailTab('pay');
    setInitialPaymentMode(mode);
    setSelectedAccount(account);
  };

  // Find first payable account for top-level Pay Now
  const payableAccounts = data?.accounts.filter(a =>
    a.remaining_balance > 0 &&
    !['completed', 'cancelled', 'forfeited', 'final_forfeited'].includes(a.status)
  ) || [];
  const hasOverdue = payableAccounts.some(a => a.status_label === 'Overdue');
  const hasDueToday = payableAccounts.some(a => {
    const today = new Date().toISOString().split('T')[0];
    return a.next_due_date === today;
  });
  const firstPayable = payableAccounts[0];

  const fetchPortal = async () => {
    if (!token) { setError('No access token provided.'); setLoading(false); return; }
    try {
      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/customer-portal?token=${encodeURIComponent(token)}`,
        { headers: { apikey: SUPABASE_KEY } },
      );
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'Access denied'); return; }
      // Override stale 'Overdue' status_label: account is only truly overdue if
      // an unpaid schedule row has due_date < today (same logic as admin view)
      const portalToday = new Date().toISOString().split('T')[0];
      const normalizedJson = {
        ...json,
        accounts: (json.accounts || []).map((a: PortalAccount) => {
          if (a.status_label === 'Overdue') {
            const hasUnpaidPastDue = (a.schedule || []).some(
              (s: { status: string; due_date: string }) => s.status !== 'paid' && s.due_date < portalToday
            );
            if (!hasUnpaidPastDue) return { ...a, status_label: 'Active' };
          }
          return a;
        }),
      };
      setData(normalizedJson);
    } catch { setError('Unable to load your accounts. Please try again.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchPortal(); }, [token]);

  if (loading) {
    return (
      <div style={{background:P.bg,minHeight:'100vh'}} className="flex flex-col items-center justify-center">
        <Diamond style={{color:P.gp}} className="h-8 w-8 animate-pulse mb-4" />
        <p style={{color:P.ts,fontFamily:CG,fontStyle:'italic',fontSize:'15px'}}>Loading your accounts…</p>
      </div>
    );
  }

  if (error || !data) {
    const isExpired = error?.toLowerCase().includes('expired');
    return (
      <div style={{background:P.bg,minHeight:'100vh'}} className="flex items-center justify-center p-4">
        <div style={{background:P.s,border:`1px solid ${P.br}`,borderTop:`2px solid ${P.gp}`,borderRadius:'2px',maxWidth:'400px',width:'100%',padding:'2.5rem 2rem',textAlign:'center'}}>
          <div style={{color:P.gp,fontFamily:CG,fontSize:'26px',fontWeight:600,letterSpacing:'0.15em',textTransform:'uppercase' as const,marginBottom:'4px'}}>Cha Jewels</div>
          <div style={{color:P.ts,fontSize:'11px',letterSpacing:'0.2em',textTransform:'uppercase' as const,marginBottom:'2rem',fontFamily:"Inter,sans-serif"}}>Layaway Portal</div>
          <AlertTriangle style={{color:'#E74C3C'}} className="h-10 w-10 mx-auto mb-4" />
          <h2 style={{color:P.tp,fontFamily:CG,fontSize:'20px',marginBottom:'8px'}}>
            {isExpired ? 'Portal Link Expired' : 'Invalid Portal Link'}
          </h2>
          <p style={{color:P.ts,fontSize:'13px',lineHeight:'1.6'}}>
            {isExpired
              ? 'This portal link has expired. Please request a new link from Cha Jewels.'
              : 'This link is invalid or no longer active. Please contact Cha Jewels for a new portal link.'}
          </p>
        </div>
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

  const accountIsCompleted = (a: PortalAccount) =>
    a.status_label === 'Fully Paid' || a.status === 'completed'
    || (a.remaining_balance <= 0 && a.schedule.length > 0 && a.schedule.every(s => s.status === 'paid' || s.status === 'cancelled'));

  filtered = [...filtered].sort((a, b) => {
    const aC = accountIsCompleted(a) ? 1 : 0;
    const bC = accountIsCompleted(b) ? 1 : 0;
    if (aC !== bC) return aC - bC;
    switch (sortBy) {
      case 'oldest': return a.order_date.localeCompare(b.order_date);
      case 'due_soon': return (a.next_due_date || 'z').localeCompare(b.next_due_date || 'z');
      case 'balance': return b.remaining_balance - a.remaining_balance;
      default: return b.order_date.localeCompare(a.order_date);
    }
  });

  const currency = data.summary.primary_currency;
  const overdueCount = data.accounts.filter(a => a.status_label === 'Overdue').length;

  return (
    <div style={{background:P.bg,minHeight:'100vh'}}>
      {/* Header */}
      <div style={{background:P.bg,borderBottom:`1px solid ${P.gd}`}}>
        <div className="max-w-lg mx-auto px-4 py-5">
          <div className="flex items-center justify-between">
            <div>
              <div style={{color:P.gp,fontFamily:CG,fontSize:'24px',fontWeight:600,letterSpacing:'0.15em',textTransform:'uppercase' as const,lineHeight:1.1}}>
                Cha Jewels
              </div>
              <div style={{height:'1px',background:P.gd,margin:'5px 0 6px'}} />
              <p style={{color:P.ts,fontFamily:CG,fontSize:'15px',fontStyle:'italic' as const}}>
                {(() => {
                  const h = new Date().getHours();
                  if (h < 12) return 'Good Morning';
                  if (h < 18) return 'Good Afternoon';
                  return 'Good Evening';
                })()},{' '}
                <span style={{color:P.tp,fontStyle:'normal' as const,fontWeight:500}}>{data.customer_name}</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              {firstPayable && (
                <button
                  className="hidden sm:flex items-center px-4 h-9 text-xs font-medium transition-all"
                  style={{
                    background: hasOverdue ? 'none' : P.gr,
                    border:`1px solid ${P.gp}`,
                    color: hasOverdue ? P.gp : P.bg,
                    borderRadius:'2px',
                    letterSpacing:'0.1em',
                    textTransform:'uppercase' as const,
                    cursor:'pointer',
                  }}
                  onClick={() => openAccountPay(firstPayable, 'single')}
                >
                  Pay Now
                </button>
              )}
              <button
                className="flex items-center gap-1.5 px-3 h-9 text-xs transition-all"
                style={{
                  background: portalView === 'profile' ? P.gr : 'transparent',
                  border:`1px solid ${P.gp}`,
                  color: portalView === 'profile' ? P.bg : P.gp,
                  borderRadius:'2px',
                  letterSpacing:'0.1em',
                  textTransform:'uppercase' as const,
                  cursor:'pointer',
                }}
                onClick={() => setPortalView(portalView === 'profile' ? 'accounts' : 'profile')}
              >
                <User className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{portalView === 'profile' ? 'Accounts' : 'Profile'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {portalView === 'profile' ? (
          <ProfileEditor
            profile={data.profile}
            portalToken={token!}
            onSaved={(updated) => setData({ ...data, profile: updated, customer_name: updated.full_name })}
          />
        ) : (
          <>
            {/* Summary Stats — luxury panel */}
            <div>
              <div style={{height:'1px',background:P.gd}} />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-0">
                <SummaryTile
                  label="Accounts"
                  value={String(data.summary.total_active)}
                  sub={overdueCount > 0 ? `${overdueCount} overdue` : 'All on track'}
                  danger={overdueCount > 0}
                />
                <SummaryTile label="Outstanding" value={fmt(data.summary.total_outstanding, currency)} financial />
                <SummaryTile label="Amount Spent" value={fmt(data.summary.accumulated_amount_spent || 0, currency)} financial success />
                <SummaryTile label="Completed" value={String(data.summary.total_completed)} />
                <SummaryTile
                  label="Next Due"
                  value={data.summary.next_due_date ? fmtDate(data.summary.next_due_date) : '—'}
                  sub={data.summary.next_due_invoice ? `#${data.summary.next_due_invoice}` : undefined}
                />
                {(() => {
                  const spent = data.summary.accumulated_amount_spent || 0;
                  const total = spent + data.summary.total_outstanding;
                  const pct = total > 0 ? Math.round(spent / total * 100) : 0;
                  return <SummaryTile label="Progress" value={`${pct}%`} />;
                })()}
              </div>
              <div style={{height:'1px',background:P.gd}} />
            </div>

            {/* Action Buttons */}
            {payableAccounts.length > 0 && (
              <div className={`grid gap-3 ${payableAccounts.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <button
                  onClick={() => openAccountPay(firstPayable, 'single')}
                  style={{
                    background: P.gr,
                    border: hasOverdue ? `1px solid #E74C3C` : 'none',
                    borderRadius:'2px',
                    height:'52px',
                    color: P.bg,
                    fontFamily:"Inter,sans-serif",
                    fontSize:'13px',
                    fontWeight:600,
                    letterSpacing:'0.15em',
                    textTransform:'uppercase' as const,
                    cursor:'pointer',
                    position:'relative' as const,
                  }}
                >
                  Pay Now
                  {hasOverdue && (
                    <span style={{
                      position:'absolute' as const,top:0,right:0,
                      background:'#E74C3C',color:'#fff',
                      fontSize:'8px',fontWeight:700,
                      letterSpacing:'0.15em',textTransform:'uppercase' as const,
                      padding:'2px 8px',
                    }}>Overdue</span>
                  )}
                </button>
                {payableAccounts.length > 1 && (
                  <button
                    onClick={() => openAccountPay(firstPayable, 'split')}
                    style={{
                      background:'transparent',
                      border:`1px solid ${P.gp}`,
                      borderRadius:'2px',
                      height:'52px',
                      color:P.gp,
                      fontFamily:"Inter,sans-serif",
                      fontSize:'13px',
                      fontWeight:500,
                      letterSpacing:'0.15em',
                      textTransform:'uppercase' as const,
                      cursor:'pointer',
                    }}
                  >
                    Split Payment
                  </button>
                )}
              </div>
            )}

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{color:P.ts}} />
                <Input
                  placeholder="Search invoice number…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                  style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[140px]" style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}}>
                  <Filter className="h-3.5 w-3.5 mr-1.5" style={{color:P.ts}} />
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
                <SelectTrigger className="w-full sm:w-[140px]" style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}}>
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
              <div style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',padding:'4rem 2rem',textAlign:'center'}}>
                <Diamond className="h-10 w-10 mx-auto mb-4" style={{color:P.gd}} />
                <p style={{color:P.tp,fontFamily:CG,fontSize:'18px',marginBottom:'8px'}}>
                  {data.accounts.length === 0 ? "No layaway accounts yet." : 'No accounts match your search.'}
                </p>
                <p style={{color:P.ts,fontSize:'13px'}}>
                  {data.accounts.length === 0 ? 'Visit Cha Jewels to start your first layaway plan.' : 'Try adjusting your filters.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((account) => (
                  <AccountCard
                    key={account.id}
                    account={account}
                    onViewDetails={() => { setInitialDetailTab('overview'); setSelectedAccount(account); }}
                    onPay={() => openAccountPay(account, 'single')}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="text-center py-6 pb-20 sm:pb-6">
          <div style={{height:'1px',background:P.gd,marginBottom:'1.5rem'}} />
          <p style={{color:P.ts,fontSize:'11px',letterSpacing:'0.15em',fontFamily:"Inter,sans-serif"}}>
            © {new Date().getFullYear()} CHA JEWELS · LAYAWAY PORTAL
          </p>
        </div>
      </div>

      {/* Sticky Mobile Pay Now Bar */}
      {firstPayable && portalView === 'accounts' && !selectedAccount && (
        <div className="fixed bottom-0 left-0 right-0 sm:hidden z-40 px-4 py-3" style={{background:P.bg,borderTop:`1px solid ${P.gd}`}}>
          <div className="flex gap-2 max-w-lg mx-auto">
            <button
              className="flex-1 h-12 font-medium transition-opacity hover:opacity-90"
              style={{background:P.gr,color:P.bg,borderRadius:'2px',fontSize:'12px',letterSpacing:'0.15em',textTransform:'uppercase' as const,cursor:'pointer',border:'none'}}
              onClick={() => openAccountPay(firstPayable, 'single')}
            >
              Pay Now
            </button>
            {payableAccounts.length > 1 && (
              <button
                className="h-12 px-4 transition-all"
                style={{background:'transparent',border:`1px solid ${P.gp}`,color:P.gp,borderRadius:'2px',fontSize:'12px',letterSpacing:'0.1em',textTransform:'uppercase' as const,cursor:'pointer'}}
                onClick={() => openAccountPay(firstPayable, 'split')}
              >
                Split
              </button>
            )}
          </div>
        </div>
      )}

      {/* Detail Sheet */}
      <Sheet open={!!selectedAccount} onOpenChange={(open) => { if (!open) { setSelectedAccount(null); setInitialDetailTab('overview'); setInitialPaymentMode('single'); } }}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto p-0" style={{background:P.bg,border:`none`,borderLeft:`1px solid ${P.gd}`}}>
          {selectedAccount && (
            <AccountDetail
              account={selectedAccount}
              allAccounts={data.accounts}
              paymentMethods={data.payment_methods}
              portalToken={token!}
              onClose={() => { setSelectedAccount(null); setInitialDetailTab('overview'); setInitialPaymentMode('single'); }}
              onRefresh={fetchPortal}
              initialTab={initialDetailTab}
              initialPaymentMode={initialPaymentMode}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ─── Summary Tile ─── */
function SummaryTile({ label, value, financial, danger, success, sub }: {
  label: string; value: string; financial?: boolean; danger?: boolean; success?: boolean; sub?: string;
}) {
  const valueColor = danger ? '#E74C3C' : success ? '#5CB86A' : financial ? P.gp : P.tp;
  return (
    <div style={{padding:'1.25rem 1rem',borderRight:`1px solid ${P.br}`,borderBottom:`1px solid ${P.br}`}}>
      <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'6px'}}>
        {label}
      </p>
      <p style={{fontFamily:CG,fontSize:'20px',fontWeight:600,color:valueColor,lineHeight:1.1,fontVariantNumeric:'tabular-nums'}} title={value}>
        {value}
      </p>
      {sub && <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,marginTop:'3px'}}>{sub}</p>}
    </div>
  );
}

/* ─── Account Card ─── */
function AccountCard({ account, onViewDetails, onPay }: { account: PortalAccount; onViewDetails: () => void; onPay: () => void }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const currency = account.currency;
  const colorClass = statusColor[account.status_label] || statusColor['Active'];
  const isOverdue = account.status_label === 'Overdue';
  const isCompleted = account.status_label === 'Fully Paid' || account.status === 'completed'
    || (account.remaining_balance <= 0 && account.schedule.length > 0 && account.schedule.every(s => s.status === 'paid' || s.status === 'cancelled'));
  const pendingSubs = account.submissions?.filter(s => ['submitted', 'under_review'].includes(s.status)).length || 0;

  return (
    <div
      onClick={onViewDetails}
      className="group cursor-pointer transition-all"
      style={{
        background: P.s,
        border: `1px solid ${isOverdue ? '#6B1A1A' : P.br}`,
        borderTop: `2px solid ${isOverdue ? '#E74C3C' : isCompleted ? '#5CB86A' : P.gp}`,
        borderRadius: '2px',
        padding: '1.25rem 1.5rem',
      }}
    >
      {/* Header: Invoice + Status */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.25em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'4px'}}>Invoice</p>
          <p style={{fontFamily:CG,fontSize:'22px',fontWeight:700,color:P.tp,letterSpacing:'0.03em',lineHeight:1}}>#{account.invoice_number}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Badge variant="outline" className={`text-[9px] font-medium ${colorClass}`} style={{borderRadius:'2px',letterSpacing:'0.12em',textTransform:'uppercase',padding:'2px 8px'}}>
            {account.status_label}
          </Badge>
          {pendingSubs > 0 && (
            <Badge variant="outline" className="text-[9px]" style={{borderRadius:'2px',color:'#7EA8C9',borderColor:'rgba(126,168,201,0.3)',background:'transparent'}}>
              {pendingSubs} pending
            </Badge>
          )}
          {(account.outstanding_penalties ?? 0) > 0 && (
            <Badge variant="outline" className="text-[9px]" style={{borderRadius:'2px',color:'#C9A84C',borderColor:'rgba(201,168,76,0.4)',background:'transparent'}}>
              +{fmt(account.outstanding_penalties, currency)} Penalty
            </Badge>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mb-4">
        <div className="flex justify-between items-baseline mb-2">
          <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{account.paid_installments} of {account.total_installments} installments</span>
          <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{account.progress_percent}%</span>
        </div>
        <div style={{height:'2px',background:P.s2,overflow:'hidden'}}>
          <div style={{
            height:'100%',
            width:`${account.progress_percent}%`,
            background: isCompleted ? '#5CB86A' : P.gr,
            transition:'width 0.7s ease',
          }} />
        </div>
      </div>

      {/* Amounts Grid */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',borderTop:`1px solid ${P.br}`,borderBottom:`1px solid ${P.br}`,margin:'0 -1.5rem',padding:'0.75rem 1.5rem',gap:'0'}}>
        {[
          { lbl: 'Total', val: fmt(account.total_amount, currency), col: P.gp },
          { lbl: 'Paid',  val: fmt(account.total_paid, currency),   col: '#5CB86A' },
          { lbl: (account.outstanding_penalties ?? 0) > 0 ? 'Payable' : 'Balance',
            val: fmt((account.outstanding_penalties ?? 0) > 0 ? (account.current_total_payable ?? account.remaining_balance) : account.remaining_balance, currency),
            col: isOverdue ? '#E74C3C' : (account.outstanding_penalties ?? 0) > 0 ? P.gl : P.gp },
        ].map((col, i) => (
          <div key={i} style={{borderRight: i < 2 ? `1px solid ${P.br}` : 'none', paddingRight: i < 2 ? '1rem' : 0, paddingLeft: i > 0 ? '1rem' : 0}}>
            <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'4px'}}>{col.lbl}</p>
            <p style={{fontFamily:"Inter,sans-serif",fontSize:'15px',fontWeight:600,color:col.col}}>{col.val}</p>
          </div>
        ))}
      </div>

      {/* Completed: compact summary + collapsible payment history */}
      {isCompleted ? (
        <>
          <div style={{marginTop:'12px',borderTop:`1px solid ${P.s2}`,paddingTop:'12px'}}>
            <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:'#5CB86A',display:'flex',alignItems:'center',gap:'6px'}}>
              🎉 <span>Fully paid — Thank you!</span>
            </p>
          </div>
          <div className="flex items-center justify-between mt-3 pt-3" style={{borderTop:`1px solid ${P.br}`}}>
            <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:'#5CB86A',display:'flex',alignItems:'center',gap:'4px'}}>
              <Check className="h-3 w-3" /> Fully paid
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); setHistoryOpen(o => !o); }}
              style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.gp,letterSpacing:'0.08em',display:'flex',alignItems:'center',gap:'4px',background:'none',border:'none',cursor:'pointer',padding:0}}
            >
              {historyOpen ? 'Hide history' : 'View history'} <ChevronRight className={`h-3.5 w-3.5 transition-transform ${historyOpen ? 'rotate-90' : ''}`} />
            </button>
          </div>
          {historyOpen && account.payments.length > 0 && (
            <div style={{marginTop:'8px',borderTop:`1px solid ${P.s2}`,paddingTop:'8px'}} onClick={e => e.stopPropagation()}>
              {account.payments
                .slice()
                .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                .map((pay, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5" style={{borderBottom:`1px solid ${P.s2}`}}>
                    <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:'#5CB86A',flexShrink:0,width:'90px'}}>
                      {fmt(pay.amount, currency)}
                    </span>
                    <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,flex:1}}>
                      {fmtDate(pay.date.split('T')[0])}
                    </span>
                    {pay.method && (
                      <span style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.gd,flexShrink:0}}>{pay.method}</span>
                    )}
                  </div>
                ))
              }
            </div>
          )}
        </>
      ) : (
      <>
      {/* Active: compact next-payment row */}
      {(() => {
        const today = new Date().toISOString().split('T')[0];
        const sorted = [...account.schedule].sort((a, b) => a.installment_number - b.installment_number);
        const nextItem = sorted.find(s => s.status !== 'cancelled' && s.status !== 'paid');

        if (!nextItem) return (
          <div style={{marginTop:'12px',borderTop:`1px solid ${P.s2}`,paddingTop:'12px'}}>
            <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:'#5CB86A',display:'flex',alignItems:'center',gap:'6px'}}>
              🎉 <span>Fully paid!</span>
            </p>
          </div>
        );

        const dueDate = new Date(nextItem.due_date + 'T00:00:00Z');
        const diffDays = Math.ceil((dueDate.getTime() - new Date(today + 'T00:00:00Z').getTime()) / 86400000);
        const isItemOverdue = diffDays < 0;
        const urgencyColor = isItemOverdue ? '#E74C3C' : diffDays === 0 ? '#E8916A' : P.tp;
        const dueLabel = isItemOverdue ? `${Math.abs(diffDays)}d overdue` : diffDays === 0 ? 'Due today' : `Due in ${diffDays}d`;
        const amount = nextItem.total_due > 0 ? nextItem.total_due : nextItem.base_amount;
        const dateLabel = dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        return (
          <div style={{marginTop:'12px'}}>
            <div className="py-3" style={{borderLeft:`3px solid ${urgencyColor}`,paddingLeft:'10px'}}>
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'6px'}}>
                {isItemOverdue ? '⚠️ Overdue Payment' : '⏰ Next Payment'}
              </p>
              <div className="flex items-baseline justify-between gap-2">
                <span style={{fontFamily:"Inter,sans-serif",fontSize:'15px',fontWeight:600,color:urgencyColor}}>
                  {fmt(amount, currency)}
                </span>
                <span style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:urgencyColor}}>
                  {dateLabel}
                </span>
              </div>
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,marginTop:'3px'}}>{dueLabel}</p>
            </div>
          </div>
        );
      })()}

      {/* Footer: view history (left) + view details (right) */}
      <div className="flex items-center justify-between mt-3 pt-3" style={{borderTop:`1px solid ${P.br}`}}>
        <button
          onClick={(e) => { e.stopPropagation(); setHistoryOpen(o => !o); }}
          style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,display:'flex',alignItems:'center',gap:'3px',background:'none',border:'none',cursor:'pointer',padding:0}}
        >
          {historyOpen ? 'Hide history' : 'View history'}
        </button>
        <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.gp,letterSpacing:'0.08em',display:'flex',alignItems:'center',gap:'4px'}}>
          View <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </div>
      {historyOpen && account.payments.length > 0 && (
        <div style={{marginTop:'8px',borderTop:`1px solid ${P.s2}`,paddingTop:'8px'}} onClick={e => e.stopPropagation()}>
          {account.payments
            .slice()
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
            .map((pay, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5" style={{borderBottom:`1px solid ${P.s2}`}}>
                <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:'#5CB86A',flexShrink:0,width:'90px'}}>
                  {fmt(pay.amount, currency)}
                </span>
                <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,flex:1}}>
                  {fmtDate(pay.date.split('T')[0])}
                </span>
                {pay.method && (
                  <span style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.gd,flexShrink:0}}>{pay.method}</span>
                )}
              </div>
            ))
          }
        </div>
      )}
      </>
      )}
    </div>
  );
}

/* ─── Account Detail Panel ─── */
function AccountDetail({ account, allAccounts, paymentMethods, portalToken, onClose, onRefresh, initialTab = 'overview', initialPaymentMode = 'single' }: {
  account: PortalAccount;
  allAccounts: PortalAccount[];
  paymentMethods: PaymentMethod[];
  portalToken: string;
  onClose: () => void;
  onRefresh: () => void;
  initialTab?: 'overview' | 'pay' | 'submissions';
  initialPaymentMode?: 'single' | 'split';
}) {
  const currency = account.currency;
  const colorClass = statusColor[account.status_label] || statusColor['Active'];
  const today = new Date().toISOString().split('T')[0];
  const isOverdue = account.status_label === 'Overdue';
  const canPay = account.remaining_balance > 0 && !['completed', 'cancelled', 'forfeited', 'final_forfeited'].includes(account.status);
  const [activeTab, setActiveTab] = useState<'overview' | 'pay' | 'submissions'>(canPay ? initialTab : 'overview');

  const statementUrl = account.statement_token
    ? `${STATEMENT_BASE}/statement?token=${account.statement_token}`
    : null;

  return (
    <div className="flex flex-col h-full" style={{background:P.bg}}>
      {/* Header */}
      <div style={{background:P.bg,borderBottom:`1px solid ${P.gd}`,padding:'1.25rem 1.25rem 0'}}>
        <SheetHeader className="mb-0">
          <div className="flex items-start justify-between">
            <div>
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'4px'}}>Invoice</p>
              <SheetTitle style={{fontFamily:CG,fontSize:'24px',fontWeight:700,color:P.tp,letterSpacing:'0.03em'}}>#{account.invoice_number}</SheetTitle>
            </div>
            <Badge variant="outline" className={`text-[9px] ${colorClass}`} style={{borderRadius:'2px',letterSpacing:'0.12em',textTransform:'uppercase',padding:'3px 10px'}}>
              {account.status_label}
            </Badge>
          </div>
        </SheetHeader>

        {/* Overdue Warning */}
        {isOverdue && (
          <div className="mt-3 flex items-start gap-2.5 p-3" style={{background:'rgba(231,76,60,0.07)',borderLeft:'3px solid #E74C3C'}}>
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{color:'#E74C3C'}} />
            <div>
              <p style={{fontSize:'12px',fontWeight:600,color:'#E74C3C'}}>Payment Overdue</p>
              <p style={{fontSize:'11px',color:'rgba(231,76,60,0.75)',marginTop:'2px'}}>
                Please submit your payment as soon as possible to avoid additional penalties.
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
        <div className="mt-4 flex" style={{borderTop:`1px solid ${P.br}`,marginLeft:'-1.25rem',marginRight:'-1.25rem'}}>
          {(['overview', 'pay', 'submissions'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                flex:1,
                padding:'10px 4px',
                fontFamily:"Inter,sans-serif",
                fontSize:'11px',
                fontWeight: activeTab === tab ? 600 : 400,
                letterSpacing:'0.1em',
                textTransform:'uppercase' as const,
                color: activeTab === tab ? P.gp : P.ts,
                background: 'transparent',
                border:'none',
                borderBottom: activeTab === tab ? `2px solid ${P.gp}` : '2px solid transparent',
                cursor:'pointer',
                transition:'all 0.15s',
              }}
            >
              {tab === 'overview' ? 'Schedule' : tab === 'pay' ? 'Pay Now' : `Submissions${account.submissions?.length ? ` (${account.submissions.length})` : ''}`}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
        {activeTab === 'overview' && (
          <OverviewTab account={account} statementUrl={statementUrl} today={today} />
        )}
        {activeTab === 'pay' && canPay && (
          <PayNowTab
            account={account}
            allAccounts={allAccounts}
            paymentMethods={paymentMethods}
            portalToken={portalToken}
            initialPaymentMode={initialPaymentMode}
            onSuccess={() => {
              setActiveTab('submissions');
              onRefresh();
            }}
          />
        )}
        {activeTab === 'pay' && !canPay && (
          <div className="text-center py-12">
            <CheckCircle className="h-12 w-12 mx-auto mb-4" style={{color:'#5CB86A'}} />
            <h3 style={{fontFamily:CG,fontSize:'20px',color:P.tp,marginBottom:'8px'}}>No Payment Due</h3>
            <p style={{fontSize:'13px',color:P.ts}}>This account has no outstanding balance or is not accepting payments at this time.</p>
          </div>
        )}
        {activeTab === 'submissions' && (
          <SubmissionsTab submissions={account.submissions || []} currency={currency} portalToken={portalToken} onRefresh={onRefresh} />
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
          <button className="w-full flex items-center justify-center gap-2 h-10 mb-1 transition-opacity hover:opacity-80"
            style={{background:'transparent',border:`1px solid ${P.gp}`,borderRadius:'2px',color:P.gp,fontFamily:"Inter,sans-serif",fontSize:'12px',letterSpacing:'0.1em',textTransform:'uppercase' as const,cursor:'pointer'}}>
            <FileText className="h-4 w-4" /> View Full Statement
          </button>
        </a>
      )}

      {/* Progress */}
      <div>
        <div className="flex justify-between mb-1.5">
          <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{account.paid_installments}/{account.total_installments} installments</span>
          <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{fmt(account.remaining_balance, currency)} remaining</span>
        </div>
        <div style={{height:'2px',background:P.s2}}>
          <div style={{height:'100%',width:`${account.progress_percent}%`,background:account.status_label==='Fully Paid'?'#5CB86A':P.gr}} />
        </div>
      </div>

      {/* Payment Schedule */}
      <div>
        <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'12px'}}>Payment Schedule</p>
        <div>
          {account.downpayment_amount > 0 && (() => {
            const taggedDpPaid2 = account.payments
              .filter(p => (p.reference && String(p.reference).startsWith('DP-')) || (p.remarks && String(p.remarks).toLowerCase() === 'downpayment'))
              .reduce((s, p) => s + p.amount, 0);
            const totalPaidAll2 = account.payments.reduce((s, p) => s + p.amount, 0);
            const dpPaid = taggedDpPaid2 > 0 ? taggedDpPaid2 : (account.downpayment_amount > 0 && totalPaidAll2 >= account.downpayment_amount ? account.downpayment_amount : 0);
            const dpFull = dpPaid >= account.downpayment_amount;
            const dpPartial = dpPaid > 0 && !dpFull;
            return (
              <div className="flex items-center gap-3 py-3" style={{borderBottom:`1px solid ${P.s2}`}}>
                <div style={{width:'28px',height:'28px',display:'flex',alignItems:'center',justifyContent:'center',background:dpFull?'rgba(92,184,106,0.15)':'rgba(201,168,76,0.1)',color:dpFull?'#5CB86A':P.gp,fontSize:'9px',fontWeight:700,flexShrink:0}}>
                  {dpFull ? <Check className="h-3.5 w-3.5" /> : 'DP'}
                </div>
                <div className="flex-1 min-w-0">
                  <p style={{fontFamily:"Inter,sans-serif",fontSize:'13px',color:P.tp,fontWeight:500}}>Downpayment</p>
                  <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>
                    {dpFull ? 'Paid' : dpPartial ? `Partial — ${fmt(dpPaid, currency)} paid` : 'Due on order'}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p style={{fontFamily:"Inter,sans-serif",fontSize:'14px',fontWeight:600,color:dpFull?'#5CB86A':P.gp}}>{fmt(account.downpayment_amount, currency)}</p>
                  {dpPartial && <p style={{fontSize:'10px',color:P.gl}}>Rem: {fmt(account.downpayment_amount - dpPaid, currency)}</p>}
                </div>
              </div>
            );
          })()}
          {account.schedule.map((item) => {
            const isPaid = item.status === 'paid';
            const isOvd = !isPaid && item.due_date < today && item.status !== 'cancelled';
            const effectiveStatus = isOvd ? 'overdue' : item.status;
            const sColor = installmentStatusColor[effectiveStatus] || installmentStatusColor['pending'];
            const sLabel = isOvd ? 'Overdue' : (installmentStatusLabel[item.status] || item.status);
            const dueDate = new Date(item.due_date + 'T00:00:00Z');
            const todayDate = new Date(today + 'T00:00:00Z');
            const diffDays = Math.ceil((dueDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));
            const isDueSoon = !isPaid && !isOvd && diffDays >= 0 && diffDays <= 7 && item.status !== 'cancelled';
            const rowColor = isPaid ? '#5CB86A' : isOvd ? '#E74C3C' : isDueSoon ? P.gl : P.ts;

            return (
              <div key={item.installment_number}
                className="flex items-center gap-3 py-3"
                style={{borderBottom:`1px solid ${P.s2}`}}
              >
                <div style={{width:'28px',height:'28px',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,
                  background: isPaid?'rgba(92,184,106,0.12)' : isOvd?'rgba(231,76,60,0.1)' : isDueSoon?'rgba(232,201,109,0.1)' : P.s2,
                  color: rowColor, fontSize:'11px', fontWeight:700}}>
                  {isPaid ? <Check className="h-3.5 w-3.5" /> : item.installment_number}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p style={{fontFamily:"Inter,sans-serif",fontSize:'13px',color:P.tp,fontWeight:500}}>Month {item.installment_number}</p>
                    <Badge variant="outline" className={`text-[9px] py-0 h-4 ${sColor}`} style={{borderRadius:'2px',letterSpacing:'0.08em'}}>
                      {isDueSoon ? `Due in ${diffDays}d` : sLabel}
                    </Badge>
                  </div>
                  <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{fmtDate(item.due_date)}</p>
                  {item.penalty_amount > 0 && (
                    <Badge variant="outline" className="text-[9px] py-0 h-4 mt-0.5" style={{borderRadius:'2px',color:P.gl,borderColor:`${P.gp}50`,background:'transparent'}}>
                      +{fmt(item.penalty_amount, currency)} penalty
                    </Badge>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p style={{fontFamily:"Inter,sans-serif",fontSize:'14px',fontWeight:600,color:rowColor}}>{fmt(item.base_amount, currency)}</p>
                  {!isPaid && item.paid_amount > 0 && (
                    <p style={{fontSize:'10px',color:P.gl}}>Paid: {fmt(item.paid_amount, currency)}</p>
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
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'12px'}}>Payment History</p>
          <div>
            {account.payments.map((p, idx) => {
              const isDp = (p.reference && String(p.reference).startsWith('DP-')) || (p.remarks && String(p.remarks).toLowerCase() === 'downpayment');
              return (
                <div key={idx} className="flex items-center justify-between py-3" style={{borderBottom:`1px solid ${P.s2}`}}>
                  <div>
                    <div className="flex items-center gap-2">
                      <p style={{fontFamily:"Inter,sans-serif",fontSize:'13px',color:P.tp}}>{fmtDate(p.date)}</p>
                      {isDp && <Badge variant="outline" className="text-[9px] py-0 h-4" style={{borderRadius:'2px',color:P.gp,borderColor:`${P.gp}50`,background:'transparent'}}>Downpayment</Badge>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {p.method && <span style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,textTransform:'capitalize' as const}}>{p.method}</span>}
                      {p.reference && !isDp && <span style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts}}>Ref: {p.reference}</span>}
                    </div>
                  </div>
                  <p style={{fontFamily:"Inter,sans-serif",fontSize:'14px',fontWeight:600,color:'#5CB86A'}}>{fmt(p.amount, account.currency)}</p>
                </div>
              );
            })}
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
      className="inline-flex items-center gap-1 transition-colors"
      style={{fontFamily:"Inter,sans-serif",fontSize:'10px',fontWeight:500,color:copiedField===label?'#5CB86A':P.gp,border:'none',background:'transparent',cursor:'pointer'}}
    >
      {copiedField === label ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copiedField === label ? 'Copied!' : 'Copy'}
    </button>
  );

  return (
    <div style={{background:P.s,border:`1px solid ${P.br}`,borderTop:`2px solid ${P.gp}`,borderRadius:'2px',overflow:'hidden'}}>
      {/* Header */}
      <div className="flex items-center gap-3 p-4">
        <div style={{width:'36px',height:'36px',display:'flex',alignItems:'center',justifyContent:'center',background:`rgba(201,168,76,0.1)`,color:P.gp,flexShrink:0}}>
          {method.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p style={{fontFamily:CG,fontSize:'16px',fontWeight:600,color:P.tp}}>{method.name}</p>
            {method.isFast && (
              <span style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:600,letterSpacing:'0.1em',color:'#5CB86A',border:'1px solid rgba(92,184,106,0.3)',padding:'1px 6px',borderRadius:'2px',display:'inline-flex',alignItems:'center',gap:'3px'}}>
                <Zap className="h-2.5 w-2.5" /> Fast
              </span>
            )}
          </div>
          {method.bankName && <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{method.bankName}</p>}
        </div>
      </div>

      {/* Details */}
      <div style={{padding:'0 1rem 0.75rem',borderTop:`1px solid ${P.br}`}}>
        {[
          method.accountNumber && { lbl:'Account #', val:method.accountNumber, copy:`${method.id}-acct`, mono:true },
          method.accountName   && { lbl:'Name',      val:method.accountName,   copy:`${method.id}-name`, mono:false },
          method.branchName    && { lbl:'Branch',    val:method.branchName },
          method.bankCode      && { lbl:'Bank Code', val:method.bankCode,  mono:true },
          method.branchCode    && { lbl:'Branch Code',val:method.branchCode,mono:true },
          (method.accountType && method.bankName) && { lbl:'Type', val:method.accountType },
          method.payId         && { lbl:'PayPay ID', val:method.payId,    copy:`${method.id}-payid`, mono:true },
          method.location      && { lbl:'Location',  val:method.location },
          method.phone         && { lbl:'Phone',     val:method.phone,    copy:`${method.id}-phone` },
          method.email         && { lbl:'Email',     val:method.email },
          method.recipientAddress && { lbl:'Address', val:method.recipientAddress },
        ].filter(Boolean).map((row: any, i) => (
          <div key={i} className="flex items-center justify-between py-2" style={{borderBottom:`1px solid ${P.s2}`}}>
            <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,flexShrink:0}}>{row.lbl}:</span>
            <span className="flex items-center gap-2 min-w-0 ml-2">
              <span style={{fontFamily:row.mono?'monospace':"Inter,sans-serif",fontSize:'12px',color:P.tp,textAlign:'right',minWidth:0,overflow:'hidden',textOverflow:'ellipsis'}}>{row.val}</span>
              {row.copy && <CopyBtn text={row.val} label={row.copy} />}
            </span>
          </div>
        ))}
        {method.extraNumbers && method.extraNumbers.map((n, i) => (
          <div key={i} className="flex items-center justify-between py-2" style={{borderBottom:`1px solid ${P.s2}`}}>
            <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>{n.label}:</span>
            <span className="flex items-center gap-2">
              <span style={{fontFamily:'monospace',fontSize:'12px',color:P.tp}}>{n.number}</span>
              <CopyBtn text={n.number} label={`${method.id}-num-${i}`} />
            </span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 p-3" style={{borderTop:`1px solid ${P.br}`}}>
        <button
          className="flex-1 flex items-center justify-center gap-1.5 h-9 transition-opacity hover:opacity-80"
          style={{background:'transparent',border:`1px solid ${P.br}`,borderRadius:'2px',color:P.ts,fontFamily:"Inter,sans-serif",fontSize:'11px',letterSpacing:'0.08em',cursor:'pointer'}}
          onClick={(e) => { e.stopPropagation(); copyToClipboard(buildFullDetails(method), `${method.id}-full`, setCopied); }}
        >
          <Copy className="h-3 w-3" />
          {copiedField === `${method.id}-full` ? 'Copied!' : 'Copy All'}
        </button>
        <button
          className="flex-1 flex items-center justify-center gap-1.5 h-9 transition-opacity hover:opacity-90"
          style={{background:P.gr,border:'none',borderRadius:'2px',color:P.bg,fontFamily:"Inter,sans-serif",fontSize:'11px',fontWeight:600,letterSpacing:'0.12em',textTransform:'uppercase' as const,cursor:'pointer'}}
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
        >
          Select &amp; Pay
        </button>
      </div>
    </div>
  );
}

/* ─── Pay Now Tab ─── */
function PayNowTab({ account, allAccounts, paymentMethods: _dbMethods, portalToken, onSuccess, initialPaymentMode = 'single' }: {
  account: PortalAccount;
  allAccounts: PortalAccount[];
  paymentMethods: PaymentMethod[];
  portalToken: string;
  onSuccess: () => void;
  initialPaymentMode?: 'single' | 'split';
}) {
  const currency = account.currency;
  const [step, setStep] = useState<'methods' | 'form' | 'success'>('methods');
  const [selectedMethodName, setSelectedMethodName] = useState<string>('');
  const [selectedChaMethod, setSelectedChaMethod] = useState<ChaPaymentMethod | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Split payment state
  const [paymentMode, setPaymentMode] = useState<'single' | 'split'>(initialPaymentMode);
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

    if (!proofFile) { setFormError('Please upload your proof of payment (screenshot or receipt).'); return; }
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
      <div className="text-center py-10 space-y-5">
        <div style={{width:'56px',height:'56px',margin:'0 auto',display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(92,184,106,0.1)',border:`1px solid rgba(92,184,106,0.3)`}}>
          <CheckCircle style={{color:'#5CB86A'}} className="h-8 w-8" />
        </div>
        <div>
          <h3 style={{fontFamily:CG,fontSize:'22px',color:P.tp,marginBottom:'8px'}}>Payment Submitted</h3>
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'13px',color:P.ts,maxWidth:'260px',margin:'0 auto',lineHeight:1.6}}>
            Your submission is pending verification by the Cha Jewels team.
          </p>
        </div>
        {paymentMode === 'split' && (
          <div style={{background:P.s2,border:`1px solid ${P.br}`,borderLeft:`3px solid ${P.gp}`,padding:'0.75rem 1rem',textAlign:'left',maxWidth:'280px',margin:'0 auto'}}>
            <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',fontWeight:600,letterSpacing:'0.15em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'8px'}}>Split Payment Summary</p>
            {Object.entries(splitAllocations).filter(([, v]) => parseFloat(v) > 0).map(([accId, v]) => {
              const acct = payableAccounts.find(a => a.id === accId);
              return <p key={accId} style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.ts}}>#{acct?.invoice_number}: <span style={{color:P.gp}}>{fmt(parseFloat(v), currency)}</span></p>;
            })}
          </div>
        )}
        <div style={{background:P.s2,border:`1px solid ${P.br}`,padding:'0.75rem 1rem',textAlign:'left',maxWidth:'280px',margin:'0 auto'}}>
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',fontWeight:600,letterSpacing:'0.15em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'6px'}}>What happens next?</p>
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.ts,lineHeight:1.6}}>Our team will review your payment proof and confirm within 1–2 business days.</p>
        </div>
      </div>
    );
  }

  if (step === 'form' && selectedChaMethod) {
    return (
      <div className="space-y-5">
        <button onClick={() => setStep('methods')} className="flex items-center gap-1.5 transition-colors"
          style={{background:'transparent',border:'none',cursor:'pointer',fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,letterSpacing:'0.05em',padding:0}}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back to payment methods
        </button>

        {/* Selected Method Summary */}
        <div style={{background:P.s2,border:`1px solid ${P.br}`,borderLeft:`3px solid ${P.gp}`,padding:'0.875rem 1rem'}}>
          <div className="flex items-center gap-2 mb-2">
            <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts}}>Paying via</p>
            {selectedChaMethod.isFast && (
              <span style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:600,color:'#5CB86A',border:'1px solid rgba(92,184,106,0.3)',padding:'1px 6px',borderRadius:'2px'}}>Fast</span>
            )}
          </div>
          <p style={{fontFamily:CG,fontSize:'17px',fontWeight:600,color:P.tp,marginBottom:'6px'}}>{selectedChaMethod.name}</p>
          {selectedChaMethod.bankName && <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,marginBottom:'4px'}}>{selectedChaMethod.bankName}</p>}
          {selectedChaMethod.accountNumber && (
            <div className="flex items-center gap-2">
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.ts}}>Account #: <span style={{fontFamily:'monospace',color:P.tp,fontWeight:600}}>{selectedChaMethod.accountNumber}</span></p>
              <button onClick={() => copyToClipboard(selectedChaMethod.accountNumber!, `form-acct`, setCopiedField)}
                style={{background:'transparent',border:'none',cursor:'pointer',color:copiedField==='form-acct'?'#5CB86A':P.gp,display:'inline-flex',alignItems:'center'}}>
                {copiedField === 'form-acct' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          )}
          {selectedChaMethod.accountName && <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.ts}}>Name: <span style={{color:P.tp}}>{selectedChaMethod.accountName}</span></p>}
          {selectedChaMethod.extraNumbers && selectedChaMethod.extraNumbers.map((n, i) => (
            <div key={i} className="flex items-center gap-2">
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.ts}}>{n.label}: <span style={{fontFamily:'monospace',color:P.tp}}>{n.number}</span></p>
              <button onClick={() => copyToClipboard(n.number, `form-num-${i}`, setCopiedField)}
                style={{background:'transparent',border:'none',cursor:'pointer',color:copiedField===`form-num-${i}`?'#5CB86A':P.gp,display:'inline-flex',alignItems:'center'}}>
                {copiedField === `form-num-${i}` ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          ))}
          {selectedChaMethod.payId && (
            <div className="flex items-center gap-2">
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.ts}}>PayPay ID: <span style={{fontFamily:'monospace',color:P.tp}}>{selectedChaMethod.payId}</span></p>
              <button onClick={() => copyToClipboard(selectedChaMethod.payId!, `form-payid`, setCopiedField)}
                style={{background:'transparent',border:'none',cursor:'pointer',color:copiedField==='form-payid'?'#5CB86A':P.gp,display:'inline-flex',alignItems:'center'}}>
                {copiedField === 'form-payid' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          )}
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,fontStyle:'italic' as const,marginTop:'8px'}}>After completing your payment, please upload your proof of payment below.</p>
        </div>

        {/* Payment Mode Toggle */}
        {payableAccounts.length > 1 && (
          <div className="flex" style={{borderBottom:`1px solid ${P.br}`}}>
            {(['single','split'] as const).map(m => (
              <button key={m} onClick={() => setPaymentMode(m)}
                style={{flex:1,padding:'8px',fontFamily:"Inter,sans-serif",fontSize:'11px',fontWeight:paymentMode===m?600:400,letterSpacing:'0.1em',textTransform:'uppercase' as const,
                  color:paymentMode===m?P.gp:P.ts,background:'transparent',border:'none',
                  borderBottom:paymentMode===m?`2px solid ${P.gp}`:'2px solid transparent',cursor:'pointer',transition:'all 0.15s'}}>
                {m === 'single' ? 'Single Invoice' : 'Split Across Invoices'}
              </button>
            ))}
          </div>
        )}

        {/* Form */}
        <div className="space-y-4">
          {paymentMode === 'single' ? (
            <div>
              <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Payment Amount <span style={{color:'#E74C3C'}}>*</span></Label>
              <div className="relative mt-1.5">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{color:P.ts}}>{currency === 'JPY' ? '¥' : '₱'}</span>
                <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="pl-8" placeholder="0.00"
                  style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}} />
              </div>
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,marginTop:'4px'}}>
                Amount due: {account.next_due_amount ? fmt(account.next_due_amount, currency) : fmt(account.remaining_balance, currency)}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Total Payment Amount <span style={{color:'#E74C3C'}}>*</span></Label>
                <div className="relative mt-1.5">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{color:P.ts}}>{currency === 'JPY' ? '¥' : '₱'}</span>
                  <Input type="number" step="1" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="pl-8" placeholder="Enter total payment"
                    style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}} />
                </div>
                <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,marginTop:'4px'}}>Enter total then tap Auto Distribute, or allocate manually</p>
              </div>
              <div className="flex items-center justify-between">
                <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Allocate per Invoice <span style={{color:'#E74C3C'}}>*</span></Label>
                <div className="flex gap-1.5">
                  <button type="button" onClick={autoDistribute}
                    style={{fontFamily:"Inter,sans-serif",fontSize:'10px',fontWeight:600,padding:'4px 10px',background:`rgba(201,168,76,0.1)`,border:`1px solid ${P.gp}`,borderRadius:'2px',color:P.gp,cursor:'pointer',letterSpacing:'0.05em'}}>
                    ⚡ Auto Distribute
                  </button>
                  {Object.values(splitAllocations).some(v => parseFloat(v) > 0) && (
                    <button type="button" onClick={resetAllocations}
                      style={{fontFamily:"Inter,sans-serif",fontSize:'10px',padding:'4px 10px',background:'transparent',border:`1px solid ${P.br}`,borderRadius:'2px',color:P.ts,cursor:'pointer'}}>
                      Reset
                    </button>
                  )}
                </div>
              </div>
              {Object.values(splitAllocations).some(v => parseFloat(v) > 0) && (
                <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,fontStyle:'italic' as const}}>Suggested based on due amounts · You can edit manually</p>
              )}
              {sortedPayableAccounts.map((acct) => {
                const duePriority = getAccountDuePriority(acct);
                return (
                  <div key={acct.id} className="flex items-center justify-between p-3" style={{background:P.s2,border:`1px solid ${P.br}`,borderRadius:'2px'}}>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',fontWeight:600,color:P.tp}}>#{acct.invoice_number}</p>
                        {duePriority.label && (
                          <span style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:600,padding:'1px 6px',border:`1px solid ${P.gd}`,color:P.gp,borderRadius:'2px'}}>
                            {duePriority.label}
                          </span>
                        )}
                      </div>
                      <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,marginTop:'2px'}}>
                        Balance: {fmt(acct.remaining_balance, currency)}
                        {duePriority.targetAmount > 0 && duePriority.targetAmount < acct.remaining_balance && (
                          <span className="ml-1">· Due now: {fmt(duePriority.targetAmount, currency)}</span>
                        )}
                      </p>
                    </div>
                    <div className="relative w-28">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs" style={{color:P.ts}}>{currency === 'JPY' ? '¥' : '₱'}</span>
                      <Input type="number" step="0.01" min="0" max={acct.remaining_balance}
                        value={splitAllocations[acct.id] || ''} onChange={(e) => setSplitAllocations(prev => ({ ...prev, [acct.id]: e.target.value }))}
                        className="pl-6 text-right text-xs h-8" placeholder="0"
                        style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}} />
                    </div>
                  </div>
                );
              })}
              {(() => {
                const enteredTotal = parseFloat(amount) || 0;
                const hasMismatch = enteredTotal > 0 && splitTotal > 0 && Math.abs(splitTotal - enteredTotal) > 0.01;
                const isMatch = enteredTotal > 0 && splitTotal > 0 && Math.abs(splitTotal - enteredTotal) <= 0.01;
                const borderCol = hasMismatch ? '#E74C3C' : isMatch ? '#5CB86A' : P.br;
                return (
                  <div className="flex items-center justify-between p-3" style={{background:P.s2,border:`1px solid ${borderCol}`,borderRadius:'2px'}}>
                    <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',fontWeight:600,color:P.tp}}>Allocated</p>
                    <div className="text-right">
                      <p style={{fontFamily:"Inter,sans-serif",fontSize:'14px',fontWeight:700,color:hasMismatch?'#E74C3C':isMatch?'#5CB86A':splitTotal>0?P.gp:P.ts}}>
                        {fmt(splitTotal, currency)}{enteredTotal > 0 ? ` / ${fmt(enteredTotal, currency)}` : ''}
                      </p>
                      {hasMismatch && <p style={{fontSize:'10px',color:'#E74C3C',marginTop:'2px'}}>{splitTotal > enteredTotal ? 'Over' : 'Under'}-allocated by {fmt(Math.abs(splitTotal - enteredTotal), currency)}</p>}
                      {isMatch && <p style={{fontSize:'10px',color:'#5CB86A',marginTop:'2px'}}>✓ Amounts match</p>}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          <div>
            <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Payment Date <span style={{color:'#E74C3C'}}>*</span></Label>
            <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="mt-1.5"
              style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}} />
          </div>

          <div>
            <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Reference / Transaction Number</Label>
            <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} placeholder="e.g. GCash ref #12345" className="mt-1.5"
              style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}} />
          </div>

          <div>
            <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Sender Name (optional)</Label>
            <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Name on the sending account" className="mt-1.5"
              style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp}} />
          </div>

          <div>
            <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>
              Proof of Payment <span style={{color:'#E74C3C'}}>*</span>
            </Label>
            <div className="mt-1.5">
              <input ref={fileInputRef} type="file" accept="image/*,.pdf" onChange={handleFileChange} className="hidden" />
              {proofPreview ? (
                <div className="relative">
                  <img src={proofPreview} alt="Proof" className="w-full h-40 object-cover" style={{border:`2px solid ${P.gp}`,borderRadius:'2px'}} />
                  <button onClick={() => { setProofFile(null); setProofPreview(null); }}
                    className="absolute top-2 right-2 h-6 w-6 flex items-center justify-center" style={{background:'rgba(10,10,10,0.7)',color:P.tp,border:'none',cursor:'pointer'}}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : proofFile ? (
                <div className="flex items-center gap-2 p-3" style={{border:`2px solid ${P.gp}`,background:P.s2,borderRadius:'2px'}}>
                  <FileText className="h-4 w-4" style={{color:P.gp}} />
                  <span style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.tp}} className="truncate flex-1">{proofFile.name}</span>
                  <button onClick={() => { setProofFile(null); setProofPreview(null); }} style={{background:'transparent',border:'none',cursor:'pointer',color:P.ts}}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button onClick={() => fileInputRef.current?.click()}
                  className="w-full p-6 flex flex-col items-center gap-2 transition-all"
                  style={{background:`rgba(201,168,76,0.04)`,border:`2px dashed ${P.gp}`,borderRadius:'2px',cursor:'pointer'}}>
                  <Upload className="h-7 w-7" style={{color:P.gp}} />
                  <span style={{fontFamily:"Inter,sans-serif",fontSize:'13px',fontWeight:600,color:P.gp}}>Upload Proof of Payment</span>
                  <span style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts}}>Required · JPG, PNG, or PDF · Max 10MB</span>
                </button>
              )}
            </div>
          </div>

          <div>
            <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional details…" className="mt-1.5" rows={2}
              style={{background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp,resize:'none' as const}} />
          </div>

          {formError && (
            <div className="p-3" style={{background:'rgba(231,76,60,0.07)',borderLeft:'3px solid #E74C3C'}}>
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:'#E74C3C'}}>{formError}</p>
            </div>
          )}

          <button
            className="w-full flex items-center justify-center gap-2 h-12 transition-opacity"
            style={{background:(submitting||!proofFile)?P.s2:P.gr,border:'none',borderRadius:'2px',color:(submitting||!proofFile)?P.ts:P.bg,fontFamily:"Inter,sans-serif",fontSize:'12px',fontWeight:700,letterSpacing:'0.15em',textTransform:'uppercase' as const,cursor:(submitting||!proofFile)?'not-allowed':'pointer',opacity:(submitting||!proofFile)?0.5:1}}
            onClick={handleSubmit}
            disabled={submitting || !proofFile}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? 'Submitting…' : paymentMode === 'split' ? `Submit Split Payment (${fmt(splitTotal, currency)})` : 'Submit Payment'}
          </button>
        </div>
      </div>
    );
  }

  // Payment Methods list (grouped)
  return (
    <div className="space-y-5">
      {/* Amount Due Summary */}
      <div className="text-center py-4" style={{borderBottom:`1px solid ${P.br}`}}>
        <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'6px'}}>Amount Due Now</p>
        <p style={{fontFamily:CG,fontSize:'28px',fontWeight:700,color:P.gp,lineHeight:1}}>
          {account.next_due_amount ? fmt(account.next_due_amount, currency) : fmt(account.remaining_balance, currency)}
        </p>
        {account.next_due_date && (
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts,marginTop:'4px'}}>Due {fmtDateLong(account.next_due_date)}</p>
        )}
      </div>

      {/* Primary Group */}
      <div>
        <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'12px'}}>
          {relevantGroup === 'PH' ? '🇵🇭 Philippines — Peso Payments' : '🇯🇵 Japan — JPY Payments'}
        </p>
        <div className="space-y-3">
          {primaryMethods.map((method) => (
            <PaymentMethodCard key={method.id} method={method} onSelect={() => handleSelectMethod(method)} copiedField={copiedField} setCopied={setCopiedField} />
          ))}
        </div>
      </div>

      {/* Other Group */}
      {otherMethods.length > 0 && (
        <div>
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'12px'}}>
            {relevantGroup === 'PH' ? '🇯🇵 Japan — JPY Payments' : '🇵🇭 Philippines — Peso Payments'}
          </p>
          <div className="space-y-3">
            {otherMethods.map((method) => (
              <PaymentMethodCard key={method.id} method={method} onSelect={() => handleSelectMethod(method)} copiedField={copiedField} setCopied={setCopiedField} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Submissions Tab ─── */
function SubmissionsTab({ submissions, currency, portalToken, onRefresh }: {
  submissions: Submission[];
  currency: string;
  portalToken: string;
  onRefresh: () => void;
}) {
  const relevantGroup = currency === 'JPY' ? 'JP' : 'PH';
  const availableMethods = CHA_PAYMENT_METHODS.filter(m => m.group === relevantGroup);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editMethod, setEditMethod] = useState('');
  const [editRef, setEditRef] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editProofFile, setEditProofFile] = useState<File | null>(null);
  const [editProofPreview, setEditProofPreview] = useState<string | null>(null);
  const [editProofCurrent, setEditProofCurrent] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const editFileRef = useRef<HTMLInputElement>(null);

  const startEdit = (sub: Submission) => {
    setEditingId(sub.id);
    setEditAmount(String(sub.submitted_amount));
    setEditMethod(sub.payment_method);
    setEditRef(sub.reference_number || '');
    setEditNotes(sub.notes || '');
    setEditProofFile(null);
    setEditProofPreview(null);
    setEditProofCurrent(sub.proof_url);
    setEditError(null);
  };

  const handleEditProofChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setEditError('File must be less than 10MB'); return; }
    setEditProofFile(file);
    setEditError(null);
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => setEditProofPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setEditProofPreview(null);
    }
  };

  const handleEditSave = async (sub: Submission) => {
    const parsedAmount = parseFloat(editAmount);
    if (!parsedAmount || parsedAmount <= 0) { setEditError('Please enter a valid amount.'); return; }

    setEditSubmitting(true);
    setEditError(null);
    try {
      let proofUrl: string | undefined = undefined;
      if (editProofFile) {
        const ext = editProofFile.name.split('.').pop() || 'jpg';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filePath = `${sub.account_id}/${timestamp}_${editProofFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;
        const uploadRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/payment-proofs/${filePath}`,
          {
            method: 'POST',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': editProofFile.type },
            body: editProofFile,
          }
        );
        if (uploadRes.ok) {
          proofUrl = `${SUPABASE_URL}/storage/v1/object/public/payment-proofs/${filePath}`;
        }
      }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/edit-payment-submission`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portal_token: portalToken,
          submission_id: sub.id,
          action: 'edit',
          submitted_amount: parsedAmount,
          payment_method: editMethod,
          reference_number: editRef || null,
          notes: editNotes || null,
          ...(proofUrl !== undefined ? { proof_url: proofUrl } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) { setEditError(json.error || 'Edit failed. Please try again.'); return; }

      setEditingId(null);
      onRefresh();
    } catch {
      setEditError('Something went wrong. Please try again.');
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleCancelSubmission = async (sub: Submission) => {
    setCancellingId(sub.id);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/edit-payment-submission`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ portal_token: portalToken, submission_id: sub.id, action: 'cancel' }),
      });
      const json = await res.json();
      if (!res.ok) { alert(json.error || 'Could not cancel. Please try again.'); return; }
      onRefresh();
    } catch {
      alert('Something went wrong. Please try again.');
    } finally {
      setCancellingId(null);
    }
  };

  if (submissions.length === 0) {
    return (
      <div className="text-center py-12">
        <Send className="h-10 w-10 mx-auto mb-3" style={{color:P.gd}} />
        <p style={{fontFamily:CG,fontSize:'18px',color:P.tp,marginBottom:'6px'}}>No Submissions Yet</p>
        <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.ts}}>Use the Pay Now tab to submit your first payment.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.2em',textTransform:'uppercase' as const,color:P.ts}}>Payment Submissions</p>
      {submissions.map((sub) => {
        const cfg = submissionStatusConfig[sub.status] || submissionStatusConfig.submitted;
        const isEditable = sub.status === 'submitted';
        const isEditingThis = editingId === sub.id;
        const isCancellingThis = cancellingId === sub.id;
        return (
          <div key={sub.id} style={{background:P.s,border:`1px solid ${P.br}`,borderTop:`2px solid ${P.gp}`,borderRadius:'2px',padding:'1rem'}} className="space-y-2.5">
            <div className="flex items-start justify-between">
              <div>
                <p style={{fontFamily:"Inter,sans-serif",fontSize:'16px',fontWeight:700,color:P.gp}}>{fmt(sub.submitted_amount, currency)}</p>
                <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,marginTop:'2px'}}>{fmtDateTime(sub.created_at)}</p>
              </div>
              <Badge variant="outline" className={`text-[9px] gap-1 ${cfg.color}`} style={{borderRadius:'2px',letterSpacing:'0.08em'}}>
                {cfg.icon} {cfg.label}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1" style={{borderTop:`1px solid ${P.s2}`,paddingTop:'8px'}}>
              <div>
                <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>Method: </span>
                <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.tp}}>{sub.payment_method}</span>
              </div>
              <div>
                <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>Date: </span>
                <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.tp}}>{fmtDate(sub.payment_date)}</span>
              </div>
              {sub.reference_number && (
                <div className="col-span-2">
                  <span style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.ts}}>Ref: </span>
                  <span style={{fontFamily:'monospace',fontSize:'11px',color:P.tp}}>{sub.reference_number}</span>
                </div>
              )}
            </div>

            {sub.proof_url && (
              <a href={sub.proof_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 hover:underline"
                style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.gp}}>
                <ImageIcon className="h-3 w-3" /> View proof of payment
              </a>
            )}

            {sub.customer_edited_at && (
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,fontStyle:'italic'}}>
                Edited {fmtDateTime(sub.customer_edited_at)}
              </p>
            )}

            {sub.reviewer_notes && (
              <div style={{padding:'8px 10px',background:P.s2,borderLeft:`3px solid ${sub.status==='rejected'?'#E74C3C':P.gp}`}}>
                <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',fontWeight:600,color:P.ts,marginBottom:'4px',letterSpacing:'0.1em',textTransform:'uppercase' as const}}>Message from Cha Jewels:</p>
                <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:P.tp}}>{sub.reviewer_notes}</p>
              </div>
            )}

            {/* Edit / Cancel buttons — only for 'submitted' status */}
            {isEditable && !isEditingThis && (
              <div className="flex gap-2" style={{paddingTop:'4px'}}>
                <button
                  onClick={() => startEdit(sub)}
                  style={{flex:1,padding:'7px 0',background:'transparent',border:`1px solid ${P.gp}`,borderRadius:'2px',color:P.gp,fontFamily:"Inter,sans-serif",fontSize:'11px',letterSpacing:'0.08em',textTransform:'uppercase' as const,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:'5px'}}>
                  <Pencil className="h-3 w-3" /> Edit
                </button>
                <button
                  onClick={() => handleCancelSubmission(sub)}
                  disabled={isCancellingThis}
                  style={{flex:1,padding:'7px 0',background:'transparent',border:`1px solid #E74C3C`,borderRadius:'2px',color:'#E74C3C',fontFamily:"Inter,sans-serif",fontSize:'11px',letterSpacing:'0.08em',textTransform:'uppercase' as const,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:'5px',opacity:isCancellingThis?0.6:1}}>
                  {isCancellingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                  {isCancellingThis ? 'Cancelling…' : 'Cancel Submission'}
                </button>
              </div>
            )}

            {/* Inline Edit Form */}
            {isEditingThis && (
              <div style={{background:P.s2,border:`1px solid ${P.br}`,borderRadius:'2px',padding:'12px',marginTop:'4px'}} className="space-y-3">
                <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',fontWeight:600,letterSpacing:'0.15em',textTransform:'uppercase' as const,color:P.ts}}>Edit Submission</p>

                {/* Amount */}
                <div>
                  <label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,display:'block',marginBottom:'4px'}}>Amount</label>
                  <input
                    type="number"
                    value={editAmount}
                    onChange={e => setEditAmount(e.target.value)}
                    style={{width:'100%',padding:'7px 10px',background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp,fontFamily:"Inter,sans-serif",fontSize:'13px',outline:'none',boxSizing:'border-box' as const}}
                  />
                </div>

                {/* Payment Method */}
                <div>
                  <label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,display:'block',marginBottom:'4px'}}>Payment Method</label>
                  <select
                    value={editMethod}
                    onChange={e => setEditMethod(e.target.value)}
                    style={{width:'100%',padding:'7px 10px',background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp,fontFamily:"Inter,sans-serif",fontSize:'13px',outline:'none',boxSizing:'border-box' as const}}>
                    {availableMethods.map(m => (
                      <option key={m.id} value={m.name}>{m.name}</option>
                    ))}
                    {/* Keep current if not in list */}
                    {!availableMethods.find(m => m.name === editMethod) && (
                      <option value={editMethod}>{editMethod}</option>
                    )}
                  </select>
                </div>

                {/* Reference Number */}
                <div>
                  <label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,display:'block',marginBottom:'4px'}}>Reference Number (optional)</label>
                  <input
                    type="text"
                    value={editRef}
                    onChange={e => setEditRef(e.target.value)}
                    placeholder="Transaction / GCash ref"
                    style={{width:'100%',padding:'7px 10px',background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp,fontFamily:"Inter,sans-serif",fontSize:'13px',outline:'none',boxSizing:'border-box' as const}}
                  />
                </div>

                {/* Notes */}
                <div>
                  <label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,display:'block',marginBottom:'4px'}}>Notes (optional)</label>
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    rows={2}
                    style={{width:'100%',padding:'7px 10px',background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp,fontFamily:"Inter,sans-serif",fontSize:'13px',outline:'none',resize:'none',boxSizing:'border-box' as const}}
                  />
                </div>

                {/* Proof Upload */}
                <div>
                  <label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,display:'block',marginBottom:'4px'}}>Proof of Payment</label>
                  {editProofCurrent && !editProofFile && (
                    <a href={editProofCurrent} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1.5 hover:underline mb-2"
                      style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:P.gp}}>
                      <ImageIcon className="h-3 w-3" /> Current proof (tap to view) — or upload new below
                    </a>
                  )}
                  {editProofPreview && (
                    <img src={editProofPreview} alt="New proof preview" style={{width:'100%',maxHeight:'120px',objectFit:'cover',borderRadius:'2px',marginBottom:'6px'}} />
                  )}
                  <input ref={editFileRef} type="file" accept="image/*,.pdf" style={{display:'none'}} onChange={handleEditProofChange} />
                  <button
                    onClick={() => editFileRef.current?.click()}
                    style={{width:'100%',padding:'8px',background:'transparent',border:`1px dashed ${P.br}`,borderRadius:'2px',color:P.ts,fontFamily:"Inter,sans-serif",fontSize:'11px',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:'5px'}}>
                    <Upload className="h-3 w-3" /> {editProofFile ? editProofFile.name : 'Upload new proof (optional)'}
                  </button>
                </div>

                {editError && (
                  <p style={{fontFamily:"Inter,sans-serif",fontSize:'11px',color:'#E74C3C'}}>{editError}</p>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => handleEditSave(sub)}
                    disabled={editSubmitting}
                    style={{flex:1,padding:'8px 0',background:P.gp,border:'none',borderRadius:'2px',color:'#fff',fontFamily:"Inter,sans-serif",fontSize:'11px',letterSpacing:'0.08em',textTransform:'uppercase' as const,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:'5px',opacity:editSubmitting?0.7:1}}>
                    {editSubmitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    {editSubmitting ? 'Saving…' : 'Save Changes'}
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    disabled={editSubmitting}
                    style={{padding:'8px 16px',background:'transparent',border:`1px solid ${P.br}`,borderRadius:'2px',color:P.ts,fontFamily:"Inter,sans-serif",fontSize:'11px',cursor:'pointer'}}>
                    Discard
                  </button>
                </div>
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
      <p style={{fontFamily:"Inter,sans-serif",fontSize:'9px',fontWeight:500,letterSpacing:'0.18em',textTransform:'uppercase' as const,color:P.ts,marginBottom:'3px'}}>{label}</p>
      <p style={{fontFamily:"Inter,sans-serif",fontSize:'13px',fontWeight:500,color:highlight?'#E74C3C':P.tp}}>{value}</p>
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

  const inputStyle = {background:P.s,border:`1px solid ${P.br}`,borderRadius:'2px',color:P.tp};

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p style={{fontFamily:CG,fontSize:'22px',fontWeight:600,color:P.tp}}>My Profile</p>
        {!editing && (
          <button onClick={() => { resetForm(); setEditing(true); setSuccessMsg(false); }}
            className="flex items-center gap-1.5 px-3 h-8 transition-opacity hover:opacity-80"
            style={{background:'transparent',border:`1px solid ${P.gp}`,borderRadius:'2px',color:P.gp,fontFamily:"Inter,sans-serif",fontSize:'11px',letterSpacing:'0.1em',textTransform:'uppercase' as const,cursor:'pointer'}}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}
      </div>

      {successMsg && (
        <div className="flex items-center gap-2 p-3" style={{background:'rgba(92,184,106,0.07)',borderLeft:'3px solid #5CB86A'}}>
          <CheckCircle className="h-4 w-4 shrink-0" style={{color:'#5CB86A'}} />
          <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:'#5CB86A'}}>Your profile has been updated successfully.</p>
        </div>
      )}

      {!editing ? (
        <div style={{background:P.s,border:`1px solid ${P.br}`,borderTop:`2px solid ${P.gp}`,borderRadius:'2px',padding:'1.25rem'}}>
          {[
            ['Full Name', profile.full_name],
            ['Location', locationLabel],
            ['Facebook Name', profile.facebook_name],
            ['Messenger Link', profile.messenger_link],
            ['Mobile Number', profile.mobile_number],
            ['Email', profile.email],
            ['Notes', profile.notes],
          ].map(([lbl, val]) => (
            <div key={lbl} className="py-2.5 flex gap-4" style={{borderBottom:`1px solid ${P.s2}`}}>
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',fontWeight:500,letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts,width:'100px',flexShrink:0,paddingTop:'1px'}}>{lbl}</p>
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'13px',color:val?P.tp:P.ts,fontStyle:val?'normal':'italic' as const}}>{val || 'Not set'}</p>
            </div>
          ))}
        </div>
      ) : (
        <div style={{background:P.s,border:`1px solid ${P.br}`,borderTop:`2px solid ${P.gp}`,borderRadius:'2px',padding:'1.25rem'}} className="space-y-4">
          <div className="space-y-1.5">
            <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Full Name <span style={{color:'#E74C3C'}}>*</span></Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} style={inputStyle} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Location</Label>
              <Select value={locationType} onValueChange={handleLocationChange}>
                <SelectTrigger style={inputStyle}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="japan">Japan</SelectItem>
                  <SelectItem value="philippines">Philippines</SelectItem>
                  <SelectItem value="international">International</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {locationType === 'international' && (
              <div className="space-y-1.5">
                <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Country <span style={{color:'#E74C3C'}}>*</span></Label>
                <CountrySelect value={country} onValueChange={setCountry} />
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Facebook Name</Label>
              <Input value={facebookName} onChange={(e) => setFacebookName(e.target.value)} style={inputStyle} />
            </div>
            <div className="space-y-1.5">
              <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Messenger Link</Label>
              <Input value={messengerLink} onChange={(e) => setMessengerLink(e.target.value)} placeholder="m.me/username" style={inputStyle} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Mobile Number</Label>
              <Input value={mobileNumber} onChange={(e) => setMobileNumber(e.target.value)} placeholder="+63 or +81" style={inputStyle} />
            </div>
            <div className="space-y-1.5">
              <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label style={{fontFamily:"Inter,sans-serif",fontSize:'10px',letterSpacing:'0.12em',textTransform:'uppercase' as const,color:P.ts}}>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Any notes for Cha Jewels…"
              style={{...inputStyle, resize:'none' as const}} />
          </div>

          {formError && (
            <div className="p-3" style={{background:'rgba(231,76,60,0.07)',borderLeft:'3px solid #E74C3C'}}>
              <p style={{fontFamily:"Inter,sans-serif",fontSize:'12px',color:'#E74C3C'}}>{formError}</p>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setEditing(false)} disabled={saving}
              style={{padding:'8px 16px',background:'transparent',border:`1px solid ${P.br}`,borderRadius:'2px',color:P.ts,fontFamily:"Inter,sans-serif",fontSize:'12px',cursor:'pointer'}}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5"
              style={{padding:'8px 16px',background:saving?P.s2:P.gr,border:'none',borderRadius:'2px',color:saving?P.ts:P.bg,fontFamily:"Inter,sans-serif",fontSize:'12px',fontWeight:600,letterSpacing:'0.1em',cursor:saving?'not-allowed':'pointer'}}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-4">
      <p style={{fontFamily:"Inter,sans-serif",fontSize:'10px',color:P.ts,width:'120px',flexShrink:0}}>{label}</p>
      <p style={{fontFamily:"Inter,sans-serif",fontSize:'13px',color:value?P.tp:P.ts,fontStyle:value?'normal':'italic' as const}}>{value || 'Not set'}</p>
    </div>
  );
}
