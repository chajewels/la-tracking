import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Banknote, FileText, Navigation, User } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useAccounts, useCustomers } from '@/hooks/use-supabase-data';
import { useQueryClient } from '@tanstack/react-query';
import { sidebarItems, isCategory, type MenuItem } from '@/components/layout/AppSidebar';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';

/**
 * ⌘K command palette — navigation + jump-to-record.
 * Permission-safe by construction: navigation entries pass the SAME gates
 * the sidebar uses (adminOnly → admin role, permPath → canSeeNav, child
 * permFilter → can) PLUS the canonical canAccessPage route gate, so a
 * route the user can't access never appears. Record search reads the
 * existing cached queries (['accounts'], ['customers'], ['cash-orders'])
 * — no new server surface.
 */

interface NavEntry {
  label: string;
  path: string;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {/* Data hooks live inside so the record queries only run once the
          palette has been opened. */}
      {open && <PaletteContent onDone={() => setOpen(false)} />}
    </CommandDialog>
  );
}

function PaletteContent({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { roles } = useAuth();
  const { can, canSeeNav, canAccessPage } = usePermissions();
  const isAdmin = (roles as string[]).includes('admin');
  const [query, setQuery] = useState('');

  const { data: accounts } = useAccounts();
  const { data: customers } = useCustomers();
  const queryClient = useQueryClient();
  // Cash orders: cached-only (the list page's query); no extra fetch here.
  const cashOrders = queryClient.getQueryData<any[]>(['cash-orders']) ?? [];

  const navEntries = useMemo<NavEntry[]>(() => {
    const out: NavEntry[] = [];
    for (const item of sidebarItems) {
      if (isCategory(item)) continue;
      const m = item as MenuItem;
      if (m.adminOnly && !isAdmin) continue;
      if (m.permPath && !canSeeNav(m.permPath)) continue;
      const basePath = m.path ?? m.parentPath;
      if (!basePath || !canAccessPage(basePath)) continue;
      if (m.path) {
        out.push({ label: m.label, path: m.path });
      }
      if (m.parentPath && m.children) {
        for (const child of m.children) {
          if (child.permFilter && !child.permFilter(can)) continue;
          out.push({
            label: `${m.label} · ${child.label}`,
            path: child.path ?? `${m.parentPath}?tab=${child.tab}`,
          });
        }
      }
    }
    return out;
  }, [isAdmin, can, canSeeNav, canAccessPage]);

  const q = query.trim().toLowerCase();

  const navMatches = useMemo(
    () => (q ? navEntries.filter(n => n.label.toLowerCase().includes(q)) : navEntries).slice(0, 8),
    [navEntries, q],
  );

  const accountMatches = useMemo(() => {
    if (!q) return [];
    return (accounts ?? [])
      .filter((a: any) =>
        String(a.invoice_number ?? '').toLowerCase().includes(q) ||
        String(a.customers?.full_name ?? '').toLowerCase().includes(q))
      .slice(0, 6);
  }, [accounts, q]);

  const customerMatches = useMemo(() => {
    if (!q) return [];
    return (customers ?? [])
      .filter((c: any) =>
        String(c.full_name ?? '').toLowerCase().includes(q) ||
        String(c.customer_code ?? '').toLowerCase().includes(q))
      .slice(0, 5);
  }, [customers, q]);

  const cashMatches = useMemo(() => {
    if (!q) return [];
    return cashOrders
      .filter((o: any) =>
        String(o.invoice_number ?? '').toLowerCase().includes(q) ||
        String(o.customers?.full_name ?? '').toLowerCase().includes(q))
      .slice(0, 5);
  }, [cashOrders, q]);

  const go = (path: string) => {
    onDone();
    navigate(path);
  };

  return (
    <>
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <CommandInput placeholder="Jump to a page, account, customer, or cash order…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>Nothing matches. Try an invoice #, a customer name, or a page.</CommandEmpty>
        {navMatches.length > 0 && (
          <CommandGroup heading="Navigate">
            {navMatches.map(n => (
              <CommandItem key={n.path} value={`nav ${n.label}`} onSelect={() => go(n.path)}>
                <Navigation className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                {n.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {accountMatches.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Layaway accounts">
              {accountMatches.map((a: any) => (
                <CommandItem key={a.id} value={`${a.invoice_number} ${a.customers?.full_name ?? ""} account`} onSelect={() => go(`/accounts/${a.id}`)}>
                  <FileText className="mr-2 h-3.5 w-3.5 text-gold-300" />
                  <span className="tabular-nums">#{a.invoice_number}</span>
                  <span className="mx-1.5 text-muted-foreground truncate">{a.customers?.full_name}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {formatCurrency(Number(a.remaining_balance), a.currency as Currency)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {cashMatches.length > 0 && (
          <CommandGroup heading="Cash orders">
            {cashMatches.map((o: any) => (
              <CommandItem key={o.id} value={`${o.invoice_number} ${o.customers?.full_name ?? ""} cash`} onSelect={() => go(`/cash-orders/${o.id}`)}>
                <Banknote className="mr-2 h-3.5 w-3.5 text-gold-300" />
                <span className="tabular-nums">#{o.invoice_number}</span>
                <span className="mx-1.5 text-muted-foreground truncate">{o.customers?.full_name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {customerMatches.length > 0 && (
          <CommandGroup heading="Customers">
            {customerMatches.map((c: any) => (
              <CommandItem key={c.id} value={`${c.full_name} ${c.customer_code ?? ""} customer`} onSelect={() => go(`/customers/${c.id}`)}>
                <User className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                {c.full_name}
                {c.customer_code && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{c.customer_code}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </>
  );
}
