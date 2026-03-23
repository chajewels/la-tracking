import { useMemo, useState } from 'react';
import { Search, CheckCircle, AlertTriangle, HelpCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

interface AuditRow {
  account_id: string;
  invoice_number: string;
  customer_name: string;
  currency: Currency;
  overdue_months: number;
  total_penalty: number;
  expected_cap: number;
  audit_status: 'OK' | 'EXCEEDS_CAP' | 'CHECK_REQUIRED';
  audit_notes: string;
  has_override: boolean;
}

export default function PenaltyCapAuditPanel() {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['penalty-cap-audit'],
    queryFn: async () => {
      // Fetch all active/overdue accounts with schedule + penalties
      const { data: accounts, error } = await supabase
        .from('layaway_accounts')
        .select('id, invoice_number, currency, status, payment_plan_months, customers(full_name), layaway_schedule(id, installment_number, penalty_amount, status, due_date), penalty_fees(id, penalty_amount, status, schedule_id)')
        .in('status', ['active', 'overdue'])
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Fetch overrides
      const { data: overrides } = await supabase
        .from('penalty_cap_overrides' as any)
        .select('account_id, is_active');

      const overrideSet = new Set(
        (overrides || []).filter((o: any) => o.is_active).map((o: any) => o.account_id)
      );

      return { accounts: accounts || [], overrideSet };
    },
  });

  const auditRows: AuditRow[] = useMemo(() => {
    if (!data) return [];
    const { accounts, overrideSet } = data;

    return (accounts as any[]).map((acc) => {
      const currency = acc.currency as Currency;
      const cap = currency === 'PHP' ? 1000 : 2000;
      const hasOverride = overrideSet.has(acc.id);

      // Only look at months 1-5 schedule items
      const schedItems15 = ((acc.layaway_schedule || []) as any[]).filter(
        (s: any) => s.installment_number <= 5 && s.status !== 'cancelled'
      );
      const schedIds15 = new Set(schedItems15.map((s: any) => s.id));

      // Count overdue months (past due, not paid)
      const today = new Date().toISOString().split('T')[0];
      const overdueItems = schedItems15.filter(
        (s: any) => s.due_date < today && s.status !== 'paid'
      );

      // Sum active (unpaid + paid) penalties for months 1-5
      const penalties15 = ((acc.penalty_fees || []) as any[]).filter(
        (p: any) => schedIds15.has(p.schedule_id) && p.status !== 'waived'
      );
      const totalPenalty = penalties15.reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);

      let auditStatus: AuditRow['audit_status'] = 'OK';
      let auditNotes = 'Within acceptable range';

      if (totalPenalty > cap) {
        auditStatus = 'EXCEEDS_CAP';
        auditNotes = `Penalty exceeds recommended cap (${formatCurrency(totalPenalty, currency)} > ${formatCurrency(cap, currency)})`;
      } else {
        // Check for computation irregularities
        const schedPenaltySum = schedItems15.reduce((s: number, sc: any) => s + Number(sc.penalty_amount), 0);
        if (Math.abs(schedPenaltySum - totalPenalty) > 1) {
          auditStatus = 'CHECK_REQUIRED';
          auditNotes = 'Mismatch between schedule penalty and penalty_fees records';
        }
      }

      return {
        account_id: acc.id,
        invoice_number: acc.invoice_number,
        customer_name: acc.customers?.full_name || '—',
        currency,
        overdue_months: overdueItems.length,
        total_penalty: totalPenalty,
        expected_cap: cap,
        audit_status: auditStatus,
        audit_notes: auditNotes,
        has_override: hasOverride,
      };
    });
  }, [data]);

  const filtered = useMemo(() => {
    let rows = auditRows;
    if (statusFilter !== 'all') {
      rows = rows.filter(r => r.audit_status === statusFilter);
    }
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      rows = rows.filter(r =>
        r.invoice_number.toLowerCase().includes(q) ||
        r.customer_name.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [auditRows, statusFilter, searchTerm]);

  const statusIcon = (s: AuditRow['audit_status']) => {
    if (s === 'OK') return <CheckCircle className="h-3.5 w-3.5 text-success" />;
    if (s === 'EXCEEDS_CAP') return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
    return <HelpCircle className="h-3.5 w-3.5 text-warning" />;
  };

  const statusBadgeClass = (s: AuditRow['audit_status']) => {
    if (s === 'OK') return 'bg-success/10 text-success border-success/20';
    if (s === 'EXCEEDS_CAP') return 'bg-destructive/10 text-destructive border-destructive/20';
    return 'bg-warning/10 text-warning border-warning/20';
  };

  const exceedsCount = auditRows.filter(r => r.audit_status === 'EXCEEDS_CAP').length;
  const checkCount = auditRows.filter(r => r.audit_status === 'CHECK_REQUIRED').length;

  if (isLoading) return <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-3 flex-wrap">
        <Badge variant="outline" className="text-xs">{auditRows.length} invoices scanned</Badge>
        {exceedsCount > 0 && (
          <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 text-xs">
            {exceedsCount} exceed cap
          </Badge>
        )}
        {checkCount > 0 && (
          <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20 text-xs">
            {checkCount} need review
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground">Read-only audit — no modifications made</span>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search invoice or customer..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-8 h-9 text-xs"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40 h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="OK">OK</SelectItem>
            <SelectItem value="EXCEEDS_CAP">Exceeds Cap</SelectItem>
            <SelectItem value="CHECK_REQUIRED">Check Required</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Invoice</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Overdue Mo.</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Current Penalty</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Cap</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Override</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Audit Status</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(row => (
                <tr key={row.account_id} className="hover:bg-muted/10">
                  <td className="px-3 py-2">
                    <Link to={`/accounts/${row.account_id}`} className="font-mono text-xs font-semibold text-primary hover:underline">
                      #{row.invoice_number}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-card-foreground">{row.customer_name}</td>
                  <td className="px-3 py-2 text-xs text-card-foreground">{row.overdue_months}</td>
                  <td className="px-3 py-2 text-xs font-semibold tabular-nums text-card-foreground">
                    {formatCurrency(row.total_penalty, row.currency)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                    {formatCurrency(row.expected_cap, row.currency)}
                  </td>
                  <td className="px-3 py-2">
                    {row.has_override ? (
                      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[10px]">Active</Badge>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={`text-[10px] ${statusBadgeClass(row.audit_status)}`}>
                      {statusIcon(row.audit_status)}
                      <span className="ml-1">{row.audit_status.replace('_', ' ')}</span>
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-[10px] text-muted-foreground max-w-[200px] truncate" title={row.audit_notes}>
                    {row.audit_notes}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No invoices match your filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
