// Payment Proofs — system-wide index sourced from customer payment_submissions
import { useState, useMemo, useCallback, useRef, memo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import AppLayout from '@/components/layout/AppLayout';

const EmbeddedWrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { FileText, Search, Eye, Download } from 'lucide-react';
import ProofsSearchBar from '@/components/search/ProofsSearchBar';
import { getProofSignedUrl } from '@/lib/proof-url';

const PaymentProofs = memo(function PaymentProofs({ embedded = false }: { embedded?: boolean } = {}) {
  const { roles } = useAuth();
  const isAdmin = (roles as any[]).includes('admin');
  const isFinance = (roles as any[]).includes('finance');
  const isStaff = (roles as any[]).includes('staff');
  const searchRef = useRef('');
  const [filterTick, setFilterTick] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
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

  return (
    <Wrapper>
      <div className={embedded ? 'space-y-4' : 'p-4 sm:p-6 space-y-4'}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" /> Payment Proofs
            </h1>
            <p className="text-xs text-muted-foreground mt-1">All proof-of-payment files submitted by customers via the portal.</p>
          </div>
          <ProofsSearchBar onSearch={handleSearch} />
        </div>

        <div className="rounded-xl border border-border bg-card">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {searchRef.current ? 'No proofs match your search.' : 'No customer submissions with proof yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border bg-muted/30">
                    <th className="py-2.5 px-3">Customer</th>
                    <th className="py-2.5 px-3">Invoice</th>
                    <th className="py-2.5 px-3">Month</th>
                    <th className="py-2.5 px-3">Submitted Date</th>
                    <th className="py-2.5 px-3">Amount</th>
                    <th className="py-2.5 px-3">Sender</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((sub: any) => {
                    const isCash = !!sub.cash_order_id;
                    const account = sub.layaway_accounts;
                    const cashOrder = sub.cash_orders;
                    const customerName = (isCash
                      ? (cashOrder?.customers?.full_name || sub.customers?.full_name)
                      : sub.customers?.full_name) || '—';
                    const invoice = (isCash ? cashOrder?.invoice_number : account?.invoice_number) || '—';
                    const currency = ((isCash ? cashOrder?.currency : account?.currency) || 'PHP') as Currency;
                    const statusColor = sub.status === 'confirmed' ? 'text-emerald-400'
                      : sub.status === 'rejected' ? 'text-red-400'
                      : sub.status === 'needs_clarification' ? 'text-amber-400'
                      : 'text-muted-foreground';
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
                    return (
                      <tr key={sub.id} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="py-2 px-3 text-foreground">
                          {customerName}
                          {isCash && (
                            <span className="ml-1.5 inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[9px] font-semibold text-amber-500">
                              💵 CASH
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {detailHref ? (
                            <Link to={detailHref} className="text-primary hover:underline">
                              #{invoice}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">#{invoice}</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {isCash
                            ? <span className="text-muted-foreground">—</span>
                            : (sub.installment_number ? `Month ${sub.installment_number}` : <span className="text-muted-foreground">—</span>)}
                        </td>
                        <td className="py-2 px-3">{sub.payment_date}</td>
                        <td className="py-2 px-3 font-medium">{formatCurrency(Number(sub.submitted_amount), currency)}</td>
                        <td className="py-2 px-3">{senderLabel}</td>
                        <td className={`py-2 px-3 capitalize ${statusColor}`}>{(sub.status || '').replace(/_/g, ' ')}</td>
                        <td className="py-2 px-3 text-right">
                          <div className="inline-flex gap-1">
                            <button
                              type="button"
                              onClick={() => getProofSignedUrl(sub.proof_url).then(url => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); })}
                              className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30">
                              <Eye className="h-3 w-3" /> View
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
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
                              }}
                              className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30">
                              <Download className="h-3 w-3" /> Download
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Wrapper>
  );
});

export default PaymentProofs;
