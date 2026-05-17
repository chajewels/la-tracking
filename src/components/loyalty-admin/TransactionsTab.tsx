import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Receipt,
  ChevronLeft,
  ChevronRight,
  Filter,
  Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useLoyaltyTransactions,
  type LoyaltyTransactionType,
  type LoyaltyTransactionRow,
  type LoyaltyTransactionViewKind,
} from '@/hooks/loyalty-admin/useLoyaltyTransactions';
import TransactionsDrawer from '@/components/loyalty-admin/TransactionsDrawer';

type RangeKey = 'all' | 'last_7' | 'last_30' | 'last_90';

const TRANSACTION_TYPE_OPTIONS: Array<{
  value: LoyaltyTransactionType;
  label: string;
}> = [
  { value: 'all', label: 'All Types' },
  { value: 'earned', label: 'Earned' },
  { value: 'bonus', label: 'Bonus' },
  { value: 'redeemed', label: 'Redeemed' },
  { value: 'expired', label: 'Expired' },
  { value: 'adjusted', label: 'Adjusted' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'birthday_bonus', label: 'Birthday Bonus' },
];

const MEMBER_TYPE_OPTIONS: Array<{
  value: LoyaltyTransactionType;
  label: string;
}> = [
  { value: 'all', label: 'All Member Events' },
  { value: 'enrolled', label: 'Enrolled' },
  { value: 'tier_changed', label: 'Tier Changed' },
  { value: 'status_changed', label: 'Status Changed' },
  { value: 'admin_edited', label: 'Admin Edited' },
];

const PAGE_SIZE = 25;

const POSITIVE_TYPES = new Set(['earned', 'bonus', 'birthday_bonus']);

function isPositive(row: LoyaltyTransactionRow): boolean {
  if (row.transaction_type === 'adjusted') return row.points_amount >= 0;
  return POSITIVE_TYPES.has(row.transaction_type);
}

// Badge palette. Member-event types get distinct hues; value-bearing
// types fall back to the green/red positive-negative scheme.
const MEMBER_BADGE_CLASS: Record<string, string> = {
  enrolled: 'border-blue-500/30 bg-blue-500/10 text-blue-600',
  tier_changed: 'border-purple-500/30 bg-purple-500/10 text-purple-600',
  status_changed: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  admin_edited: 'border-muted-foreground/30 bg-muted text-muted-foreground',
};

function badgeClass(row: LoyaltyTransactionRow): string {
  const member = MEMBER_BADGE_CLASS[row.transaction_type];
  if (member) return member;
  return isPositive(row)
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
    : 'border-destructive/30 bg-destructive/10 text-destructive';
}

function rangeStartIso(range: RangeKey): string | null {
  if (range === 'all') return null;
  const days = range === 'last_7' ? 7 : range === 'last_30' ? 30 : 90;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fmtPoints(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${Math.abs(n).toLocaleString('en-US')}`;
}

function fmtYen(n: number | null): string {
  if (n == null) return '—';
  return `¥${n.toLocaleString('en-US')}`;
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv(rows: LoyaltyTransactionRow[]) {
  const header = [
    'Date/Time',
    'Type',
    'Member',
    'Points',
    'Spend (JPY)',
    'Tier',
    'Invoice',
    'Notes',
  ];
  const lines = rows.map((r) =>
    [
      r.created_at,
      r.transaction_type,
      `${r.customer_code ?? ''} ${r.customer_full_name ?? ''}`.trim(),
      r.points_amount,
      r.spend_amount_jpy ?? '',
      r.tier_at_time ?? '',
      r.invoice_number ?? '',
      r.notes ?? '',
    ]
      .map(csvEscape)
      .join(','),
  );
  const csv = [header.join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `loyalty-transactions-${d}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function TransactionsTableView({
  viewKind,
}: {
  viewKind: LoyaltyTransactionViewKind;
}) {
  const navigate = useNavigate();
  const typeOptions =
    viewKind === 'member' ? MEMBER_TYPE_OPTIONS : TRANSACTION_TYPE_OPTIONS;
  const [transactionType, setTransactionType] =
    useState<LoyaltyTransactionType>('all');
  const [range, setRange] = useState<RangeKey>('last_30');
  const [searchInput, setSearchInput] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<LoyaltyTransactionRow | null>(null);

  // Debounce member search
  useEffect(() => {
    const t = setTimeout(() => {
      setMemberSearch(searchInput);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filters = useMemo(
    () => ({
      viewKind,
      transactionType,
      memberSearch,
      rangeStartIso: rangeStartIso(range),
      page,
      pageSize: PAGE_SIZE,
    }),
    [viewKind, transactionType, memberSearch, range, page],
  );

  const { data, isLoading, isError, refetch } =
    useLoyaltyTransactions(filters);

  function resetPage() {
    setPage(0);
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Filters:
        </div>
        <Select
          value={range}
          onValueChange={(v) => {
            setRange(v as RangeKey);
            resetPage();
          }}
        >
          <SelectTrigger className="w-[160px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last_7">Last 7 days</SelectItem>
            <SelectItem value="last_30">Last 30 days</SelectItem>
            <SelectItem value="last_90">Last 90 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={transactionType}
          onValueChange={(v) => {
            setTransactionType(v as LoyaltyTransactionType);
            resetPage();
          }}
        >
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by customer code or name..."
          className="w-[260px] h-9"
        />
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => exportCsv(data?.rows ?? [])}
          disabled={isLoading || (data?.rows.length ?? 0) === 0}
        >
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Export CSV
        </Button>
      </div>

      {/* Result count */}
      <div className="text-xs text-muted-foreground tabular-nums">
        {isLoading
          ? 'Loading…'
          : `${data?.totalCount.toLocaleString() ?? 0} ${
              viewKind === 'member' ? 'member events' : 'transactions'
            }`}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isError ? (
          <div className="p-6 text-center space-y-3">
            <p className="text-sm text-destructive">
              Failed to load transactions
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : isLoading ? (
          <div className="p-4 space-y-2">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : (data?.rows.length ?? 0) === 0 ? (
          <div className="p-10 text-center">
            <Receipt className="h-9 w-9 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">
              No transactions match these filters.
            </p>
          </div>
        ) : (
          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date/Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Member</TableHead>
                  <TableHead className="text-right">Points</TableHead>
                  <TableHead className="text-right">Spend (¥)</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data!.rows.map((r) => {
                  return (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setSelected(r)}
                    >
                      <TableCell className="text-xs whitespace-nowrap">
                        {fmtDateTime(r.created_at)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold ${badgeClass(
                            r,
                          )}`}
                        >
                          {r.transaction_type}
                        </span>
                      </TableCell>
                      <TableCell
                        className="text-xs text-primary hover:underline whitespace-nowrap"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate('/loyalty?tab=members');
                        }}
                      >
                        {r.customer_code ?? '—'}
                        {r.customer_full_name
                          ? ` · ${r.customer_full_name}`
                          : ''}
                      </TableCell>
                      <TableCell
                        className={`text-xs text-right font-semibold tabular-nums ${
                          r.points_amount >= 0
                            ? 'text-emerald-600'
                            : 'text-destructive'
                        }`}
                      >
                        {fmtPoints(r.points_amount)}
                      </TableCell>
                      <TableCell className="text-xs text-right tabular-nums">
                        {fmtYen(r.spend_amount_jpy)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.tier_at_time ?? '—'}
                      </TableCell>
                      <TableCell
                        className="text-xs"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.invoice_number && r.account_id ? (
                          <a
                            className="text-primary hover:underline"
                            href={`/accounts/${r.invoice_number}`}
                          >
                            {r.invoice_number}
                          </a>
                        ) : r.invoice_number && r.cash_order_id ? (
                          <a
                            className="text-primary hover:underline"
                            href={`/cash-orders/${r.invoice_number}`}
                          >
                            {r.invoice_number}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[220px]">
                        {r.notes ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block truncate">
                                {r.notes.length > 40
                                  ? `${r.notes.slice(0, 40)}…`
                                  : r.notes}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">
                              <p className="text-xs whitespace-pre-wrap">
                                {r.notes}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TooltipProvider>
        )}
      </div>

      {/* Pagination */}
      {(data?.totalPages ?? 1) > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {page + 1} of {data?.totalPages ?? 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setPage((p) => Math.min((data?.totalPages ?? 1) - 1, p + 1))
            }
            disabled={page >= (data?.totalPages ?? 1) - 1}
          >
            Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      )}

      <TransactionsDrawer
        transaction={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

export default function TransactionsTab() {
  return (
    <Tabs defaultValue="transactions" className="space-y-4">
      <TabsList>
        <TabsTrigger value="member">Member</TabsTrigger>
        <TabsTrigger value="transactions">Transactions</TabsTrigger>
      </TabsList>
      <TabsContent value="member">
        <TransactionsTableView viewKind="member" />
      </TabsContent>
      <TabsContent value="transactions">
        <TransactionsTableView viewKind="transactions" />
      </TabsContent>
    </Tabs>
  );
}
