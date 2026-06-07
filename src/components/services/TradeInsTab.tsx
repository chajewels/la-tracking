import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil, Loader2 } from 'lucide-react';
import TradeInDialog, { RESALE_STATUSES, type TradeInRow, type ResaleStatus } from './TradeInDialog';
import { formatCurrency } from '@/lib/calculations';

type StatusFilter = 'All' | ResaleStatus;

function resaleBadgeClass(status: ResaleStatus): string {
  return status === 'Sold'
    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
    : 'bg-amber-500/10 text-amber-500 border-amber-500/30';
}

export default function TradeInsTab() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editRow, setEditRow] = useState<TradeInRow | null>(null);

  useEffect(() => {
    const handler = () => setDialogOpen(true);
    window.addEventListener('open-trade-in-dialog', handler);
    return () => {
      window.removeEventListener('open-trade-in-dialog', handler);
    };
  }, []);

  const { data: rows = [], isLoading } = useQuery<TradeInRow[]>({
    queryKey: ['trade-ins'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trade_ins')
        .select('*, customers:customer_id (id, full_name)')
        .order('date_trade', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      // Numeric old_invoice filter — exclude test accounts. Same rule as the
      // service_jobs list (CLAUDE.md TEST ACCOUNT EXCLUSION).
      return (data as unknown as TradeInRow[]).filter((r) => /^[0-9]+$/.test(r.old_invoice_number));
    },
  });

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== 'All' && r.resale_status !== statusFilter) return false;
      if (fromDate && r.date_trade < fromDate) return false;
      if (toDate && r.date_trade > toDate) return false;
      return true;
    });
  }, [rows, statusFilter, fromDate, toDate]);

  const clearFilters = () => {
    setStatusFilter('All');
    setFromDate('');
    setToDate('');
  };

  const handleAdd = () => {
    setEditRow(null);
    setDialogOpen(true);
  };

  const handleEdit = (row: TradeInRow) => {
    setEditRow(row);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          onClick={handleAdd}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4 mr-1" /> New Trade-In
        </Button>
      </div>

      {/* Filter bar */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">Resale Status</Label>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All</SelectItem>
                {RESALE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Trade From</Label>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 text-sm" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Trade To</Label>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 text-sm" />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear filters
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No trade-ins match the current filters.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground text-xs">
                <th className="py-3 px-3 font-medium">Date Trade</th>
                <th className="py-3 px-3 font-medium">Customer</th>
                <th className="py-3 px-3 font-medium">Old Invoice #</th>
                <th className="py-3 px-3 font-medium">New Invoice #</th>
                <th className="py-3 px-3 font-medium">Item Code</th>
                <th className="py-3 px-3 font-medium">Description</th>
                <th className="py-3 px-3 font-medium text-right">Trade Amount</th>
                <th className="py-3 px-3 font-medium text-right">Resale Amount</th>
                <th className="py-3 px-3 font-medium">Status</th>
                <th className="py-3 px-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                  <td className="py-2 px-3 tabular-nums whitespace-nowrap">{r.date_trade}</td>
                  <td className="py-2 px-3">{r.customers?.full_name ?? '—'}</td>
                  <td className="py-2 px-3 tabular-nums">{r.old_invoice_number}</td>
                  <td className="py-2 px-3 tabular-nums">{r.new_invoice_number ?? '—'}</td>
                  <td className="py-2 px-3">{r.item_code}</td>
                  <td className="py-2 px-3 max-w-[260px] truncate" title={r.item_description}>
                    {r.item_description}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(Number(r.trade_amount), 'JPY')}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {r.resale_amount != null ? formatCurrency(Number(r.resale_amount), 'JPY') : '—'}
                  </td>
                  <td className="py-2 px-3">
                    <Badge variant="outline" className={resaleBadgeClass(r.resale_status)}>
                      {r.resale_status}
                    </Badge>
                  </td>
                  <td className="py-2 px-3 text-right">
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(r)} className="h-7 px-2">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <TradeInDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={editRow ? 'edit' : 'add'}
        initialTradeIn={editRow}
      />
    </div>
  );
}
