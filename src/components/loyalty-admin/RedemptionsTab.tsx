import { useMemo, useState } from 'react';
import AnimatedNumber from '@/components/shared/AnimatedNumber';
import { Search, Sparkles, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Skeleton } from '@/components/ui/skeleton';
import { RedemptionApprovalModal } from '@/components/loyalty/RedemptionApprovalModal';
import {
  useRedemptionStats,
  useRedemptionQueue,
  type RedemptionStatusFilter,
  type RedemptionRangeFilter,
} from '@/hooks/loyalty-admin/useLoyaltyRedemptionsAdmin';

const PAGE_SIZE = 25;

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  confirmed: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

function fmtRedemptionType(t: string) {
  switch (t) {
    case 'new_order_discount':
      return 'New Order Discount';
    case 'shipping_fee':
      return 'Shipping Fee';
    case 'service_fee':
      return 'Service Fee';
    default:
      return t;
  }
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'amber' | 'emerald' | 'muted' | 'default';
}) {
  const toneClass: Record<typeof tone, string> = {
    amber: 'text-amber-700',
    emerald: 'text-emerald-700',
    muted: 'text-muted-foreground',
    default: 'text-foreground',
  } as const;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${toneClass[tone]}`}>
        <AnimatedNumber value={value} />
      </p>
    </div>
  );
}

export default function RedemptionsTab() {
  const [statusFilter, setStatusFilter] = useState<RedemptionStatusFilter>('all');
  const [rangeFilter, setRangeFilter] = useState<RedemptionRangeFilter>('last_30');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: stats } = useRedemptionStats();
  const { data: rows, isLoading } = useRedemptionQueue({
    status: statusFilter,
    range: rangeFilter,
  });

  const filtered = useMemo(() => {
    if (!rows) return [];
    const trimmed = search.trim().toLowerCase();
    if (!trimmed) return rows;
    return rows.filter((r) => {
      const inv = (r.invoice_number || '').toLowerCase();
      const name = (r.loyalty_member?.customers?.full_name || '').toLowerCase();
      const code = (r.loyalty_member?.customers?.customer_code || '').toLowerCase();
      return inv.includes(trimmed) || name.includes(trimmed) || code.includes(trimmed);
    });
  }, [rows, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );

  function handleStatusChange(v: RedemptionStatusFilter) {
    setStatusFilter(v);
    setPage(0);
  }
  function handleRangeChange(v: RedemptionRangeFilter) {
    setRangeFilter(v);
    setPage(0);
  }
  function handleSearchChange(v: string) {
    setSearch(v);
    setPage(0);
  }

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Pending" value={stats?.pending ?? 0} tone="amber" />
        <StatTile
          label="Approved this month"
          value={stats?.approvedThisMonth ?? 0}
          tone="emerald"
        />
        <StatTile
          label="Cancelled this month"
          value={stats?.cancelledThisMonth ?? 0}
          tone="muted"
        />
        <StatTile
          label="Total approved"
          value={stats?.totalApproved ?? 0}
          tone="default"
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by invoice or customer name…"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => handleStatusChange(v as RedemptionStatusFilter)}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={rangeFilter}
          onValueChange={(v) => handleRangeChange(v as RedemptionRangeFilter)}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Date range" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last_7">Last 7 days</SelectItem>
            <SelectItem value="last_30">Last 30 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <Sparkles className="h-9 w-9 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">
              No redemptions match your filters
            </p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Points</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((r) => {
                  const customer = r.loyalty_member?.customers;
                  return (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setSelectedId(r.id)}
                    >
                      <TableCell className="text-xs">{fmtDate(r.created_at)}</TableCell>
                      <TableCell className="text-xs">
                        <div className="text-foreground">{customer?.full_name ?? '—'}</div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {customer?.customer_code ?? ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {fmtRedemptionType(r.redemption_type)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {Number(r.points_redeemed).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        ¥{Number(r.value_applied_jpy).toLocaleString()}
                        {r.value_applied_php != null && (
                          <span className="text-muted-foreground">
                            {' '}
                            / ₱{Number(r.value_applied_php).toLocaleString()}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        #{r.invoice_number}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                            STATUS_STYLES[r.status] ?? STATUS_STYLES.cancelled
                          }`}
                        >
                          {r.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(r.id);
                          }}
                        >
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 p-3 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {page + 1} of {totalPages} · {filtered.length} total
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <RedemptionApprovalModal
        isOpen={selectedId !== null}
        onClose={() => setSelectedId(null)}
        redemptionId={selectedId}
      />
    </div>
  );
}
