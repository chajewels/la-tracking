// Payment Proofs — system-wide index sourced from customer payment_submissions
import { useState, useMemo, useCallback, useRef, useEffect, memo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import AppLayout from '@/components/layout/AppLayout';

const EmbeddedWrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { FileText, Eye, Download } from 'lucide-react';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import StatusPill from '@/components/shared/StatusPill';
import { SUBMISSION_STATUS_TONE } from '@/components/shared/status-tone';
import IllustratedState, { LedgerIllustration } from '@/components/shared/LedgerIllustration';
import ProofsSearchBar from '@/components/search/ProofsSearchBar';
import { getProofSignedUrl } from '@/lib/proof-url';

/** The columns the proof index selects (see the query below). */
interface ProofRow {
  id: string;
  account_id: string | null;
  cash_order_id: string | null;
  proof_url: string;
  payment_date: string;
  submitted_amount: number;
  sender_name: string | null;
  submitted_by_name?: string | null;
  status: string;
  installment_number: number | null;
  reference_number: string | null;
  layaway_accounts: { invoice_number: string; currency: string } | null;
  cash_orders: { invoice_number: string; currency: string; customers: { full_name: string } | null } | null;
  customers: { full_name: string } | null;
}

const PaymentProofs = memo(function PaymentProofs({ embedded = false, searchValue }: { embedded?: boolean; searchValue?: string } = {}) {
  const { roles } = useAuth();
  const isAdmin = (roles as any[]).includes('admin');
  const isFinance = (roles as any[]).includes('finance');
  const isStaff = (roles as any[]).includes('staff');
  const searchRef = useRef('');
  const [filterTick, setFilterTick] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Bug #207: mirror parent search value when embedded so the top-level
  // Sales/PaymentsHub search bar reaches PaymentProofs filtering.
  useEffect(() => {
    if (embedded && searchValue !== undefined) {
      searchRef.current = searchValue;
      setFilterTick(t => t + 1);
    }
  }, [embedded, searchValue]);
  const handleSearch = useCallback((v: string) => {
    searchRef.current = v;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setFilterTick(t => t + 1), 300);
  }, []);

  const { data: proofs, isLoading } = useQuery({
    queryKey: ['submission-proofs-all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_submissions')
        .select('id, account_id, cash_order_id, proof_url, payment_date, submitted_amount, sender_name, status, installment_number, reference_number, created_at, layaway_accounts(invoice_number, currency), cash_orders(invoice_number, currency, customers(full_name)), customers(full_name)')
        .eq('status', 'confirmed')
        .not('proof_url', 'is', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const filtered = useMemo(() => {
    const q = searchRef.current.trim().toLowerCase();
    if (!q) return proofs || [];
    return (proofs || []).filter((p: any) => {
      const name = p.customers?.full_name || p.cash_orders?.customers?.full_name || '';
      const inv = p.layaway_accounts?.invoice_number || p.cash_orders?.invoice_number || '';
      const sender = p.sender_name || '';
      return (
        name.toLowerCase().includes(q) ||
        inv.toLowerCase().includes(q) ||
        sender.toLowerCase().includes(q) ||
        (p.reference_number || '').toLowerCase().includes(q)
      );
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proofs, filterTick]);

  const Wrapper = embedded ? EmbeddedWrapper : AppLayout;

  if (!isAdmin && !isFinance && !isStaff) {
    return (
      <Wrapper>
        <div className={embedded ? '' : 'p-6'}>
          <p className="text-sm text-muted-foreground">You do not have access to this page.</p>
        </div>
      </Wrapper>
    );
  }

  /** Row facts, computed exactly as the former table rows computed them. */
  const describe = (sub: ProofRow) => {
    const isCash = !!sub.cash_order_id;
    const account = sub.layaway_accounts;
    const cashOrder = sub.cash_orders;
    const customerName = (isCash
      ? (cashOrder?.customers?.full_name || sub.customers?.full_name)
      : sub.customers?.full_name) || '—';
    const invoice = (isCash ? cashOrder?.invoice_number : account?.invoice_number) || '—';
    const currency = ((isCash ? cashOrder?.currency : account?.currency) || 'PHP') as Currency;
    const ext = (sub.proof_url || '').split('.').pop()?.split('?')[0] || 'file';
    const safeCustomer = (customerName || 'Customer').replace(/[^a-zA-Z0-9]/g, '');
    const safeInvoice = (invoice || '').replace(/[^a-zA-Z0-9]/g, '');
    const monthSeg = isCash
      ? 'Cash'
      : (sub.installment_number ? `Month${sub.installment_number}` : 'Month');
    const downloadName = `${safeCustomer}_${safeInvoice}_${monthSeg}_${sub.payment_date}.${ext}`;
    const senderLabel = sub.sender_name || sub.submitted_by_name || customerName;
    const detailHref = isCash
      ? (sub.cash_order_id ? `/cash-orders/${sub.cash_order_id}` : null)
      : (sub.account_id ? `/accounts/${sub.account_id}` : null);
    return { isCash, customerName, invoice, currency, downloadName, senderLabel, detailHref };
  };

  const download = async (sub: ProofRow, downloadName: string) => {
    try {
      const signedUrl = await getProofSignedUrl(sub.proof_url) || sub.proof_url;
      const res = await fetch(signedUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = downloadName || 'proof-of-payment';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('Download failed:', err);
    }
  };

  const actionBtn = 'inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30';
  const columns: DataTableColumn<ProofRow>[] = [
    {
      key: 'customer',
      header: 'Customer',
      cellClassName: 'max-w-[170px]',
      cell: (sub) => {
        const d = describe(sub);
        return (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-sm text-card-foreground" title={d.customerName}>{d.customerName}</span>
            {d.isCash && (
              <span className="shrink-0 rounded border border-gold-500/30 bg-gold-500/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-gold-300">Cash</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'invoice',
      header: 'Invoice',
      cellClassName: 'whitespace-nowrap',
      cell: (sub) => {
        const d = describe(sub);
        const label = <span className="font-deco text-base font-semibold [font-variant-numeric:lining-nums_tabular-nums]">#{d.invoice}</span>;
        return d.detailHref
          ? <Link to={d.detailHref} className="text-champagne hover:text-primary hover:underline">{label}</Link>
          : <span className="text-muted-foreground">{label}</span>;
      },
    },
    {
      key: 'month',
      header: 'Month',
      cellClassName: 'whitespace-nowrap',
      cell: (sub) => (!sub.cash_order_id && sub.installment_number)
        ? `Month ${sub.installment_number}`
        : <span className="text-muted-foreground">—</span>,
    },
    { key: 'date', header: 'Submitted Date', align: 'right', cell: (sub) => <span className="text-muted-foreground">{sub.payment_date}</span> },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (sub) => <span className="font-semibold text-card-foreground">{formatCurrency(Number(sub.submitted_amount), describe(sub).currency)}</span>,
    },
    {
      key: 'sender',
      header: 'Sender',
      cellClassName: 'max-w-[130px]',
      cell: (sub) => { const l = describe(sub).senderLabel; return <span className="block truncate" title={l}>{l}</span>; },
    },
    {
      key: 'status',
      header: 'Status',
      cell: (sub) => (
        <StatusPill
          label={(sub.status || '').replace(/_/g, ' ').replace(/^\w/, (c: string) => c.toUpperCase())}
          tone={SUBMISSION_STATUS_TONE[sub.status] ?? 'muted'}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      hideable: false,
      align: 'right',
      cell: (sub) => (
        <div className="inline-flex gap-1">
          <button
            type="button"
            onClick={() => getProofSignedUrl(sub.proof_url).then(url => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); })}
            className={actionBtn}>
            <Eye className="h-3 w-3" /> View
          </button>
          <button type="button" onClick={() => download(sub, describe(sub).downloadName)} className={actionBtn}>
            <Download className="h-3 w-3" /> Download
          </button>
        </div>
      ),
    },
  ];

  return (
    <Wrapper>
      <div className={embedded ? 'space-y-4' : 'p-4 sm:p-6 space-y-4'}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          {embedded ? (
            <p className="text-xs text-muted-foreground">All proof-of-payment files submitted by customers via the portal.</p>
          ) : (
            <div>
              <h1 className="font-deco text-3xl font-semibold tracking-tight text-champagne flex items-center gap-2">
                <FileText className="h-5 w-5 text-gold-300" /> Payment Proofs
              </h1>
              <p className="text-xs text-muted-foreground mt-1">All proof-of-payment files submitted by customers via the portal.</p>
            </div>
          )}
          {!embedded && <ProofsSearchBar onSearch={handleSearch} />}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
              <LedgerIllustration kind="scroll" className="h-8 w-10" />
              Opening the ledger…
            </div>
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <IllustratedState
            kind="scroll"
            className="rounded-xl border border-gold-500/15 bg-card py-12"
            text={searchRef.current ? 'No proofs match your search.' : 'No customer submissions with proof yet.'}
          />
        ) : (
          <DataTable
            variant="ledger"
            showToolbar={false}
            columns={columns}
            rows={filtered}
            rowKey={(sub) => sub.id}
            maxHeightClassName="max-h-[72vh]"
          />
        )}
      </div>
    </Wrapper>
  );
});

export default PaymentProofs;
