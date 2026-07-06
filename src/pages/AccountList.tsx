import { memo, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ROUTES } from '@/constants/routes';
import { Plus, Search, Eye, MessageCircle, FileText, ChevronRight, ChevronDown, Download, Copy } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';

const EmbeddedWrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { useAccounts } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';
import AccountSearchBar from '@/components/search/AccountSearchBar';
import { getPHTToday } from '@/lib/date-utils';
import { transition, rowDelay } from '@/theme/motion';
import SortMenu, { sortRows, type SortState } from '@/components/list-kit/SortMenu';
import DensityToggle, { useDensity } from '@/components/list-kit/DensityToggle';
import HighlightText from '@/components/list-kit/HighlightText';
import BulkActionBar from '@/components/list-kit/BulkActionBar';
import VirtualCardGrid from '@/components/list-kit/VirtualCardGrid';
import { useListKeyboardNav } from '@/components/list-kit/useListKeyboardNav';
import AccountQuickView, { type QuickViewAccount } from '@/components/accounts/AccountQuickView';
import { toast } from '@/components/ui/use-toast';

const statusStyles: Record<string, string> = {
  active: 'bg-success/10 text-success border-success/20',
  completed: 'bg-primary/10 text-primary border-primary/20',
  overdue: 'bg-destructive/10 text-destructive border-destructive/20',
  grace_period: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  cancelled: 'bg-muted text-muted-foreground border-border',
  forfeited: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  extension_active: 'bg-info/10 text-info border-info/20',
  final_forfeited: 'bg-destructive/10 text-destructive border-destructive/20',
  final_settlement: 'bg-warning/10 text-warning border-warning/20',
  reactivated: 'bg-info/10 text-info border-info/20',
};

const statusLabel: Record<string, string> = {
  active: 'Active',
  completed: 'Completed',
  overdue: 'Overdue',
  grace_period: 'Grace Period',
  cancelled: 'Cancelled',
  forfeited: 'Forfeited',
  extension_active: 'Extension',
  final_forfeited: 'Perm. Forfeited',
  final_settlement: 'Settlement',
  reactivated: 'Reactivated',
};

// Fixed presentation order for tabs + folders. Every real account_status is
// covered; any unexpected status is appended after these (never dropped).
const STATUS_ORDER = ['active', 'overdue', 'extension_active', 'reactivated', 'completed', 'final_settlement', 'forfeited', 'final_forfeited', 'cancelled'];

const statusDot: Record<string, string> = {
  active: 'bg-success',
  overdue: 'bg-destructive',
  extension_active: 'bg-info',
  reactivated: 'bg-info',
  completed: 'bg-primary',
  final_settlement: 'bg-warning',
  forfeited: 'bg-orange-500',
  final_forfeited: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
};

// Test-account predicate: the DB trigger (enforce_test_invoice_prefix)
// guarantees every test account's invoice is TEST--prefixed, so the prefix
// check is the canonical client-side filter (same as CashOrdersList).
const isTestInvoice = (inv: string | null | undefined) => (inv || '').startsWith('TEST-');

const FOLDER_CARD_CAP = 24;
// Revealed folders larger than this render through VirtualCardGrid
// (render-layer only — data fetching is unchanged).
const VIRTUAL_THRESHOLD = 60;

// Folder-level sort accessors (applied to a copy — never mutates query data).
const SORT_OPTIONS = [
  { key: 'balance', label: 'Balance' },
  { key: 'total', label: 'Total amount' },
  { key: 'customer', label: 'Customer' },
  { key: 'invoice', label: 'Invoice #' },
  { key: 'order_date', label: 'Start date' },
];

interface AccountListProps {
  embedded?: boolean;
  searchValue?: string;
  exportRef?: React.MutableRefObject<(() => void) | null>;
}

const AccountList = memo(function AccountList({ embedded = false, searchValue, exportRef }: AccountListProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchRef = useRef('');
  const [filterTick, setFilterTick] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const handleSearch = useCallback((v: string) => {
    searchRef.current = v;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setFilterTick(t => t + 1), 300);
  }, []);

  // External search from a parent toolbar (Sales page). When undefined,
  // this child manages its own search via AccountSearchBar.
  useEffect(() => {
    if (searchValue !== undefined) {
      searchRef.current = searchValue;
      setFilterTick(t => t + 1);
    }
  }, [searchValue]);

  const [filterCurrency, setFilterCurrency] = useState<Currency | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<string>(searchParams.get('status') || 'all');
  const [filterPeriod, setFilterPeriod] = useState<string>(searchParams.get('period') || '');
  const [hideTest, setHideTest] = useState(true);
  // Per-folder open/close override (empty => use default open logic) and the
  // per-folder "show all" reveal beyond the FOLDER_CARD_CAP.
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const [shownAll, setShownAll] = useState<Record<string, boolean>>({});
  // List-kit state: folder sort, card density, bulk selection, quick-view.
  const [sort, setSort] = useState<SortState | null>(null);
  const [density, setDensity] = useDensity('cj-account-list-density');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [quickView, setQuickView] = useState<QuickViewAccount | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  useListKeyboardNav(listContainerRef);
  const navigate = useNavigate();
  const { data: accounts, isLoading } = useAccounts();

  useEffect(() => {
    const s = searchParams.get('status');
    if (s && (s === 'all' || STATUS_ORDER.includes(s))) setFilterStatus(s);
    setFilterPeriod(searchParams.get('period') || '');
  }, [searchParams]);

  // Reapply default folder open state (and reset reveals + bulk selection)
  // on any filter change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOpenState({}); setShownAll({}); setSelectedIds(new Set()); }, [filterTick, filterCurrency, filterStatus, filterPeriod, hideTest]);

  const selectTab = (s: string) => {
    setFilterStatus(s);
    if (s === 'all') searchParams.delete('status');
    else searchParams.set('status', s);
    setSearchParams(searchParams, { replace: true });
  };

  // Accounts after search + currency + test filtering ONLY (no status/period).
  // Basis for tab counts, grouped by status.
  const preStatusFiltered = useMemo(() => (accounts || []).filter(a => {
    const matchesSearch = !searchRef.current || a.invoice_number.includes(searchRef.current) ||
      (a.customers?.full_name || '').toLowerCase().includes(searchRef.current.toLowerCase());
    const matchesCurrency = filterCurrency === 'all' || a.currency === filterCurrency;
    const matchesTest = !hideTest || !isTestInvoice(a.invoice_number);
    return matchesSearch && matchesCurrency && matchesTest;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [accounts, filterTick, filterCurrency, hideTest]);

  const filtered = useMemo(() => (accounts || []).filter(a => {
    const matchesSearch = !searchRef.current || a.invoice_number.includes(searchRef.current) ||
      (a.customers?.full_name || '').toLowerCase().includes(searchRef.current.toLowerCase());
    const matchesCurrency = filterCurrency === 'all' || a.currency === filterCurrency;
    const todayStr = getPHTToday();
    const matchesStatus = filterStatus === 'all'
      ? true
      : filterStatus === 'forfeited' && filterPeriod === 'today'
        ? (a.status === 'forfeited' || a.status === 'final_forfeited') &&
          (a.updated_at || '').startsWith(todayStr)
        : a.status === filterStatus;
    const matchesTest = !hideTest || !isTestInvoice(a.invoice_number);
    return matchesSearch && matchesCurrency && matchesStatus && matchesTest;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [accounts, filterTick, filterCurrency, filterStatus, filterPeriod, hideTest]);

  // Tab counts (status grouping of preStatusFiltered) + ordered tab list.
  const { tabs, tabCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of preStatusFiltered) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    const ordered = [
      ...STATUS_ORDER.filter(s => (counts.get(s) ?? 0) > 0),
      ...[...counts.keys()].filter(s => !STATUS_ORDER.includes(s)),
    ];
    return { tabs: ['all', ...ordered], tabCounts: counts };
  }, [preStatusFiltered]);

  // Folder grouping of the already-filtered list.
  const folderMap = useMemo(() => {
    const m = new Map<string, typeof filtered>();
    for (const a of filtered) {
      const arr = m.get(a.status) || [];
      arr.push(a);
      m.set(a.status, arr);
    }
    return m;
  }, [filtered]);

  const presentStatuses = useMemo(() => [
    ...STATUS_ORDER.filter(s => (folderMap.get(s)?.length ?? 0) > 0),
    ...[...folderMap.keys()].filter(s => !STATUS_ORDER.includes(s)),
  ], [folderMap]);

  // Default: "All" opens the first two present folders (Active, Overdue);
  // a single-status tab opens every present folder.
  const defaultOpenSet = useMemo(
    () => new Set(filterStatus === 'all' ? presentStatuses.slice(0, 2) : presentStatuses),
    [filterStatus, presentStatuses],
  );

  const expandAll = () => setOpenState(Object.fromEntries(presentStatuses.map(s => [s, true])));
  const collapseAll = () => setOpenState(Object.fromEntries(presentStatuses.map(s => [s, false])));

  // CSV builder shared by the full export (exportRef, Sales toolbar) and the
  // bulk-selection export — same columns either way.
  const downloadCsv = useCallback((list: typeof filtered) => {
    const rows = list.map(a => ({
      'Invoice #': a.invoice_number ?? '',
      'Customer': a.customers?.full_name ?? '',
      'Status': a.status ?? '',
      'Currency': a.currency ?? '',
      'Total': a.total_amount ?? 0,
      'Paid': a.total_paid ?? 0,
      'Balance': a.remaining_balance ?? 0,
      'Plan Months': a.payment_plan_months ?? '',
      'Start Date': a.order_date ?? '',
    }));
    const headers = Object.keys(rows[0] ?? {});
    const csv = [
      headers.join(','),
      ...rows.map(r =>
        headers.map(h => JSON.stringify((r as Record<string, unknown>)[h] ?? '')).join(',')
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `layaway-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // CSV export of the currently-filtered layaway accounts. Exposed via
  // exportRef so a parent (Sales workspace toolbar) can trigger download.
  const handleExport = useCallback(() => downloadCsv(filtered), [downloadCsv, filtered]);

  // Bulk-selection actions — client-side only (no edge-function actions here).
  const selectedAccounts = useMemo(
    () => filtered.filter(a => selectedIds.has(a.id)),
    [filtered, selectedIds],
  );
  const handleExportSelected = useCallback(() => downloadCsv(selectedAccounts), [downloadCsv, selectedAccounts]);
  const handleCopySelected = useCallback(() => {
    const text = selectedAccounts
      .map(a => `#${a.invoice_number} — ${a.customers?.full_name ?? 'Unknown'} — ${formatCurrency(Number(a.remaining_balance), a.currency as Currency)} balance (${statusLabel[a.status] || a.status})`)
      .join('\n');
    navigator.clipboard.writeText(text).then(
      () => toast({ description: `${selectedAccounts.length} account summar${selectedAccounts.length === 1 ? 'y' : 'ies'} copied.` }),
      () => toast({ description: 'Copy failed — your browser blocked clipboard access.', variant: 'destructive' }),
    );
  }, [selectedAccounts]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Folder-level sort — applied per folder on a copy; default keeps the
  // query's created_at DESC ordering.
  const sortAccessors = useMemo(() => ({
    balance: (a: typeof filtered[number]) => Number(a.remaining_balance),
    total: (a: typeof filtered[number]) => Number(a.total_amount),
    customer: (a: typeof filtered[number]) => a.customers?.full_name ?? '',
    invoice: (a: typeof filtered[number]) => a.invoice_number ?? '',
    order_date: (a: typeof filtered[number]) => a.order_date ?? '',
  }), []);

  useEffect(() => {
    if (exportRef) exportRef.current = handleExport;
    return () => {
      if (exportRef) exportRef.current = null;
    };
  }, [exportRef, handleExport]);

  const searchQuery = searchRef.current;
  const compact = density === 'compact';

  const renderAccountCard = (account: typeof filtered[number]) => {
    const currency = account.currency as Currency;
    const totalAmount = Number(account.total_amount);
    const totalPaid = Number(account.total_paid);
    const remaining = Number(account.remaining_balance);
    const progress = totalAmount > 0 ? Math.round((totalPaid / totalAmount) * 100) : 0;
    const isSelected = selectedIds.has(account.id);

    return (
      <div
        key={account.id}
        data-nav-card
        role="button"
        tabIndex={0}
        aria-label={`Account ${account.invoice_number}, ${account.customers?.full_name || 'Unknown'}. Press Enter for quick view.`}
        className={`rounded-xl border bg-card card-hover cursor-pointer group ${compact ? 'p-3' : 'p-4 sm:p-5'} ${isSelected ? 'border-gold-500/60 bg-gold-500/5' : 'border-border'}`}
        onClick={() => navigate(`/accounts/${account.id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            if ((e.target as HTMLElement).closest('button, a, [role="checkbox"]')) return;
            e.preventDefault();
            setQuickView(account as QuickViewAccount);
          }
        }}
      >
        {/* Top row: select + invoice + status */}
        <div className={`flex items-start justify-between ${compact ? 'mb-2' : 'mb-3'}`}>
          <div className="flex items-start gap-2 min-w-0">
            <span onClick={(e) => e.stopPropagation()} className="pt-0.5">
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleSelected(account.id)}
                aria-label={`Select account ${account.invoice_number}`}
                className="h-4 w-4"
              />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-card-foreground font-display truncate">
                #<HighlightText text={account.invoice_number} query={searchQuery} />
              </p>
              <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[180px]">
                <HighlightText text={account.customers?.full_name || 'Unknown'} query={searchQuery} />
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className={`text-[10px] shrink-0 ${statusStyles[account.status] || ''}`}>
              {statusLabel[account.status] || account.status}
            </Badge>
            {isTestInvoice(account.invoice_number) && (
              <Badge variant="outline" className="text-[10px] shrink-0 bg-info/10 text-info border-info/20 font-bold">
                🧪 TEST
              </Badge>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className={compact ? 'mb-2' : 'mb-3'}>
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
            <span>{progress}% paid</span>
            <span>{account.payment_plan_months}mo plan</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full gold-gradient rounded-full transition-all duration-500"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
        </div>

        {/* Amounts */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[10px] text-muted-foreground">Total</p>
            <p className="text-xs font-semibold text-card-foreground tabular-nums">
              {formatCurrency(totalAmount, currency)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">Paid</p>
            <p className="text-xs font-semibold text-success tabular-nums">
              {formatCurrency(totalPaid, currency)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">Balance</p>
            <p className="text-xs font-bold text-card-foreground tabular-nums">
              {formatCurrency(remaining, currency)}
            </p>
          </div>
        </div>

        {/* Footer actions */}
        <div className={`flex items-center justify-between border-t border-border ${compact ? 'mt-2 pt-2' : 'mt-3 pt-3'}`}>
          <span className="text-[10px] text-muted-foreground">{currency}</span>
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-gold-300"
              onClick={() => setQuickView(account as QuickViewAccount)}
              aria-label={`Quick view of account ${account.invoice_number}`}
              title="Quick view"
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
            {account.customers?.messenger_link && (
              <a href={account.customers.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-info">
                  <MessageCircle className="h-3.5 w-3.5" />
                </Button>
              </a>
            )}
            <Link to={`/accounts/${account.id}`}>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  };

  const Wrapper = embedded ? EmbeddedWrapper : AppLayout;

  return (
    <Wrapper>
      <div className={embedded ? 'space-y-6' : 'animate-fade-in space-y-6'}>
        {/* Header */}
        {!embedded && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
                <FileText className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">Layaway Accounts</h1>
                <p className="text-sm text-muted-foreground">{filtered.length} total accounts</p>
              </div>
            </div>
            <Link to={ROUTES.NEW_ACCOUNT}>
              <Button className="gold-gradient text-primary-foreground font-medium shadow-lg">
                <Plus className="h-4 w-4 mr-1.5" /> New Account
              </Button>
            </Link>
          </div>
        )}

        {/* Filters (search + currency + test) — single scrollable row on
            mobile so the toolbar doesn't stack half the viewport tall */}
        <div className="flex flex-row flex-nowrap overflow-x-auto scrollbar-hide items-center gap-2 sm:gap-3 sm:flex-wrap pb-1 [&>*]:shrink-0">
          {!embedded && <AccountSearchBar onSearch={handleSearch} />}
          <div className="flex gap-1 rounded-lg border border-border p-1 bg-card">
            {(['all', 'PHP', 'JPY'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setFilterCurrency(c)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  filterCurrency === c
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {c === 'all' ? 'All' : c}
              </button>
            ))}
          </div>
          <button
            onClick={() => setHideTest(!hideTest)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${
              hideTest
                ? 'border-border text-muted-foreground hover:text-foreground'
                : 'border-info/30 bg-info/10 text-info'
            }`}
          >
            🧪 {hideTest ? 'Show Test' : 'Hide Test'}
          </button>
          <SortMenu options={SORT_OPTIONS} value={sort} onChange={setSort} />
          <DensityToggle value={density} onChange={setDensity} />
        </div>

        {/* Status tab strip */}
        <div className="flex items-center gap-1 border-b border-border overflow-x-auto">
          {tabs.map((s) => {
            const isActive = filterStatus === s;
            const count = s === 'all' ? preStatusFiltered.length : (tabCounts.get(s) ?? 0);
            return (
              <button
                key={s}
                onClick={() => selectTab(s)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {s === 'all' ? 'All' : (statusLabel[s] || s)}
                <span className={`text-[10px] rounded-full px-1.5 py-0.5 ${isActive ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Loading */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">No accounts found</p>
          </div>
        ) : (
          <>
            {/* Expand / collapse all */}
            <div className="flex items-center justify-end gap-2">
              <button onClick={expandAll} className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                Expand all
              </button>
              <span className="text-muted-foreground/40">·</span>
              <button onClick={collapseAll} className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                Collapse all
              </button>
            </div>

            {/* Status folders */}
            <div className="space-y-3" ref={listContainerRef}>
              {presentStatuses.map((s) => {
                const folderAccounts = sortRows(folderMap.get(s) || [], sort, sortAccessors);
                const open = openState[s] ?? defaultOpenSet.has(s);
                const showAll = !!shownAll[s];
                const useVirtual = showAll && folderAccounts.length > VIRTUAL_THRESHOLD;
                const visible = showAll ? folderAccounts : folderAccounts.slice(0, FOLDER_CARD_CAP);
                const hiddenCount = folderAccounts.length - visible.length;
                const subtotals = new Map<string, number>();
                folderAccounts.forEach(a => subtotals.set(a.currency, (subtotals.get(a.currency) ?? 0) + Number(a.remaining_balance)));

                return (
                  <div key={s} className="rounded-xl border border-border bg-card overflow-hidden">
                    <button
                      onClick={() => setOpenState(prev => ({ ...prev, [s]: !open }))}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {open
                          ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                          : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${statusDot[s] || 'bg-muted-foreground'}`} />
                        <span className="text-sm font-semibold text-card-foreground truncate">{statusLabel[s] || s}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0 bg-primary/10 text-primary border-primary/20">
                          {folderAccounts.length}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-semibold text-card-foreground tabular-nums shrink-0">
                        {subtotals.has('PHP') && <span>{formatCurrency(subtotals.get('PHP')!, 'PHP')}</span>}
                        {subtotals.has('JPY') && <span>{formatCurrency(subtotals.get('JPY')!, 'JPY')}</span>}
                      </div>
                    </button>

                    {open && (
                      <div className="p-3 sm:p-4 border-t border-border">
                        {useVirtual ? (
                          /* Large reveal: render-layer virtualization only —
                             the underlying fetch is still the full table. */
                          <VirtualCardGrid
                            items={visible}
                            renderItem={(account) => renderAccountCard(account)}
                            estimateRowHeight={compact ? 190 : 240}
                          />
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {visible.map((account, i) => (
                              <motion.div
                                key={account.id}
                                initial={{ opacity: 0, y: 4 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ ...transition.standard, delay: rowDelay(i) }}
                              >
                                {renderAccountCard(account)}
                              </motion.div>
                            ))}
                          </div>
                        )}
                        {hiddenCount > 0 && (
                          <div className="pt-3 text-center">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setShownAll(prev => ({ ...prev, [s]: true }))}
                            >
                              Show all {folderAccounts.length} {statusLabel[s] || s} accounts ({hiddenCount} more) →
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <BulkActionBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())}>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleExportSelected}>
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleCopySelected}>
            <Copy className="h-3.5 w-3.5" /> Copy summary
          </Button>
        </BulkActionBar>

        <AccountQuickView
          account={quickView}
          statusLabel={quickView ? (statusLabel[quickView.status] || quickView.status) : ''}
          statusClassName={quickView ? (statusStyles[quickView.status] || '') : ''}
          onClose={() => setQuickView(null)}
        />
      </div>
    </Wrapper>
  );
});

export default AccountList;
