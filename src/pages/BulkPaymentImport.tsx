import { useState, useCallback, useRef } from 'react';
import { Upload, FileText, Download, CheckCircle, XCircle, Loader2, RotateCcw, AlertTriangle, Paperclip } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

/**
 * BULK PAYMENT IMPORT (rebuilt 2026-10-01, owner-approved plan).
 *
 * Every row becomes a PENDING payment_submissions row — never a payment —
 * exactly like Record Payment: Admin/Finance confirm each one in Submissions.
 * The whole file goes to the database in ONE call
 * (insert_payment_submissions_batch, migration 20261020100000): all rows or
 * none, and a retry with the same batch key inserts nothing twice.
 *
 * PROOF. The "proof required" rule applies here too. One proof image covers
 * the batch; a row may carry its own in the optional 6th CSV column
 * (proof_url, an https link to an already-uploaded image). Import is
 * disabled until every row to import has a proof from one of the two.
 *
 * NOT here: the 3-per-24h submission cap (owner decision D-1 — the caller is
 * admin/finance and a catch-up file has many rows for one account) and
 * "Confirm all in this batch" (later step, D-3).
 */
export interface ParsedRow {
  rowNum: number;
  invoice_number: string;
  amount_paid: string;
  date_paid: string;
  payment_method: string;
  remarks: string;
  /** Optional 6th column: this row's own proof image (https URL). */
  proof_url: string;
}

interface ValidatedRow extends ParsedRow {
  status: 'valid' | 'error' | 'imported' | 'skipped';
  errors: string[];
  accountId?: string;
  currency?: string;
}

/** Statuses record-payment accepts (its payableStatuses list) — kept identical. */
const PAYABLE_STATUSES = ['active', 'overdue', 'extension_active', 'reactivated', 'final_settlement'];
const MAX_ROWS = 500;

type Step = 'upload' | 'preview' | 'done';

export function parseCSV(text: string): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.length < 2 || !cols[0]) continue;
    rows.push({
      rowNum: i,
      invoice_number: cols[0] || '',
      amount_paid: cols[1] || '',
      date_paid: cols[2] || '',
      payment_method: cols[3] || 'cash',
      remarks: cols[4] || '',
      proof_url: cols[5] || '',
    });
  }
  return rows;
}

function downloadCSV(filename: string, headers: string[], rows: string[][]) {
  const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BulkPaymentImport() {
  const { profile, user } = useAuth();
  const [proofFile, setProofFile] = useState<File | null>(null);
  const proofRef = useRef<HTMLInputElement>(null);
  // One key per validated file. It is the submissions' reference_number and
  // the idempotency key: a retry after a timeout re-sends the same key and
  // the database answers with the rows it already has.
  const batchKeyRef = useRef<string>('');
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [validated, setValidated] = useState<ValidatedRow[]>([]);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.endsWith('.csv')) { toast.error('Please select a CSV file'); return; }
    setFile(f);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCSV(text);
      setParsed(rows);
      if (rows.length === 0) toast.error('No data rows found in CSV');
    };
    reader.readAsText(f);
  };

  const validateRows = useCallback(async (rows: ParsedRow[]) => {
    setValidating(true);
    try {
      const invoiceNumbers = [...new Set(rows.map(r => r.invoice_number))];
      const { data: accounts } = await supabase
        .from('layaway_accounts')
        .select('id, invoice_number, currency, status, remaining_balance')
        .in('invoice_number', invoiceNumbers);
      const acctMap = new Map((accounts || []).map(a => [a.invoice_number, a]));

      if (rows.length > MAX_ROWS) {
        toast.error(`At most ${MAX_ROWS} rows per file — split the file`);
        return;
      }
      batchKeyRef.current = crypto.randomUUID();
      const result: ValidatedRow[] = rows.map(r => {
        const errs: string[] = [];
        const acct = acctMap.get(r.invoice_number);
        if (!acct) errs.push(`Invoice #${r.invoice_number} not found`);
        else if (!PAYABLE_STATUSES.includes(acct.status))
          errs.push(`Account status is ${acct.status} — cannot accept payments`);
        const amt = parseFloat(r.amount_paid);
        if (!amt || amt <= 0) errs.push('Amount must be > 0');
        else if (acct && amt > Number(acct.remaining_balance) + 0.01)
          errs.push(`Amount ${amt} exceeds remaining balance ${acct.remaining_balance}`);
        if (!r.date_paid || !/^\d{4}-\d{2}-\d{2}$/.test(r.date_paid))
          errs.push('Date must be YYYY-MM-DD format');
        if (r.proof_url && !/^https:\/\//.test(r.proof_url)) errs.push('proof_url must be an https link');
        return {
          ...r,
          status: errs.length === 0 ? 'valid' as const : 'error' as const,
          errors: errs,
          accountId: acct?.id,
          currency: acct?.currency,
        };
      });
      setValidated(result);
      setStep('preview');
    } catch (err: unknown) {
      toast.error('Validation failed: ' + ((err as Error).message || 'unknown error'));
    } finally {
      setValidating(false);
    }
  }, []);

  const revalidateRow = useCallback(async (idx: number) => {
    const row = validated[idx];
    if (!row) return;
    const { data: accounts } = await supabase
      .from('layaway_accounts')
      .select('id, invoice_number, currency, status, remaining_balance')
      .eq('invoice_number', row.invoice_number)
      .limit(1);
    const acct = accounts?.[0];
    const errs: string[] = [];
    if (!acct) errs.push(`Invoice #${row.invoice_number} not found`);
    else if (!PAYABLE_STATUSES.includes(acct.status))
      errs.push(`Account status is ${acct.status}`);
    const amt = parseFloat(row.amount_paid);
    if (!amt || amt <= 0) errs.push('Amount must be > 0');
    else if (acct && amt > Number(acct.remaining_balance) + 0.01)
      errs.push(`Amount exceeds remaining balance`);
    if (!row.date_paid || !/^\d{4}-\d{2}-\d{2}$/.test(row.date_paid))
      errs.push('Date must be YYYY-MM-DD');
    if (row.proof_url && !/^https:\/\//.test(row.proof_url)) errs.push('proof_url must be an https link');
    setValidated(prev => prev.map((r, i) => i === idx
      ? { ...r, status: errs.length === 0 ? 'valid' : 'error', errors: errs, accountId: acct?.id, currency: acct?.currency }
      : r));
  }, [validated]);

  const updateField = (idx: number, field: string, value: string) => {
    setValidated(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
    setEditingCell(null);
    setTimeout(() => revalidateRow(idx), 100);
  };

  const validCount = validated.filter(r => r.status === 'valid').length;
  const errorCount = validated.filter(r => r.status === 'error').length;
  const importedCount = validated.filter(r => r.status === 'imported').length;
  const skippedCount = validated.filter(r => r.status === 'skipped').length;

  // Rows that would go in, and whether every one of them has a proof.
  const rowsToImport = (onlyValid: boolean) => onlyValid ? validated.filter(r => r.status === 'valid') : validated;
  const proofCovered = (onlyValid: boolean) => !!proofFile || rowsToImport(onlyValid).every(r => !!r.proof_url);

  // Upload the batch proof to payment-proofs (same bucket and shape as
  // RecordPaymentDialog) and return its public URL. Upload-first: the URL
  // travels with every row that has no proof of its own.
  const uploadBatchProof = async (): Promise<string> => {
    if (!proofFile) return '';
    const staffName = (profile?.full_name || user?.email || 'Staff').replace(/[^a-zA-Z0-9]/g, '');
    const ext = (proofFile.name.split('.').pop() || 'jpg').toLowerCase();
    const fileName = `${staffName}_BulkImport_${new Date().toISOString().slice(0, 10)}_${Date.now().toString(36)}.${ext}`;
    const storagePath = `bulk-import/${batchKeyRef.current}/${fileName}`;
    const { error: uploadErr } = await supabase.storage
      .from('payment-proofs')
      .upload(storagePath, proofFile, { cacheControl: '3600', upsert: false });
    if (uploadErr) throw new Error(`Proof upload failed: ${uploadErr.message}`);
    return supabase.storage.from('payment-proofs').getPublicUrl(storagePath).data.publicUrl;
  };

  const handleImport = useCallback(async (onlyValid: boolean) => {
    const toImport = rowsToImport(onlyValid);
    if (toImport.length === 0) { toast.error('No rows to import'); return; }
    if (toImport.some(r => r.status === 'error')) { toast.error('Fix all errors first'); return; }
    if (!proofCovered(onlyValid)) { toast.error('Attach the proof of payment for this batch'); return; }
    setImporting(true);
    try {
      const batchProofUrl = await uploadBatchProof();
      const rows = toImport.map(r => ({
        row: r.rowNum,
        invoice_number: r.invoice_number,
        amount: parseFloat(r.amount_paid),
        date: r.date_paid,
        method: r.payment_method || 'cash',
        remarks: `[Bulk import] row #${r.rowNum}${r.remarks ? ` — ${r.remarks}` : ''}`,
        proof_url: r.proof_url || undefined,
      }));
      // Not yet in the generated types (regenerated on the next edge deploy),
      // hence the `as never` casts — same idiom as transfer_payment_methods.
      const { data, error } = await supabase.rpc('insert_payment_submissions_batch' as never, {
        p_batch_key: batchKeyRef.current,
        p_proof_url: batchProofUrl || null,
        p_rows: rows,
        p_source: 'bulk_import',
        p_sender_name: profile?.full_name || user?.email || null,
      } as never);
      if (error) throw error;
      const result = data as { inserted: boolean; count: number } | null;
      const imported = new Set(toImport.map(r => r.rowNum));
      setValidated(prev => prev.map(r => imported.has(r.rowNum)
        ? { ...r, status: 'imported', errors: [] }
        : { ...r, status: 'skipped' }));
      setStep('done');
      if (result && result.inserted === false) {
        toast.info(`This batch was already submitted (${result.count} submissions) — nothing was added twice.`);
      } else {
        toast.success(`${toImport.length} payment${toImport.length !== 1 ? 's' : ''} submitted for confirmation`);
      }
    } catch (err: unknown) {
      // The database refused the batch: NOTHING was inserted. Stay on the
      // preview so the row it named can be fixed, then import again.
      const msg = (err as Error)?.message || 'Import failed';
      toast.error(msg.replace(/^duplicate_submission_detected:\s*/, ''), { duration: 10000 });
    } finally {
      setImporting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validated, proofFile, profile, user]);

  const downloadErrors = () => {
    const errorRows = validated.filter(r => r.status === 'error');
    downloadCSV('bulk-import-errors.csv',
      ['Row #', 'Invoice #', 'Amount', 'Date', 'Method', 'Remarks', 'Errors'],
      errorRows.map(r => [String(r.rowNum), r.invoice_number, r.amount_paid, r.date_paid, r.payment_method, r.remarks, r.errors.join('; ')])
    );
  };

  const downloadReport = () => {
    downloadCSV('bulk-import-report.csv',
      ['Row #', 'Invoice #', 'Amount', 'Date', 'Method', 'Remarks', 'Status', 'Details'],
      validated.map(r => [String(r.rowNum), r.invoice_number, r.amount_paid, r.date_paid, r.payment_method, r.remarks, r.status, r.errors.join('; ')])
    );
  };

  const reset = () => {
    setStep('upload');
    setFile(null);
    setParsed([]);
    setValidated([]);
    setProofFile(null);
    batchKeyRef.current = '';
    if (fileRef.current) fileRef.current.value = '';
    if (proofRef.current) proofRef.current.value = '';
  };

  const renderEditableCell = (row: ValidatedRow, idx: number, field: string, value: string, width = 'w-24') => {
    const isEditing = editingCell?.row === idx && editingCell.field === field;
    if (isEditing) {
      return (
        <Input
          autoFocus
          defaultValue={value}
          className={`${width} h-7 text-xs`}
          onBlur={(e) => updateField(idx, field, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') updateField(idx, field, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setEditingCell(null); }}
        />
      );
    }
    const isError = row.status === 'error';
    return (
      <span
        onClick={() => (row.status === 'valid' || row.status === 'error') && setEditingCell({ row: idx, field })}
        className={`cursor-pointer hover:bg-muted/50 px-1 py-0.5 rounded text-xs ${isError ? 'text-destructive' : ''}`}
        title="Click to edit"
      >
        {value || '—'}
      </span>
    );
  };

  return (
    <AppLayout>
      <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold font-display text-foreground flex items-center gap-2">
            <Upload className="h-6 w-6 text-primary" />
            Bulk Payment Import
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload a CSV of payments to validate and import in batch.
          </p>
        </div>

        {/* Step 1 — Upload */}
        {step === 'upload' && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-lg font-semibold">Step 1 — Upload CSV</h2>
            <p className="text-sm text-muted-foreground">
              CSV format: <code className="bg-muted px-1 rounded text-xs">invoice_number, amount_paid, date_paid, payment_method, remarks, proof_url</code>
              <span className="block mt-1">The last column is optional — an https link to that row's own proof image. Rows without one use the batch proof you attach in step 2.</span>
            </p>
            <div className="flex items-center gap-4">
              <label className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-background/50 px-6 py-4 text-sm text-muted-foreground cursor-pointer hover:border-primary/50 hover:text-primary transition-colors">
                <FileText className="h-5 w-5" />
                {file ? file.name : 'Choose CSV file'}
                <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
              </label>
              {parsed.length > 0 && (
                <Badge variant="outline" className="text-sm">{parsed.length} rows detected</Badge>
              )}
            </div>
            {parsed.length > 0 && (
              <Button onClick={() => validateRows(parsed)} disabled={validating} className="gold-gradient text-primary-foreground">
                {validating ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Validating…</> : 'Validate & Preview'}
              </Button>
            )}
          </div>
        )}

        {/* Step 2 — Preview */}
        {step === 'preview' && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Step 2 — Preview & Validate</h2>
              <div className="flex items-center gap-3">
                <Badge className="bg-green-500/10 text-green-600 border-green-500/30">{validCount} valid</Badge>
                {errorCount > 0 && <Badge className="bg-destructive/10 text-destructive border-destructive/30">{errorCount} errors</Badge>}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border bg-muted/30">
                    <th className="py-2 px-2">#</th>
                    <th className="py-2 px-2">Invoice #</th>
                    <th className="py-2 px-2">Amount</th>
                    <th className="py-2 px-2">Date</th>
                    <th className="py-2 px-2">Method</th>
                    <th className="py-2 px-2">Remarks</th>
                    <th className="py-2 px-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {validated.map((row, idx) => (
                    <tr key={idx} className={`border-b border-border/50 ${row.status === 'error' ? 'bg-destructive/5' : ''}`}>
                      <td className="py-1.5 px-2 text-muted-foreground">{row.rowNum}</td>
                      <td className="py-1.5 px-2 font-mono">{row.invoice_number}</td>
                      <td className="py-1.5 px-2">{renderEditableCell(row, idx, 'amount_paid', row.amount_paid)}</td>
                      <td className="py-1.5 px-2">{renderEditableCell(row, idx, 'date_paid', row.date_paid, 'w-28')}</td>
                      <td className="py-1.5 px-2">{renderEditableCell(row, idx, 'payment_method', row.payment_method, 'w-20')}</td>
                      <td className="py-1.5 px-2 max-w-[200px] truncate">{renderEditableCell(row, idx, 'remarks', row.remarks, 'w-40')}</td>
                      <td className="py-1.5 px-2">
                        {row.status === 'valid' && <Badge className="bg-green-500/10 text-green-600 border-green-500/30 text-[10px]">✅ Valid</Badge>}
                        {row.status === 'error' && (
                          <div>
                            <Badge className="bg-destructive/10 text-destructive border-destructive/30 text-[10px]">❌ Error</Badge>
                            <p className="text-[10px] text-destructive mt-0.5">{row.errors.join(', ')}</p>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border border-border bg-background/50 p-4 space-y-2">
              <p className="text-sm font-medium flex items-center gap-2"><Paperclip className="h-4 w-4" /> Proof of payment for this batch</p>
              <p className="text-xs text-muted-foreground">
                Required. One image covers every row that has no proof_url of its own. Each row becomes a pending submission for Admin/Finance to confirm, exactly like Record Payment.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 rounded-md border border-dashed border-border px-4 py-2 text-sm text-muted-foreground cursor-pointer hover:border-primary/50 hover:text-primary transition-colors">
                  <Upload className="h-4 w-4" />
                  {proofFile ? proofFile.name : 'Choose proof image'}
                  <input ref={proofRef} type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setProofFile(e.target.files?.[0] || null)} />
                </label>
                {validated.some(r => r.proof_url) && (
                  <Badge variant="outline" className="text-xs">{validated.filter(r => r.proof_url).length} row{validated.filter(r => r.proof_url).length !== 1 ? 's' : ''} with their own proof_url</Badge>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              {errorCount > 0 && (
                <Button variant="outline" size="sm" onClick={downloadErrors} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" /> Download Error Report
                </Button>
              )}
              {validCount > 0 && errorCount > 0 && (
                <Button size="sm" onClick={() => handleImport(true)} disabled={importing || !proofCovered(true)} title={!proofCovered(true) ? 'Attach the proof of payment first' : undefined} className="gap-1.5 gold-gradient text-primary-foreground">
                  {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                  Import Valid Rows Only ({validCount})
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => handleImport(false)}
                disabled={importing || errorCount > 0 || !proofCovered(false)}
                className="gap-1.5 gold-gradient text-primary-foreground"
                title={errorCount > 0 ? 'Fix all errors first' : !proofCovered(false) ? 'Attach the proof of payment first' : undefined}
              >
                {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                Import All ({validCount + errorCount})
              </Button>
              <Button variant="ghost" size="sm" onClick={reset} className="gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" /> Start Over
              </Button>
            </div>
            {importing && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading the proof and submitting the whole batch in one step…</p>
            )}
          </div>
        )}

        {/* Step 3 — Done */}
        {step === 'done' && (
          <div className="rounded-xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-lg font-semibold">Step 3 — Submitted for confirmation</h2>
            <p className="text-sm text-muted-foreground">
              These rows are now pending submissions. Confirm them one by one in Finance → Submissions (proof is attached to each). Batch key: <code className="bg-muted px-1 rounded text-xs">{batchKeyRef.current}</code>
            </p>
            <div className="flex flex-wrap gap-3">
              {importedCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <span className="text-sm font-medium text-green-700 dark:text-green-400">
                    {importedCount} payment{importedCount !== 1 ? 's' : ''} submitted
                  </span>
                </div>
              )}
              {skippedCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
                  <XCircle className="h-5 w-5 text-destructive" />
                  <span className="text-sm font-medium text-destructive">
                    {skippedCount} row{skippedCount !== 1 ? 's' : ''} skipped
                  </span>
                </div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border bg-muted/30">
                    <th className="py-2 px-2">#</th>
                    <th className="py-2 px-2">Invoice #</th>
                    <th className="py-2 px-2">Amount</th>
                    <th className="py-2 px-2">Date</th>
                    <th className="py-2 px-2">Status</th>
                    <th className="py-2 px-2">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {validated.map((row, idx) => (
                    <tr key={idx} className="border-b border-border/50">
                      <td className="py-1.5 px-2 text-muted-foreground">{row.rowNum}</td>
                      <td className="py-1.5 px-2 font-mono">{row.invoice_number}</td>
                      <td className="py-1.5 px-2">{row.amount_paid}</td>
                      <td className="py-1.5 px-2">{row.date_paid}</td>
                      <td className="py-1.5 px-2">
                        {row.status === 'imported' && <Badge className="bg-green-500/10 text-green-600 border-green-500/30 text-[10px]">✅ Submitted</Badge>}
                        {row.status === 'skipped' && <Badge className="bg-destructive/10 text-destructive border-destructive/30 text-[10px]">❌ Skipped</Badge>}
                      </td>
                      <td className="py-1.5 px-2 text-muted-foreground">{row.errors.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={downloadReport} className="gap-1.5">
                <Download className="h-3.5 w-3.5" /> Download Import Report
              </Button>
              <Button size="sm" onClick={reset} className="gap-1.5 gold-gradient text-primary-foreground">
                <RotateCcw className="h-3.5 w-3.5" /> Import Another File
              </Button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
