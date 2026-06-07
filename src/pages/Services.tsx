import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Wrench, Plus, Pencil, Loader2 } from 'lucide-react';
import ServiceJobDialog, {
  SERVICE_STATUSES, SERVICE_TYPES, UPDATED_BY_OPTIONS,
  type ServiceJobRow, type ServiceStatus, type ServiceType,
} from '@/components/services/ServiceJobDialog';
import { serviceStatusBadgeClass, serviceTypeBadgeClass } from '@/components/services/service-badge-styles';
import { formatCurrency } from '@/lib/calculations';

type StatusFilter = 'All' | ServiceStatus;
type TypeFilter = 'All' | ServiceType;
type UpdatedByFilter = 'All' | typeof UPDATED_BY_OPTIONS[number];

export default function Services() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('All');
  const [updatedByFilter, setUpdatedByFilter] = useState<UpdatedByFilter>('All');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [activeOnly, setActiveOnly] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editJob, setEditJob] = useState<ServiceJobRow | null>(null);

  const { data: jobs = [], isLoading } = useQuery<ServiceJobRow[]>({
    queryKey: ['service-jobs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_jobs')
        .select('*, customers:customer_id (id, full_name)')
        .order('date_received', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      // Numeric invoice-only filter (exclude test accounts) — matches the rule
      // applied across all financial dashboards. Plain JS filter on the
      // already-selected rows is fine for the list-page volume.
      return (data as unknown as ServiceJobRow[]).filter((r) => /^[0-9]+$/.test(r.invoice_number));
    },
  });

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (activeOnly) {
        if (j.service_status === 'Completed' || j.service_status === 'Cancelled') return false;
      } else if (statusFilter !== 'All' && j.service_status !== statusFilter) {
        return false;
      }
      if (typeFilter !== 'All' && j.service_type !== typeFilter) return false;
      if (updatedByFilter !== 'All' && j.updated_by !== updatedByFilter) return false;
      if (fromDate && j.date_received < fromDate) return false;
      if (toDate && j.date_received > toDate) return false;
      return true;
    });
  }, [jobs, statusFilter, typeFilter, updatedByFilter, fromDate, toDate, activeOnly]);

  const clearFilters = () => {
    setStatusFilter('All');
    setTypeFilter('All');
    setUpdatedByFilter('All');
    setFromDate('');
    setToDate('');
    setActiveOnly(false);
  };

  const handleAdd = () => {
    setEditJob(null);
    setDialogOpen(true);
  };

  const handleEdit = (job: ServiceJobRow) => {
    setEditJob(job);
    setDialogOpen(true);
  };

  return (
    <AppLayout>
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-semibold text-foreground">Services</h1>
          </div>
          <Button
            onClick={handleAdd}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4 mr-1" /> New Service Job
          </Button>
        </div>

        {/* Filter bar */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Service Status</Label>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)} disabled={activeOnly}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="All">All</SelectItem>
                  {SERVICE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Service Type</Label>
              <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="All">All</SelectItem>
                  {SERVICE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Updated By</Label>
              <Select value={updatedByFilter} onValueChange={(v) => setUpdatedByFilter(v as UpdatedByFilter)}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="All">All</SelectItem>
                  {UPDATED_BY_OPTIONS.map((u) => (
                    <SelectItem key={u} value={u}>{u}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Received From</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Received To</Label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 text-sm" />
            </div>
            <div className="flex flex-col gap-2 justify-end">
              <Button
                type="button"
                variant={activeOnly ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveOnly((v) => !v)}
                className={activeOnly ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''}
              >
                Active Jobs
              </Button>
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
              No service jobs match the current filters.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground text-xs">
                  <th className="py-3 px-3 font-medium">Date Received</th>
                  <th className="py-3 px-3 font-medium">Invoice #</th>
                  <th className="py-3 px-3 font-medium">Customer</th>
                  <th className="py-3 px-3 font-medium">Description</th>
                  <th className="py-3 px-3 font-medium">Type</th>
                  <th className="py-3 px-3 font-medium text-right">Fee</th>
                  <th className="py-3 px-3 font-medium">Status</th>
                  <th className="py-3 px-3 font-medium">Est. Completion</th>
                  <th className="py-3 px-3 font-medium">Completed</th>
                  <th className="py-3 px-3 font-medium">Updated By</th>
                  <th className="py-3 px-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((j) => (
                  <tr key={j.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                    <td className="py-2 px-3 tabular-nums whitespace-nowrap">{j.date_received}</td>
                    <td className="py-2 px-3 tabular-nums">{j.invoice_number}</td>
                    <td className="py-2 px-3">{j.customers?.full_name ?? '—'}</td>
                    <td className="py-2 px-3 max-w-[260px] truncate" title={j.service_description ?? ''}>
                      {j.service_description ?? '—'}
                    </td>
                    <td className="py-2 px-3">
                      <Badge variant="outline" className={serviceTypeBadgeClass(j.service_type)}>
                        {j.service_type}
                      </Badge>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {j.service_fee != null ? formatCurrency(Number(j.service_fee), 'JPY') : '—'}
                    </td>
                    <td className="py-2 px-3">
                      <Badge variant="outline" className={serviceStatusBadgeClass(j.service_status)}>
                        {j.service_status}
                      </Badge>
                    </td>
                    <td className="py-2 px-3 tabular-nums whitespace-nowrap">{j.estimated_completion ?? '—'}</td>
                    <td className="py-2 px-3 tabular-nums whitespace-nowrap">{j.date_completed ?? '—'}</td>
                    <td className="py-2 px-3">{j.updated_by ?? '—'}</td>
                    <td className="py-2 px-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(j)} className="h-7 px-2">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <ServiceJobDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={editJob ? 'edit' : 'add'}
        initialJob={editJob}
      />
    </AppLayout>
  );
}
