import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Plus, X, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface BetaMemberRow {
  id: string;
  customer_id: string;
  added_by_user_id: string | null;
  notes: string | null;
  created_at: string;
  customers: {
    full_name: string | null;
    customer_code: string | null;
    email: string | null;
  } | null;
}

interface BetaMemberView extends BetaMemberRow {
  added_by_name: string;
}

interface CustomerSearchHit {
  id: string;
  full_name: string;
  customer_code: string | null;
  email: string | null;
}

interface LoyaltyStats {
  enrolled: number;
  betaActive: number;
  pointsOutstanding: number;
  pointsRedeemed: number;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function useLoyaltyEnabled() {
  return useQuery({
    queryKey: ['settings', 'loyalty_enabled'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'loyalty_enabled')
        .maybeSingle();
      const raw = data?.value;
      if (raw == null) return false;
      try {
        const parsed = JSON.parse(String(raw));
        return parsed === true || parsed === 'true';
      } catch {
        return String(raw).toLowerCase() === 'true';
      }
    },
  });
}

function useBetaMembers(enabled: boolean) {
  return useQuery<BetaMemberView[]>({
    queryKey: ['loyalty-beta-members'],
    enabled,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_beta_members')
        .select(
          'id, customer_id, added_by_user_id, notes, created_at, customers:customer_id(full_name, customer_code, email)',
        )
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = ((data || []) as unknown) as BetaMemberRow[];

      const addedByIds = Array.from(
        new Set(rows.map((r) => r.added_by_user_id).filter(Boolean)),
      ) as string[];

      const profilesMap: Record<string, string> = {};
      if (addedByIds.length > 0) {
        const { data: profilesData } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', addedByIds);
        for (const p of (profilesData || []) as Array<{ id: string; full_name: string | null }>) {
          if (p.id) profilesMap[p.id] = p.full_name || '—';
        }
      }

      return rows.map((r) => ({
        ...r,
        added_by_name: r.added_by_user_id ? profilesMap[r.added_by_user_id] || '—' : '—',
      }));
    },
  });
}

function useCustomerSearch(query: string, excludeIds: Set<string>) {
  return useQuery<CustomerSearchHit[]>({
    queryKey: ['loyalty-beta-customer-search', query],
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const trimmed = query.trim();
      const pattern = `%${trimmed}%`;
      const { data, error } = await supabase
        .from('customers')
        .select('id, full_name, customer_code, email')
        .or(
          `full_name.ilike.${pattern},customer_code.ilike.${pattern},email.ilike.${pattern}`,
        )
        .order('full_name', { ascending: true })
        .limit(10);
      if (error) throw error;
      const hits = ((data || []) as unknown) as CustomerSearchHit[];
      return hits.filter((h) => !excludeIds.has(h.id));
    },
  });
}

function useLoyaltyStats(enabled: boolean) {
  return useQuery<LoyaltyStats>({
    queryKey: ['loyalty-stats'],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const [enrolledRes, betaRes, totalsRes] = await Promise.all([
        supabase
          .from('loyalty_members')
          .select('id', { count: 'exact', head: true }),
        supabase
          .from('loyalty_beta_members')
          .select('id', { count: 'exact', head: true }),
        supabase
          .from('loyalty_members')
          .select('remaining_points, total_points_redeemed'),
      ]);
      const totals = (totalsRes.data || []) as Array<{
        remaining_points: number;
        total_points_redeemed: number;
      }>;
      const pointsOutstanding = totals.reduce(
        (s, m) => s + Number(m.remaining_points || 0),
        0,
      );
      const pointsRedeemed = totals.reduce(
        (s, m) => s + Number(m.total_points_redeemed || 0),
        0,
      );
      return {
        enrolled: enrolledRes.count ?? 0,
        betaActive: betaRes.count ?? 0,
        pointsOutstanding,
        pointsRedeemed,
      };
    },
  });
}

export default function LoyaltySettingsTab() {
  const { roles, user } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const isFinance = rolesArr.includes('finance');
  const queryClient = useQueryClient();

  const flagQuery = useLoyaltyEnabled();
  const featureEnabled = flagQuery.data ?? false;
  const betaQuery = useBetaMembers(isAdmin);
  const statsQuery = useLoyaltyStats(isAdmin || isFinance);

  // Pending toggle confirmation
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [flagSaving, setFlagSaving] = useState(false);

  // Customer search state
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(searchInput), 200);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const excludeIds = useMemo(() => {
    return new Set((betaQuery.data || []).map((b) => b.customer_id));
  }, [betaQuery.data]);

  const searchQuery = useCustomerSearch(debouncedQuery, excludeIds);

  async function applyFlag(next: boolean) {
    setFlagSaving(true);
    try {
      const { error } = await supabase
        .from('system_settings')
        .upsert({ key: 'loyalty_enabled', value: next }, { onConflict: 'key' });
      if (error) throw error;
      toast.success(next ? 'Loyalty program enabled for all customers' : 'Loyalty program set to beta mode');
      await queryClient.invalidateQueries({ queryKey: ['settings', 'loyalty_enabled'] });
      await queryClient.invalidateQueries({ queryKey: ['loyalty-access'] });
    } catch (err: any) {
      toast.error(err?.message || 'Could not update feature flag');
    } finally {
      setFlagSaving(false);
    }
  }

  async function handleFlagChange(next: boolean) {
    if (next) {
      setConfirmEnable(true);
    } else {
      await applyFlag(false);
    }
  }

  async function handleAddBeta(hit: CustomerSearchHit) {
    setAdding(true);
    try {
      const payload: Record<string, unknown> = {
        customer_id: hit.id,
        added_by_user_id: user?.id ?? null,
      };
      const trimmedNote = noteInput.trim();
      if (trimmedNote) payload.notes = trimmedNote;

      const { error } = await supabase.from('loyalty_beta_members').insert(payload);
      if (error && !String(error.message).toLowerCase().includes('duplicate')) {
        throw error;
      }
      toast.success(`Added ${hit.full_name} to beta whitelist`);
      setSearchInput('');
      setDebouncedQuery('');
      setNoteInput('');
      await queryClient.invalidateQueries({ queryKey: ['loyalty-beta-members'] });
      await queryClient.invalidateQueries({ queryKey: ['loyalty-stats'] });
      await queryClient.invalidateQueries({
        queryKey: ['customer-loyalty', hit.id],
      });
    } catch (err: any) {
      toast.error(err?.message || 'Could not add to beta whitelist');
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveBeta(memberRow: BetaMemberView) {
    setRemoving(memberRow.id);
    try {
      const { error } = await supabase
        .from('loyalty_beta_members')
        .delete()
        .eq('id', memberRow.id);
      if (error) throw error;
      toast.success('Removed from beta whitelist');
      await queryClient.invalidateQueries({ queryKey: ['loyalty-beta-members'] });
      await queryClient.invalidateQueries({ queryKey: ['loyalty-stats'] });
      await queryClient.invalidateQueries({
        queryKey: ['customer-loyalty', memberRow.customer_id],
      });
    } catch (err: any) {
      toast.error(err?.message || 'Could not remove from beta whitelist');
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg gold-gradient">
          <Sparkles className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-foreground font-display">
            Loyalty Program Settings
          </h2>
          <p className="text-xs text-muted-foreground">
            Manage feature visibility and beta access
          </p>
        </div>
      </div>

      {/* Feature flag (admin only) */}
      {isAdmin && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                Loyalty Program Status
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {flagQuery.isLoading
                  ? 'Loading…'
                  : featureEnabled
                  ? 'Loyalty program is LIVE for all customers. Beta whitelist is now superseded — all enrolled customers have access.'
                  : 'Loyalty program is in BETA MODE. Only customers in the beta whitelist can access the loyalty UI. Toggle ON to launch to all customers.'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`text-[11px] font-semibold uppercase tracking-wider ${
                  featureEnabled ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {featureEnabled ? 'Enabled for All' : 'Beta Mode Only'}
              </span>
              <Switch
                checked={featureEnabled}
                disabled={flagQuery.isLoading || flagSaving}
                onCheckedChange={(v) => handleFlagChange(v)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Beta Whitelist (admin only) */}
      {isAdmin && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Beta Test Customers</p>
            <p className="text-xs text-muted-foreground">
              Customers who can access loyalty features while in beta mode
            </p>
          </div>

          {featureEnabled && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Beta mode is currently OFF — all customers have loyalty access
              regardless of this list.
            </div>
          )}

          {/* Add row */}
          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="relative sm:col-span-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Add customer to beta — search by name, code, or email"
                  className="pl-9"
                  disabled={adding}
                />
              </div>
              <Input
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                placeholder="Optional note — e.g., 'Internal QA test', 'VIP soft launch'"
                disabled={adding}
              />
            </div>

            {debouncedQuery.trim().length >= 2 && (
              <div className="rounded-md border border-border bg-card overflow-hidden">
                {searchQuery.isLoading ? (
                  <div className="p-3"><Skeleton className="h-6 rounded-md" /></div>
                ) : (searchQuery.data || []).length === 0 ? (
                  <div className="p-3 text-xs text-muted-foreground text-center">
                    No matching customers
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {(searchQuery.data || []).map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          disabled={adding}
                          onClick={() => handleAddBeta(hit)}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted/50 disabled:opacity-50"
                        >
                          <div className="min-w-0">
                            <div className="text-sm text-foreground truncate">{hit.full_name}</div>
                            <div className="text-[10px] text-muted-foreground font-mono truncate">
                              {hit.customer_code || '—'}
                              {hit.email ? ` · ${hit.email}` : ''}
                            </div>
                          </div>
                          <span className="inline-flex items-center gap-1 text-[11px] text-primary shrink-0">
                            <Plus className="h-3 w-3" /> Add
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Beta members table */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            {betaQuery.isLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-9 rounded-md" />)}
              </div>
            ) : (betaQuery.data || []).length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                No customers in the beta whitelist yet
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Added by</TableHead>
                    <TableHead>Added on</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(betaQuery.data || []).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-xs">
                        <div className="text-foreground">
                          {row.customers?.full_name ?? '—'}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {row.customers?.customer_code ?? ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">{row.customers?.email ?? '—'}</TableCell>
                      <TableCell className="text-xs">{row.added_by_name}</TableCell>
                      <TableCell className="text-xs">{fmtDate(row.created_at)}</TableCell>
                      <TableCell className="text-xs max-w-xs">
                        <span className="text-muted-foreground">{row.notes ?? '—'}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={removing === row.id}
                          onClick={() => handleRemoveBeta(row)}
                          className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                        >
                          <X className="h-3 w-3 mr-1" /> Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      )}

      {/* Stats panel (admin + finance) */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">System Stats</p>
          <p className="text-xs text-muted-foreground">
            Live snapshot — refreshes every 60 seconds
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile
            label="Enrolled members"
            value={statsQuery.data?.enrolled ?? 0}
            loading={statsQuery.isLoading}
          />
          <StatTile
            label="Active beta members"
            value={statsQuery.data?.betaActive ?? 0}
            loading={statsQuery.isLoading}
          />
          <StatTile
            label="Points outstanding"
            value={statsQuery.data?.pointsOutstanding ?? 0}
            loading={statsQuery.isLoading}
          />
          <StatTile
            label="Points redeemed all-time"
            value={statsQuery.data?.pointsRedeemed ?? 0}
            loading={statsQuery.isLoading}
          />
        </div>
      </div>

      {/* Confirmation: enabling for all customers */}
      <AlertDialog
        open={confirmEnable}
        onOpenChange={(o) => (!o ? setConfirmEnable(false) : undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable loyalty for all customers?</AlertDialogTitle>
            <AlertDialogDescription>
              This will enable the loyalty UI for ALL customers, regardless of the
              beta whitelist. Beta gating is bypassed once this is on. Are you sure?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={flagSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={flagSaving}
              onClick={async () => {
                setConfirmEnable(false);
                await applyFlag(true);
              }}
              className="gold-gradient text-primary-foreground"
            >
              {flagSaving ? 'Saving…' : 'Enable for All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatTile({ label, value, loading }: { label: string; value: number; loading?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </p>
      {loading ? (
        <Skeleton className="mt-1 h-7 rounded-md" />
      ) : (
        <p className="mt-1 text-2xl font-bold text-foreground tabular-nums">
          {value.toLocaleString()}
        </p>
      )}
    </div>
  );
}
