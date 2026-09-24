import { memo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, MapPin, MessageCircle, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import StatusPill from '@/components/shared/StatusPill';
import Monogram from '@/components/shared/Monogram';
import LoyaltyTierBadge from '@/components/loyalty/LoyaltyTierBadge';
import type { DbCustomer } from '@/hooks/use-supabase-data';

/**
 * The account counts the directory already computes (layaway + cash orders),
 * as status pills: open = success, finished = gold, none = muted. Shared by
 * the desktop ledger table and the phone cards.
 */
export function CustomerOrderPills({ activeCount, completedCount }: { activeCount: number; completedCount: number }) {
  if (activeCount === 0 && completedCount === 0) return <StatusPill label="No accounts" tone="muted" />;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {activeCount > 0 && <StatusPill label={`${activeCount} active`} tone="success" />}
      {completedCount > 0 && <StatusPill label={`${completedCount} done`} tone="gold" />}
    </span>
  );
}

interface CustomerDirectoryTableProps {
  customers: DbCustomer[];
  accountStats: Map<string, { active: number; completed: number }>;
  tierMap?: Map<string, string>;
  onEdit: (c: DbCustomer) => void;
}

/**
 * Customer directory, desktop (Hub visual refresh, Phase 3): the Sales ledger
 * table — sticky header, gold hover rail, truncation with the full value on
 * hover. Display only: the page still owns search, the A–Z filter, sort order
 * and pagination, and passes in the page of rows to show.
 */
export default memo(function CustomerDirectoryTable({ customers, accountStats, tierMap, onEdit }: CustomerDirectoryTableProps) {
  const navigate = useNavigate();
  const stats = (id: string) => accountStats.get(id) || { active: 0, completed: 0 };

  const columns: DataTableColumn<DbCustomer>[] = [
    {
      key: 'customer',
      header: 'Customer',
      hideable: false,
      cellClassName: 'max-w-0 w-[40%]',
      cell: (c) => {
        const tier = tierMap?.get(c.id) ?? null;
        return (
          <span className="flex min-w-0 items-center gap-3">
            <Monogram name={c.full_name} size="sm" />
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <Link
                  to={`/customers/${c.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="truncate text-sm font-medium text-card-foreground hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  title={c.full_name}
                >
                  {c.full_name}
                </Link>
                {tier && <LoyaltyTierBadge tierName={tier} className="shrink-0" />}
              </span>
              {c.facebook_name && (
                <span className="block truncate text-[11px] text-muted-foreground" title={`@${c.facebook_name}`}>@{c.facebook_name}</span>
              )}
            </span>
          </span>
        );
      },
    },
    {
      key: 'code',
      header: 'Code',
      cellClassName: 'whitespace-nowrap',
      cell: (c) => <span className="font-mono text-[11px] text-muted-foreground">{c.customer_code || '—'}</span>,
    },
    {
      key: 'location',
      header: 'Location',
      cellClassName: 'max-w-[140px]',
      cell: (c) =>
        c.location ? (
          <span className="flex min-w-0 items-center gap-1 text-muted-foreground" title={c.location}>
            <MapPin className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{c.location}</span>
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      key: 'accounts',
      header: 'Accounts',
      cell: (c) => <CustomerOrderPills activeCount={stats(c.id).active} completedCount={stats(c.id).completed} />,
    },
    {
      key: 'actions',
      header: '',
      hideable: false,
      align: 'right',
      cellClassName: 'w-28',
      cell: (c) => (
        <span className="inline-flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {c.messenger_link && (
            <a href={c.messenger_link} target="_blank" rel="noopener noreferrer" aria-label={`Messenger — ${c.full_name}`}>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-info" tabIndex={-1}>
                <MessageCircle className="h-3.5 w-3.5" />
              </Button>
            </a>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-gold-300"
            onClick={() => onEdit(c)}
            aria-label={`Edit ${c.full_name}`}
            title="Edit customer"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Link to={`/customers/${c.id}`} aria-label={`Open ${c.full_name}`}>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" tabIndex={-1}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </span>
      ),
    },
  ];

  return (
    <DataTable
      variant="ledger"
      showToolbar={false}
      columns={columns}
      rows={customers}
      rowKey={(c) => c.id}
      onRowClick={(c) => navigate(`/customers/${c.id}`)}
      rowProps={(c) => ({
        tabIndex: 0,
        'aria-label': `${c.full_name}${c.customer_code ? `, ${c.customer_code}` : ''}. Press Enter to open.`,
        onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          if ((e.target as HTMLElement).closest('button, a')) return;
          e.preventDefault();
          navigate(`/customers/${c.id}`);
        },
      })}
      maxHeightClassName="max-h-[68vh]"
    />
  );
});
