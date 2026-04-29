import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown, Users } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useLoyaltyMembers,
  type ActivityFilter,
  type MemberSortKey,
  type SortDir,
} from '@/hooks/loyalty-admin/useLoyaltyMembers';
import MemberDetailDrawer from '@/components/loyalty-admin/MemberDetailDrawer';

const TIERS = ['all', 'Glimmer', 'Radiant', 'Elite', 'Crown VIP'] as const;
const ACTIVITY_LABELS: Record<ActivityFilter, string> = {
  all: 'All',
  active: 'Active',
  inactive: 'Inactive',
};
const PAGE_SIZE = 25;

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface SortHeaderProps {
  label: string;
  sortKey: MemberSortKey;
  current: { key: MemberSortKey; dir: SortDir };
  onSort: (key: MemberSortKey) => void;
  align?: 'left' | 'right';
}

function SortHeader({ label, sortKey, current, onSort, align = 'left' }: SortHeaderProps) {
  const active = current.key === sortKey;
  const Icon = active ? (current.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`flex items-center gap-1 text-xs font-semibold ${
        align === 'right' ? 'justify-end ml-auto' : ''
      } ${active ? 'text-foreground' : 'text-muted-foreground'} hover:text-foreground`}
    >
      {label}
      <Icon className="h-3 w-3" />
    </button>
  );
}

export default function MembersTab({
  selectedMemberId,
  setSelectedMemberId,
}: {
  selectedMemberId: string | null;
  setSelectedMemberId: (id: string | null) => void;
}) {
  const [urlSearchParams] = useSearchParams();
  const [search, setSearch] = useState<string>(() => urlSearchParams.get('search') ?? '');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [sortKey, setSortKey] = useState<MemberSortKey>('full_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  function toggleSort(key: MemberSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'full_name' || key === 'tier' ? 'asc' : 'desc');
    }
    setPage(0);
  }

  const { rows, totalFiltered, totalPages, isLoading, isError } = useLoyaltyMembers({
    search,
    tierFilter,
    activityFilter,
    sortKey,
    sortDir,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, email, or customer code…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          className="pl-9"
        />
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
          {TIERS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTierFilter(t);
                setPage(0);
              }}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                tierFilter === t
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              {t === 'all' ? 'All Tiers' : t}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
          {(Object.keys(ACTIVITY_LABELS) as ActivityFilter[]).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => {
                setActivityFilter(a);
                setPage(0);
              }}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                activityFilter === a
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              {ACTIVITY_LABELS[a]}
            </button>
          ))}
        </div>
      </div>

      {/* Result count */}
      <div className="text-xs text-muted-foreground">
        {isLoading ? 'Loading…' : `${totalFiltered.toLocaleString()} members`}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-destructive">Failed to load members</p>
          </div>
        ) : isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <Users className="h-9 w-9 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">No members match your filters</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <SortHeader
                    label="Name"
                    sortKey="full_name"
                    current={{ key: sortKey, dir: sortDir }}
                    onSort={toggleSort}
                  />
                </TableHead>
                <TableHead>
                  <SortHeader
                    label="Tier"
                    sortKey="tier"
                    current={{ key: sortKey, dir: sortDir }}
                    onSort={toggleSort}
                  />
                </TableHead>
                <TableHead className="text-right">
                  <SortHeader
                    label="Points"
                    sortKey="remaining_points"
                    current={{ key: sortKey, dir: sortDir }}
                    onSort={toggleSort}
                    align="right"
                  />
                </TableHead>
                <TableHead className="text-right">
                  <SortHeader
                    label="Lifetime Spend"
                    sortKey="cumulative_spend_jpy"
                    current={{ key: sortKey, dir: sortDir }}
                    onSort={toggleSort}
                    align="right"
                  />
                </TableHead>
                <TableHead>
                  <SortHeader
                    label="Last Purchase"
                    sortKey="last_purchase_at"
                    current={{ key: sortKey, dir: sortDir }}
                    onSort={toggleSort}
                  />
                </TableHead>
                <TableHead>
                  <SortHeader
                    label="Enrolled"
                    sortKey="enrolled_at"
                    current={{ key: sortKey, dir: sortDir }}
                    onSort={toggleSort}
                  />
                </TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.member_id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => setSelectedMemberId(r.member_id)}
                >
                  <TableCell className="text-xs">
                    <div className="text-foreground font-medium">{r.full_name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">
                      {r.customer_code ?? '—'}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: r.tier_color_hex ?? '#94A3B8' }}
                      />
                      <span>{r.tier_name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        ({r.tier_multiplier}x)
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums font-medium">
                    {r.remaining_points.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    ¥{r.cumulative_spend_jpy.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs">{fmtDate(r.last_purchase_at)}</TableCell>
                  <TableCell className="text-xs">{fmtDate(r.enrolled_at)}</TableCell>
                  <TableCell className="text-right">
                    <span
                      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                        r.activity_status === 'active'
                          ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
                          : 'bg-muted text-muted-foreground border-border'
                      }`}
                    >
                      {r.activity_status}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Detail drawer */}
      <MemberDetailDrawer
        memberId={selectedMemberId}
        onClose={() => setSelectedMemberId(null)}
      />
    </div>
  );
}
