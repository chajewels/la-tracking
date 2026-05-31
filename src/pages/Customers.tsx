import { useState, useMemo, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parseLocation, LocationType } from '@/lib/countries';
import { Users, Search, LayoutGrid, ListFilter, Layers } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AccountList from './AccountList';
import CashOrdersList from '@/components/customers/CashOrdersList';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCustomers, useAccountsLight } from '@/hooks/use-supabase-data';

import { Skeleton } from '@/components/ui/skeleton';
import NewCustomerDialog from '@/components/customers/NewCustomerDialog';
import AlphabetNav, { LETTERS, SPECIAL } from '@/components/customers/AlphabetNav';
import CustomerCard from '@/components/customers/CustomerCard';
import EditCustomerDialog from '@/components/customers/EditCustomerDialog';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';

type ViewMode = 'all' | 'filter' | 'grouped';
type TabKey = 'customers' | 'accounts' | 'cash';

export default function Customers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab: TabKey = (() => {
    const t = searchParams.get('tab');
    return t === 'cash' || t === 'accounts' ? t : 'customers';
  })();
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  useEffect(() => {
    const t = searchParams.get('tab');
    const next: TabKey = t === 'cash' || t === 'accounts' ? t : 'customers';
    if (next !== activeTab) setActiveTab(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const handleTabChange = useCallback((v: string) => {
    const tab = v as TabKey;
    setActiveTab(tab);
    if (tab === 'customers') searchParams.delete('tab');
    else searchParams.set('tab', tab);
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);
  const { data: customers, isLoading } = useCustomers();
  const { data: accounts } = useAccountsLight();

  // Loyalty tier per customer (LEFT JOIN loyalty_members + current tier).
  // Non-members simply have no map entry → no badge.
  const { data: loyaltyTierMap } = useQuery({
    queryKey: ['customers-loyalty-tiers'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_members')
        .select('customer_id, current_tier:current_tier_id(name)');
      if (error) throw error;
      const map = new Map<string, string>();
      for (const row of (data ?? []) as any[]) {
        const name = row.current_tier?.name as string | undefined;
        if (row.customer_id && name) map.set(row.customer_id, name);
      }
      return map;
    },
  });
  const { roles } = useAuth();
  const { can } = usePermissions();
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

  // Pagination — fixes mobile OOM crash on iOS WebKit
  // (#80). Without it, all 662 cards render at once. 50
  // per page mirrors the AccountList pattern (30/page;
  // 50 here because customer cards are lighter than
  // account cards).
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);

  // Reset to page 0 whenever the filter set changes —
  // otherwise the user could be stuck on page 5 of a
  // filtered list that has 1 page.
  useEffect(() => {
    setPage(0);
  }, [search, viewMode, activeLetter]);

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: '', customer_code: '', facebook_name: '', messenger_link: '',
    mobile_number: '', email: '', notes: '',
    locationType: 'japan' as LocationType, country: '',
  });

  const openEdit = useCallback((c: any) => {
    const parsed = parseLocation(c.location);
    setEditId(c.id);
    setEditForm({
      full_name: c.full_name || '', customer_code: c.customer_code || '',
      facebook_name: c.facebook_name || '', messenger_link: c.messenger_link || '',
      mobile_number: c.mobile_number || '', email: c.email || '', notes: c.notes || '',
      locationType: parsed.locationType, country: parsed.country,
    });
    setEditOpen(true);
  }, []);

  // Sort all customers alphabetically
  const sorted = useMemo(() =>
    (customers || []).slice().sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [customers]
  );

  // Search-filtered list
  const searchFiltered = useMemo(() => {
    if (!search.trim()) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(c =>
      c.full_name.toLowerCase().includes(q) ||
      (c.facebook_name || '').toLowerCase().includes(q) ||
      (c.customer_code || '').toLowerCase().includes(q)
    );
  }, [sorted, search]);

  // Letter-filtered list (only in filter mode)
  const displayed = useMemo(() => {
    if (search.trim()) return searchFiltered; // search overrides letter
    if (viewMode === 'filter' && activeLetter) {
      return searchFiltered.filter(c => {
        const first = c.full_name.charAt(0).toUpperCase();
        if (activeLetter === SPECIAL) return !/[A-Z]/.test(first);
        return first === activeLetter;
      });
    }
    return searchFiltered;
  }, [searchFiltered, viewMode, activeLetter, search]);

  // Paginated slice of `displayed` for the default and
  // filter views. Grouped view paginates by letter group
  // (each group is naturally bounded), so it does not
  // use this.
  const totalPages = Math.max(1, Math.ceil(displayed.length / PAGE_SIZE));
  const paged = useMemo(
    () => displayed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [displayed, page],
  );

  // Grouped data (for grouped view)
  const grouped = useMemo(() => {
    if (viewMode !== 'grouped') return null;
    const groups: Record<string, typeof searchFiltered> = {};
    for (const c of searchFiltered) {
      const first = c.full_name.charAt(0).toUpperCase();
      const key = /[A-Z]/.test(first) ? first : SPECIAL;
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    }
    return groups;
  }, [searchFiltered, viewMode]);

  // Grouped view mounts only the active letter (mobile OOM fix).
  // Default to the first non-empty group when entering grouped view
  // with no letter chosen; never overwrite the user's explicit pick.
  useEffect(() => {
    if (activeLetter !== null) return;
    if (!grouped) return;
    const firstNonEmpty = [...LETTERS, SPECIAL].find(
      L => (grouped[L]?.length ?? 0) > 0,
    );
    if (firstNonEmpty) setActiveLetter(firstNonEmpty);
  }, [grouped, activeLetter]);

  // Account stats lookup
  const accountStats = useMemo(() => {
    const map = new Map<string, { active: number; completed: number }>();
    for (const a of accounts || []) {
      if (a.status === 'cancelled') continue;
      const stats = map.get(a.customer_id) || { active: 0, completed: 0 };
      if (a.status === 'completed' || Number(a.remaining_balance) <= 0) {
        stats.completed++;
      } else if (!['forfeited', 'final_forfeited'].includes(a.status)) {
        stats.active++;
      }
      map.set(a.customer_id, stats);
    }
    return map;
  }, [accounts]);

  const handleLetterSelect = useCallback((letter: string | null) => {
    setActiveLetter(letter);
  }, []);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
    // Auto-jump: if typed text matches a letter, select it in filter mode
    const val = e.target.value.trim();
    if (val.length === 1 && /[A-Za-z]/.test(val) && viewMode === 'filter') {
      setActiveLetter(val.toUpperCase());
    }
  }, [viewMode]);

  const renderCards = (list: typeof sorted) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {list.map(c => {
        const stats = accountStats.get(c.id) || { active: 0, completed: 0 };
        return (
          <CustomerCard
            key={c.id}
            customer={c}
            activeCount={stats.active}
            completedCount={stats.completed}
            tierName={loyaltyTierMap?.get(c.id) ?? null}
            onEdit={openEdit}
          />
        );
      })}
    </div>
  );

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
              <Users className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">Customers & Accounts</h1>
              <p className="text-sm text-muted-foreground">
                Manage customers and layaway accounts
              </p>
            </div>
          </div>
          {can('edit_customer') && <NewCustomerDialog />}
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="grid grid-cols-3 w-full max-w-md">
            <TabsTrigger value="customers">Customers ({sorted.length})</TabsTrigger>
            <TabsTrigger value="accounts">Layaway</TabsTrigger>
            <TabsTrigger value="cash">Cash</TabsTrigger>
          </TabsList>

          <TabsContent value="customers" className="mt-5 space-y-5">

        {/* Search + View Toggle */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={handleSearchChange}
              placeholder="Search by name, code, or Facebook…"
              className="pl-9 bg-card border-border"
            />
          </div>
          <div className="flex items-center gap-1 p-1 rounded-lg bg-card border border-border">
            {([
              { mode: 'all' as ViewMode, icon: LayoutGrid, label: 'All' },
              { mode: 'filter' as ViewMode, icon: ListFilter, label: 'A–Z Filter' },
              { mode: 'grouped' as ViewMode, icon: Layers, label: 'Grouped' },
            ]).map(({ mode, icon: Icon, label }) => (
              <Button
                key={mode}
                variant="ghost"
                size="sm"
                onClick={() => { setViewMode(mode); setActiveLetter(null); }}
                className={cn(
                  'h-8 px-3 text-xs gap-1.5 rounded-md transition-all',
                  viewMode === mode
                    ? 'gold-gradient text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{label}</span>
              </Button>
            ))}
          </div>
        </div>

        {/* Alphabet Nav */}
        <AlphabetNav
          customers={sorted}
          activeLetter={activeLetter}
          onSelect={handleLetterSelect}
          viewMode={viewMode}
        />

        {/* Content */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
          </div>
        ) : viewMode === 'grouped' && grouped && !search.trim() ? (
          /* Grouped view — only the active letter group is mounted
             (mobile OOM fix: caps CustomerCard count from 662 → tens).
             The A-Z rail (AlphabetNav) switches activeLetter. */
          <div className="space-y-8">
            {activeLetter && (() => {
              const group = grouped[activeLetter];
              return (
                <div key={activeLetter} className="scroll-mt-24">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full gold-gradient text-primary-foreground font-bold text-sm">
                      {activeLetter}
                    </div>
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground font-medium">
                      {(group?.length ?? 0)} customer{(group?.length ?? 0) !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {(group?.length ?? 0) > 0 ? (
                    renderCards(group!)
                  ) : (
                    <p className="text-muted-foreground py-4 text-center">
                      No customers in this group.
                    </p>
                  )}
                </div>
              );
            })()}
          </div>
        ) : displayed.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center animate-fade-in">
            <Users className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">
              {activeLetter
                ? `No customers under "${activeLetter}"`
                : 'No customers found'}
            </p>
          </div>
        ) : (
          <>
            {renderCards(paged)}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page + 1} of {totalPages}
                  <span className="hidden sm:inline"> · {displayed.length} customer{displayed.length !== 1 ? 's' : ''}</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}

        <EditCustomerDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          editId={editId}
          editForm={editForm}
          setEditForm={setEditForm}
        />
          </TabsContent>

          <TabsContent value="accounts" className="mt-5">
            <AccountList embedded />
          </TabsContent>

          <TabsContent value="cash" className="mt-5">
            <CashOrdersList embedded />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
