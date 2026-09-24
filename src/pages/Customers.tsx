import { useState, useMemo, useCallback, useEffect } from 'react';
import { parseLocation, LocationType } from '@/lib/countries';
import { LayoutGrid, ListFilter, Layers } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useCustomers, useAccountsLight, useCashOrdersLight } from '@/hooks/use-supabase-data';
import { buildAccountStatsMap } from '@/lib/customer-account-stats';

import { Skeleton } from '@/components/ui/skeleton';
import NewCustomerDialog from '@/components/customers/NewCustomerDialog';
import ImportCustomersDialog from '@/components/customers/ImportCustomersDialog';
import AlphabetNav, { LETTERS, SPECIAL } from '@/components/customers/AlphabetNav';
import CustomerCard from '@/components/customers/CustomerCard';
import EditCustomerDialog from '@/components/customers/EditCustomerDialog';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import WorkspaceToolbar from '@/components/layout/WorkspaceToolbar';
import WorkspaceSplitButton from '@/components/layout/WorkspaceSplitButton';
import PageHeaderBand from '@/components/layout/PageHeaderBand';
import CustomerDirectoryTable from '@/components/customers/CustomerDirectoryTable';
import IllustratedState, { LedgerIllustration } from '@/components/shared/LedgerIllustration';
import { useIsMobile } from '@/hooks/use-mobile';
import { ROUTES } from '@/constants/routes';

type ViewMode = 'all' | 'filter' | 'grouped';

export default function Customers() {
  const { data: customers, isLoading } = useCustomers();
  const { data: accounts } = useAccountsLight();
  const { data: cashOrders } = useCashOrdersLight();

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
  // Desktop shows the directory as the Sales ledger table; phones keep cards.
  const isMobile = useIsMobile();
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

  // Listen for the WorkspaceSplitButton "Manage Groups" action — toggles
  // the directory between grouped view and the default `all` cards view.
  useEffect(() => {
    const handler = () => {
      setViewMode(prev => prev === 'grouped' ? 'all' : 'grouped');
    };
    window.addEventListener('toggle-grouped-view', handler);
    return () => window.removeEventListener('toggle-grouped-view', handler);
  }, []);

  // New-customer dialog state — opened via the WorkspaceSplitButton
  // dispatching the `open-new-customer-dialog` CustomEvent.
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  // Optional pre-fill name carried in the CustomEvent detail (e.g. from
  // the AI command modal's "Add Customer First" follow-up).
  const [newCustomerInitialName, setNewCustomerInitialName] = useState<string>('');

  // Import customers dialog — opened via the WorkspaceSplitButton
  // dispatching the `open-import-customers` CustomEvent.
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    const handler = () => setImportOpen(true);
    window.addEventListener('open-import-customers', handler);
    return () => window.removeEventListener('open-import-customers', handler);
  }, []);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setNewCustomerInitialName(String(detail.full_name ?? ''));
      setNewCustomerOpen(true);
    };
    window.addEventListener('open-new-customer-dialog', handler);
    return () => window.removeEventListener('open-new-customer-dialog', handler);
  }, []);

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

  // Account stats lookup — the shared active/done rule (also the customer
  // page header badge): src/lib/customer-account-stats.ts
  const accountStats = useMemo(
    () => buildAccountStatsMap(accounts ?? [], cashOrders ?? []),
    [accounts, cashOrders],
  );

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

  const renderCards = (list: typeof sorted) => !isMobile ? (
    <CustomerDirectoryTable
      customers={list}
      accountStats={accountStats}
      tierMap={loyaltyTierMap}
      onEdit={openEdit}
    />
  ) : (
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
        {/* Header band (Hub visual refresh) */}
        <PageHeaderBand
          crumbs={[{ label: 'Hub', to: ROUTES.DASHBOARD }, { label: 'Customers' }]}
          title="Customers"
          subtitle={isLoading ? 'Customer directory' : `Customer directory · ${sorted.length} ${sorted.length === 1 ? 'customer' : 'customers'}`}
        />

        <div className="w-full mt-5 space-y-5">

        <WorkspaceToolbar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search customers..."
          showExport={false}
          // Let the search box shrink beside the split button on a phone
          // (an <input> will not go below its intrinsic width otherwise).
          className="[&>div:first-child]:min-w-0 [&_input]:min-w-0"
          splitButton={<WorkspaceSplitButton />}
        />

        {/* View Toggle */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="flex w-fit items-center gap-1 p-1 rounded-lg bg-card border border-gold-500/15">
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
                aria-pressed={viewMode === mode}
                className={cn(
                  'h-8 px-3 text-xs gap-1.5 rounded-md transition-colors',
                  viewMode === mode
                    ? 'bg-gold-500/15 text-gold-300 shadow-[inset_0_0_0_1px_hsl(var(--gold-500)/0.45)] hover:bg-gold-500/20 hover:text-gold-300'
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
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
              <LedgerIllustration kind="ledger" className="h-8 w-10" />
              Opening the directory…
            </div>
            {isMobile ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
              </div>
            ) : (
              <div className="space-y-2">
                {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 rounded-md" />)}
              </div>
            )}
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
                    <div className="flex h-10 w-10 items-center justify-center rounded-full border border-gold-500/60 bg-gold-500/10 font-deco text-xl font-semibold text-gold-300">
                      {activeLetter}
                    </div>
                    <div aria-hidden className="h-px flex-1 bg-gradient-to-r from-gold-500/50 via-gold-500/20 to-transparent" />
                    <span className="text-xs text-muted-foreground font-medium">
                      {(group?.length ?? 0)} customer{(group?.length ?? 0) !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {(group?.length ?? 0) > 0 ? (
                    renderCards(group!)
                  ) : (
                    <IllustratedState kind="gem" text="No customers in this group." />
                  )}
                </div>
              );
            })()}
          </div>
        ) : displayed.length === 0 ? (
          <IllustratedState
            kind="ledger"
            className="rounded-xl border border-gold-500/15 bg-card py-12"
            text={activeLetter
              ? `No customers under "${activeLetter}"`
              : 'No customers found'}
          />
        ) : (
          <>
            {renderCards(paged)}
            {totalPages > 1 && (
              // On the table's own opaque card surface, so the label reads the
              // same over any part of the background photo (ink-muted on
              // surface-1 = 5.9:1, WCAG AA).
              <div className="mx-auto mt-6 flex w-fit max-w-full items-center justify-center gap-3 rounded-full border border-gold-500/15 bg-card px-2 py-1.5 shadow-sm">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <span className="text-sm tabular-nums text-muted-foreground">
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
        </div>

        <NewCustomerDialog
          open={newCustomerOpen}
          onOpenChange={(next) => {
            setNewCustomerOpen(next);
            if (!next) setNewCustomerInitialName('');
          }}
          initialFullName={newCustomerInitialName}
        />

        <ImportCustomersDialog
          open={importOpen}
          onOpenChange={setImportOpen}
        />
      </div>
    </AppLayout>
  );
}
