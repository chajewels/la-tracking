// Payment Proofs — system-wide index of uploaded proofs
import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useAllPaymentProofs } from '@/hooks/use-supabase-data';
import { FileText, Search, Eye, Download } from 'lucide-react';

export default function PaymentProofs() {
  const { roles } = useAuth();
  const isAdmin = (roles as any[]).includes('admin');
  const isFinance = (roles as any[]).includes('finance');
  const { data: proofs, isLoading } = useAllPaymentProofs();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return proofs || [];
    return (proofs || []).filter((p: any) => {
      const name = p.layaway_accounts?.customers?.full_name || '';
      const inv = p.layaway_accounts?.invoice_number || '';
      return (
        name.toLowerCase().includes(q) ||
        inv.toLowerCase().includes(q) ||
        (p.file_name || '').toLowerCase().includes(q) ||
        (p.uploaded_by_name || '').toLowerCase().includes(q)
      );
    });
  }, [proofs, search]);

  if (!isAdmin && !isFinance) {
    return (
      <AppLayout>
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You do not have access to this page.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" /> Payment Proofs
            </h1>
            <p className="text-xs text-muted-foreground mt-1">All uploaded proof-of-payment files across accounts.</p>
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search customer, invoice, file, uploader…"
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
              {search ? 'No proofs match your search.' : 'No proof of payment uploads yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border bg-muted/30">
                    <th className="py-2.5 px-3">Customer</th>
                    <th className="py-2.5 px-3">Invoice</th>
                    <th className="py-2.5 px-3">Month</th>
                    <th className="py-2.5 px-3">Submitted</th>
                    <th className="py-2.5 px-3">File</th>
                    <th className="py-2.5 px-3">Uploaded By</th>
                    <th className="py-2.5 px-3">Upload Date</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((proof: any) => {
                    const account = proof.layaway_accounts;
                    const customerName = account?.customers?.full_name || '—';
                    const invoice = account?.invoice_number || '—';
                    return (
                      <tr key={proof.id} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="py-2 px-3 text-foreground">{customerName}</td>
                        <td className="py-2 px-3">
                          {proof.account_id ? (
                            <Link to={`/accounts/${proof.account_id}`} className="text-primary hover:underline">
                              #{invoice}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">#{invoice}</span>
                          )}
                        </td>
                        <td className="py-2 px-3">Month {proof.installment_number}</td>
                        <td className="py-2 px-3">{proof.submission_date}</td>
                        <td className="py-2 px-3 max-w-[220px] truncate" title={proof.file_name}>{proof.file_name}</td>
                        <td className="py-2 px-3">{proof.uploaded_by_name || 'Unknown'}</td>
                        <td className="py-2 px-3 text-muted-foreground">
                          {new Date(proof.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <div className="inline-flex gap-1">
                            <a href={proof.file_url} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30">
                              <Eye className="h-3 w-3" /> View
                            </a>
                            <a href={proof.file_url} download={proof.file_name}
                              className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/30">
                              <Download className="h-3 w-3" /> Download
                            </a>
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
    </AppLayout>
  );
}
