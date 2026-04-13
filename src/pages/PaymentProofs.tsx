// Payment Proofs — system-wide index sourced from customer payment_submissions
import { useState, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import AppLayout from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { FileText, Search, Eye, Download } from 'lucide-react';

export default function PaymentProofs({ embedded = false }: { embedded?: boolean } = {}) {
  const { roles } = useAuth();
  const isAdmin = (roles as any[]).includes('admin');
  const isFinance = (roles as any[]).includes('finance');
  const isStaff = (roles as any[]).includes('staff');
  const [search, setSearch] = useState('');

  const { data: proofs, isLoading } = useQuery({
    queryKey: ['submission-proofs-all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_submissions')
        .select('id, account_id, proof_url, payment_date, submitted_amount, sender_name, status, installment_number, reference_number, created_at, layaway_accounts(invoice_number, currency), customers(full_name)')
        .eq('status', 'confirmed')
        .not('proof_url', 'is', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return proofs || [];
    return (proofs || []).filter((p: any) => {
      const name = p.customers?.full_name || '';
      const inv = p.layaway_accounts?.invoice_number || '';
      const sender = p.sender_name || '';
      return (
        name.toLowerCase().includes(q) ||
        inv.toLowerCase().includes(q) ||
        sender.toLowerCase().includes(q) ||
        (p.reference_number || '').toLowerCase().includes(q)
      );
    });
  }, [proofs, search]);

  const Wrapper = embedded ? ({ children }: { children: ReactNode }) => <>{children}</> : AppLayout;

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
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search customer, invoice, sender, reference…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 h-9 text-sm"
            />
          </div>
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
              {search ? 'No proofs match your search.' : 'No customer submissions with proof yet.'}
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
                    const account = sub.layaway_accounts;
                    const customerName = sub.customers?.full_name || '—';
                    const invoice = account?.invoice_number || '—';
                    const currency = (account?.currency || 'PHP') as Currency;
                    const statusColor = sub.status === 'confirmed' ? 'text-emerald-400'
                      : sub.status === 'rejected' ? 'text-red-400'
                      : sub.status === 'needs_clarification' ? 'text-amber-400'
                      : 'text-muted-foreground';
                    const ext = (sub.proof_url || '').split('.').pop()?.split('?')[0] || 'file';
                    const safeCustomer = (customerName || 'Customer').replace(/[^a-zA-Z0-9]/g, '');
                    const safeInvoice = (invoice || '').replace(/[^a-zA-Z0-9]/g, '');
                    const monthSeg = sub.installment_number ? `Month${sub.installment_number}` : 'Month';
                    const downloadName = `${safeCustomer}_${safeInvoice}_${monthSeg}_${sub.payment_date}.${ext}`;
                    const senderLabel = sub.sender_name || sub.submitted_by_name || customerName;
                    return (
                      <tr key={sub.id} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="py-2 px-3 text-foreground">{customerName}</td>
                        <td className="py-2 px-3">
                          {sub.account_id ? (
                            <Link to={`/accounts/${sub.account_id}`} className="text-primary hover:underline">
                              #{invoice}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">#{invoice}</span>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          {sub.installment_number ? `Month ${sub.installment_number}` : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 px-3">{sub.payment_date}</td>
                        <td className="py-2 px-3 font-medium">{formatCurrency(Number(sub.submitted_amount), currency)}</td>
                        <td className="py-2 px-3">{senderLabel}</td>
                        <td className={`py-2 px-3 capitalize ${statusColor}`}>{(sub.status || '').replace(/_/g, ' ')}</td>
                        <td className="py-2 px-3 text-right">
                          <div className="inline-flex gap-1">
                            <button
                              type="button"
                              onClick={() => window.open(sub.proof_url, '_blank', 'noopener,noreferrer')}
                              className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30">
                              <Eye className="h-3 w-3" /> View
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const res = await fetch(sub.proof_url);
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
}
