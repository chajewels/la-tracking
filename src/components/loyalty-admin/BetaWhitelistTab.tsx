import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Plus, X, Sparkles, ExternalLink } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  useBetaMembers,
  useCustomerSearchForBeta,
  useAddBetaMember,
  useRemoveBetaMember,
  useLoyaltyEnabledFlag,
  type BetaMemberView,
  type CustomerSearchHit,
} from '@/hooks/loyalty-admin/useLoyaltyBetaMembers';

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function BetaWhitelistTab() {
  const { roles, user } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');

  const queryClient = useQueryClient();

  const flagQuery = useLoyaltyEnabledFlag();
  const featureEnabled = flagQuery.data ?? false;

  const betaQuery = useBetaMembers(true);
  const addMutation = useAddBetaMember();
  const removeMutation = useRemoveBetaMember();

  // Customer search state
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [noteInput, setNoteInput] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(searchInput), 200);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const excludeIds = useMemo(() => {
    return new Set((betaQuery.data || []).map((b) => b.customer_id));
  }, [betaQuery.data]);

  const searchQuery = useCustomerSearchForBeta(debouncedQuery, excludeIds);

  async function handleAddBeta(hit: CustomerSearchHit) {
    try {
      await addMutation.mutateAsync({
        customerId: hit.id,
        addedByUserId: user?.id ?? null,
        notes: noteInput.trim() || null,
      });
      toast.success(`Added ${hit.full_name} to beta whitelist`);
      setSearchInput('');
      setDebouncedQuery('');
      setNoteInput('');
      await queryClient.invalidateQueries({
        queryKey: ['customer-loyalty', hit.id],
      });
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (msg.toLowerCase().includes('duplicate')) {
        toast.message(`${hit.full_name} is already in the beta whitelist`);
      } else {
        toast.error(msg || 'Could not add to beta whitelist');
      }
    }
  }

  async function handleRemoveBeta(memberRow: BetaMemberView) {
    try {
      await removeMutation.mutateAsync(memberRow.id);
      toast.success('Removed from beta whitelist');
      await queryClient.invalidateQueries({
        queryKey: ['customer-loyalty', memberRow.customer_id],
      });
    } catch (err: any) {
      toast.error(err?.message || 'Could not remove from beta whitelist');
    }
  }

  // Non-admins see a friendly empty state.
  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center">
        <Sparkles className="h-9 w-9 text-muted-foreground mx-auto mb-3 opacity-40" />
        <p className="text-sm font-medium text-foreground">Admin only</p>
        <p className="text-xs text-muted-foreground mt-1">
          Beta whitelist management is restricted to administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Read-only program-status indicator (toggle lives in Settings tab) */}
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
                : 'Loyalty program is in BETA MODE. Only customers in the beta whitelist can access the loyalty UI.'}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span
              className={`text-[11px] font-semibold uppercase tracking-wider ${
                featureEnabled ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {featureEnabled ? 'Enabled for All' : 'Beta Mode Only'}
            </span>
            <Link
              to="/loyalty/admin?tab=settings"
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
            >
              Manage in Settings tab
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </div>

      {/* Beta Whitelist */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Beta Test Customers</p>
          <p className="text-xs text-muted-foreground">
            Customers who can access loyalty features while in beta mode
          </p>
        </div>

        {featureEnabled && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Beta mode is currently OFF — all customers have loyalty access regardless of this list.
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
                disabled={addMutation.isPending}
              />
            </div>
            <Input
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Optional note — e.g., 'Internal QA test', 'VIP soft launch'"
              disabled={addMutation.isPending}
            />
          </div>

          {debouncedQuery.trim().length >= 2 && (
            <div className="rounded-md border border-border bg-card overflow-hidden">
              {searchQuery.isLoading ? (
                <div className="p-3">
                  <Skeleton className="h-6 rounded-md" />
                </div>
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
                        disabled={addMutation.isPending}
                        onClick={() => handleAddBeta(hit)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted/50 disabled:opacity-50"
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-foreground truncate">
                            {hit.full_name}
                          </div>
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
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-md" />
              ))}
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
                        disabled={removeMutation.isPending}
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
    </div>
  );
}
