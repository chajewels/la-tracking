import { useState, useMemo, Fragment } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

const PAGE_SIZE = 50;
const ALL = '__all__';
const ACCOUNT_ENTITY_TYPES = new Set(['layaway_account', 'layaway_accounts', 'account']);

type FilterOptions = {
  entity_types: string[];
  actions: string[];
  actors: { user_id: string; full_name: string | null }[];
};

function valToString(v: any): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function buildDiff(oldJson: any, newJson: any): { key: string; before: any; after: any }[] {
  const DENY = new Set(['updated_at']);
  const o = oldJson && typeof oldJson === 'object' ? oldJson : null;
  const n = newJson && typeof newJson === 'object' ? newJson : null;
  if (o && n) {
    const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])].filter(k => !DENY.has(k));
    return keys
      .filter(k => JSON.stringify(o[k]) !== JSON.stringify(n[k]))
      .map(k => ({ key: k, before: o[k], after: n[k] }));
  }
  if (n) return Object.keys(n).filter(k => !DENY.has(k)).map(k => ({ key: k, before: undefined, after: n[k] }));
  if (o) return Object.keys(o).filter(k => !DENY.has(k)).map(k => ({ key: k, before: o[k], after: undefined }));
  return [];
}

export default function ActivityLogTab() {
  const [entityType, setEntityType] = useState<string>(ALL);
  const [action, setAction] = useState<string>(ALL);
  const [actorId, setActorId] = useState<string>(ALL);
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [searchInput, setSearchInput] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [page, setPage] = useState<number>(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const resetPage = () => setPage(0);

  const { data: options } = useQuery({
    queryKey: ['audit-filter-options'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_audit_filter_options');
      if (error) throw error;
      return data as FilterOptions;
    },
  });

  const actorMap = useMemo(
    () => new Map((options?.actors || []).map(a => [a.user_id, a.full_name])),
    [options],
  );

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['admin-activity-log', { entityType, action, actorId, dateFrom, dateTo, search, page }],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let entityIds: string[] | null = null;
      const term = search.trim();
      if (term) {
        if (/^[0-9]+$/.test(term)) {
          const [{ data: la }, { data: co }] = await Promise.all([
            supabase.from('layaway_accounts').select('id').eq('invoice_number', term),
            supabase.from('cash_orders').select('id').eq('invoice_number', term),
          ]);
          entityIds = [...(la || []).map((r: any) => r.id), ...(co || []).map((r: any) => r.id)];
          if (entityIds.length === 0) entityIds = ['00000000-0000-0000-0000-000000000000'];
        } else {
          entityIds = [term];
        }
      }
      let q = supabase
        .from('audit_logs')
        .select('id, entity_type, action, entity_id, old_value_json, new_value_json, performed_by_user_id, created_at')
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (entityType !== ALL) q = q.eq('entity_type', entityType);
      if (action !== ALL) q = q.eq('action', action);
      if (actorId !== ALL) q = q.eq('performed_by_user_id', actorId);
      if (dateFrom) q = q.gte('created_at', `${dateFrom}T00:00:00+08:00`);
      if (dateTo) q = q.lte('created_at', `${dateTo}T23:59:59+08:00`);
      if (entityIds) q = q.in('entity_id', entityIds);
      const { data, error } = await q;
      if (error) throw error;
      return data as any[];
    },
  });

  const rows = data || [];
  const hasMore = rows.length === PAGE_SIZE;
  const anyFilter = entityType !== ALL || action !== ALL || actorId !== ALL || !!dateFrom || !!dateTo || !!search;

  const clearFilters = () => {
    setEntityType(ALL); setAction(ALL); setActorId(ALL);
    setDateFrom(''); setDateTo(''); setSearchInput(''); setSearch(''); setPage(0);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-zinc-700 bg-zinc-900 p-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-muted-foreground">Entity</label>
          <Select value={entityType} onValueChange={(v) => { setEntityType(v); resetPage(); }}>
            <SelectTrigger className="h-8 w-40 bg-zinc-800 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All entities</SelectItem>
              {(options?.entity_types || []).map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-muted-foreground">Action</label>
          <Select value={action} onValueChange={(v) => { setAction(v); resetPage(); }}>
            <SelectTrigger className="h-8 w-48 bg-zinc-800 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={ALL}>All actions</SelectItem>
              {(options?.actions || []).map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-muted-foreground">Actor</label>
          <Select value={actorId} onValueChange={(v) => { setActorId(v); resetPage(); }}>
            <SelectTrigger className="h-8 w-44 bg-zinc-800 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={ALL}>All actors</SelectItem>
              {(options?.actors || []).map(a => (
                <SelectItem key={a.user_id} value={a.user_id}>{a.full_name || a.user_id.slice(0, 8)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-muted-foreground">From</label>
          <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); resetPage(); }} className="h-8 w-36 bg-zinc-800 text-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-muted-foreground">To</label>
          <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); resetPage(); }} className="h-8 w-36 bg-zinc-800 text-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase text-muted-foreground">Invoice / Entity ID</label>
          <div className="flex gap-1">
            <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setSearch(searchInput); resetPage(); } }}
              placeholder="invoice # or uuid" className="h-8 w-44 bg-zinc-800 text-xs" />
            <Button size="sm" variant="outline" className="h-8" onClick={() => { setSearch(searchInput); resetPage(); }}>
              <Search className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {anyFilter && (
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={clearFilters}>
            <X className="h-3.5 w-3.5 mr-1" /> Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-zinc-900 p-6 text-center text-sm text-destructive">
          Failed to load activity log. {(error as any)?.message || ''}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-8 text-center text-sm text-zinc-400">
          No activity matches these filters.
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-zinc-800">
                  <th className="w-8 px-2 py-2.5"></th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">When</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Action</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Entity</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Ref</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Actor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r: any) => {
                  const isOpen = expandedId === r.id;
                  const diff = isOpen ? buildDiff(r.old_value_json, r.new_value_json) : [];
                  const isAccount = ACCOUNT_ENTITY_TYPES.has(r.entity_type) && r.entity_id;
                  const actorName = actorMap.get(r.performed_by_user_id) || (r.performed_by_user_id ? r.performed_by_user_id.slice(0, 8) : 'system');
                  return (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-zinc-800/60 cursor-pointer" onClick={() => setExpandedId(isOpen ? null : r.id)}>
                        <td className="px-2 py-2 text-muted-foreground">
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap tabular-nums">
                          {new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <Badge variant="outline" className="text-[10px] bg-zinc-800 border-zinc-600 text-zinc-200">{r.action}</Badge>
                        </td>
                        <td className="px-3 py-2 text-[11px] text-card-foreground">{r.entity_type}</td>
                        <td className="px-3 py-2 text-[11px] font-mono" onClick={(e) => e.stopPropagation()}>
                          {isAccount ? (
                            <Link to={`/accounts/${r.entity_id}`} className="text-primary hover:underline">{r.entity_id.slice(0, 8)}…</Link>
                          ) : (
                            <span className="text-muted-foreground">{r.entity_id ? `${r.entity_id.slice(0, 8)}…` : '—'}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-zinc-400">{actorName}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-zinc-950/60">
                          <td></td>
                          <td colSpan={5} className="px-3 py-3">
                            {diff.length === 0 ? (
                              <p className="text-[11px] text-muted-foreground">No field-level detail recorded.</p>
                            ) : (
                              <div className="space-y-1">
                                {diff.map((d) => (
                                  <div key={d.key} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                                    <span className="font-mono font-semibold text-zinc-300 min-w-[140px]">{d.key}</span>
                                    {d.before !== undefined && <span className="text-destructive line-through break-all">{valToString(d.before)}</span>}
                                    {d.before !== undefined && d.after !== undefined && <span className="text-zinc-500">→</span>}
                                    {d.after !== undefined && <span className="text-success break-all">{valToString(d.after)}</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">Page {page + 1}{isFetching ? ' · loading…' : ''}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>Previous</Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!hasMore} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}
