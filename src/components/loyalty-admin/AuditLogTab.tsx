import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  History,
  ChevronLeft,
  ChevronRight,
  Filter,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
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
import {
  useLoyaltyAuditLog,
  useLoyaltyAuditActions,
  type LoyaltyAuditEntityType,
  type LoyaltyAuditRow,
} from '@/hooks/loyalty-admin/useLoyaltyAuditLog';
import { useProfileNames } from '@/hooks/loyalty-admin/useProfileNames';
import AuditLogDrawer from '@/components/loyalty-admin/AuditLogDrawer';

type RangeKey = 'all' | 'last_7' | 'last_30' | 'last_90';

const ENTITY_OPTIONS: Array<{ value: LoyaltyAuditEntityType; label: string }> = [
  { value: 'all', label: 'All Loyalty' },
  { value: 'loyalty_tier', label: 'Tier' },
  { value: 'loyalty_settings', label: 'Settings' },
  { value: 'loyalty_beta', label: 'Beta Whitelist' },
  { value: 'loyalty_redemption', label: 'Redemption' },
  { value: 'loyalty_member', label: 'Member' },
];

const ENTITY_LABELS: Record<string, string> = {
  loyalty_tier: 'Tier',
  loyalty_settings: 'Settings',
  loyalty_beta: 'Beta',
  loyalty_redemption: 'Redemption',
  loyalty_member: 'Member',
};

const PAGE_SIZE = 25;

const LOYALTY_ENTITY_TYPES = [
  'loyalty_tier',
  'loyalty_settings',
  'loyalty_beta',
  'loyalty_redemption',
  'loyalty_member',
];

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

function summarizeNewValue(row: LoyaltyAuditRow): string {
  const v = row.new_value_json as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return '—';
  const keys = Object.keys(v);
  if (keys.length === 0) return '—';
  const head = keys.slice(0, 2).map((k) => {
    const val = v[k];
    const display =
      val == null
        ? '—'
        : typeof val === 'object'
        ? '{…}'
        : String(val).slice(0, 30);
    return `${k}: ${display}`;
  });
  return head.join(', ') + (keys.length > 2 ? ' …' : '');
}

/**
 * Distinct performers who have written a loyalty audit entry recently.
 * Used to populate the "Performed by" filter dropdown without fetching
 * every profile in the database.
 */
function useAuditPerformers() {
  return useQuery<string[]>({
    queryKey: ['loyalty-admin-audit-performers'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('performed_by_user_id')
        .in('entity_type', LOYALTY_ENTITY_TYPES)
        .not('performed_by_user_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const uniq = new Set<string>();
      for (const r of (data || []) as Array<{ performed_by_user_id: string }>) {
        uniq.add(r.performed_by_user_id);
      }
      return Array.from(uniq);
    },
  });
}

export default function AuditLogTab() {
  const [entityType, setEntityType] = useState<LoyaltyAuditEntityType>('all');
  const [action, setAction] = useState<string>('all');
  const [performedBy, setPerformedBy] = useState<string>('all');
  const [range, setRange] = useState<RangeKey>('last_30');
  const [page, setPage] = useState(0);
  const [selectedRow, setSelectedRow] = useState<LoyaltyAuditRow | null>(null);

  const filters = useMemo(
    () => ({
      entityType,
      action,
      performedBy,
      rangeStartIso: rangeStartIso(range),
      rangeEndIso: null,
      page,
      pageSize: PAGE_SIZE,
    }),
    [entityType, action, performedBy, range, page],
  );

  const { data, isLoading, isError } = useLoyaltyAuditLog(filters);
  const { data: actionOptions } = useLoyaltyAuditActions();
  const { data: performerIds } = useAuditPerformers();

  const allUserIds = useMemo(() => {
    const ids = new Set<string>(performerIds ?? []);
    for (const r of data?.rows ?? []) {
      if (r.performed_by_user_id) ids.add(r.performed_by_user_id);
    }
    if (selectedRow?.performed_by_user_id) ids.add(selectedRow.performed_by_user_id);
    return Array.from(ids);
  }, [performerIds, data?.rows, selectedRow]);

  const { data: nameMap } = useProfileNames(allUserIds);

  function resetPage() {
    setPage(0);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        Loyalty audit entries are written from 2026-04-29 forward (Phase 2
        commit 1). Older actions taken before this date will not appear here.
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Filters:
        </div>
        <Select
          value={entityType}
          onValueChange={(v) => {
            setEntityType(v as LoyaltyAuditEntityType);
            resetPage();
          }}
        >
          <SelectTrigger className="w-[170px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENTITY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={action}
          onValueChange={(v) => {
            setAction(v);
            resetPage();
          }}
        >
          <SelectTrigger className="w-[200px] h-9">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {(actionOptions ?? []).map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={performedBy}
          onValueChange={(v) => {
            setPerformedBy(v);
            resetPage();
          }}
        >
          <SelectTrigger className="w-[200px] h-9">
            <SelectValue placeholder="Performed by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Anyone</SelectItem>
            {(performerIds ?? []).map((id) => (
              <SelectItem key={id} value={id}>
                {nameMap?.[id] ?? id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
      </div>

      {/* Result count */}
      <div className="text-xs text-muted-foreground tabular-nums">
        {isLoading
          ? 'Loading…'
          : `${data?.totalCount.toLocaleString() ?? 0} entries`}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-destructive">Failed to load audit log</p>
          </div>
        ) : isLoading ? (
          <div className="p-4 space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : (data?.rows.length ?? 0) === 0 ? (
          <div className="p-10 text-center">
            <History className="h-9 w-9 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">
              No audit entries match your filters
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Performer</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data!.rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => setSelectedRow(r)}
                >
                  <TableCell className="text-xs whitespace-nowrap">
                    {fmtDateTime(r.created_at)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.performed_by_user_id
                      ? nameMap?.[r.performed_by_user_id] ?? '—'
                      : 'system'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {ENTITY_LABELS[r.entity_type] ?? r.entity_type}
                  </TableCell>
                  <TableCell className="text-xs font-mono">{r.action}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[280px] truncate">
                    {summarizeNewValue(r)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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

      <AuditLogDrawer
        row={selectedRow}
        performerName={
          selectedRow?.performed_by_user_id
            ? nameMap?.[selectedRow.performed_by_user_id] ?? null
            : null
        }
        onClose={() => setSelectedRow(null)}
      />
    </div>
  );
}
