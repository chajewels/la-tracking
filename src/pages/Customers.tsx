import { useState, useMemo, useCallback, useRef } from 'react';
import { parseLocation, LocationType } from '@/lib/countries';
import { Users, Search, LayoutGrid, ListFilter, Layers } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCustomers, useAccounts } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';
import NewCustomerDialog from '@/components/customers/NewCustomerDialog';
import AlphabetNav, { LETTERS, SPECIAL } from '@/components/customers/AlphabetNav';
import CustomerCard from '@/components/customers/CustomerCard';
import EditCustomerDialog from '@/components/customers/EditCustomerDialog';
import { cn } from '@/lib/utils';

type ViewMode = 'all' | 'filter' | 'grouped';

export default function Customers() {
  const { data: customers, isLoading } = useCustomers();
  const { data: accounts } = useAccounts();
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: '', customer_code: '', facebook_name: '', messenger_link: '',
    mobile_number: '', email: '', notes: '',
    locationType: 'japan' as 'japan' | 'international', country: '',
  });

  const openEdit = useCallback((c: any) => {
    const loc = (c.location || '').trim();
    const isJapan = !loc || loc.toLowerCase() === 'japan';
    setEditId(c.id);
    setEditForm({
      full_name: c.full_name || '', customer_code: c.customer_code || '',
      facebook_name: c.facebook_name || '', messenger_link: c.messenger_link || '',
      mobile_number: c.mobile_number || '', email: c.email || '', notes: c.notes || '',
      locationType: isJapan ? 'japan' : 'international', country: isJapan ? '' : loc,
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
    if (viewMode === 'grouped' && letter) {
      const el = sectionRefs.current[letter];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [viewMode]);

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
              <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">Customers</h1>
              <p className="text-sm text-muted-foreground">
                {displayed.length} of {sorted.length} customers
              </p>
            </div>
          </div>
          <NewCustomerDialog />
        </div>

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
          /* Grouped view */
          <div className="space-y-8">
            {[...LETTERS, SPECIAL].map(letter => {
              const group = grouped[letter];
              if (!group || group.length === 0) return null;
              return (
                <div
                  key={letter}
                  ref={el => { sectionRefs.current[letter] = el; }}
                  className="scroll-mt-24"
                >
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full gold-gradient text-primary-foreground font-bold text-sm">
                      {letter}
                    </div>
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground font-medium">
                      {group.length} customer{group.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {renderCards(group)}
                </div>
              );
            })}
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
          renderCards(displayed)
        )}
      </div>

      <EditCustomerDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editId={editId}
        editForm={editForm}
        setEditForm={setEditForm}
      />
    </AppLayout>
  );
}
