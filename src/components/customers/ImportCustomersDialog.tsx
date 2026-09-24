import { useCallback, useRef, useState } from 'react';
import { Upload, FileText, CheckCircle, XCircle, Loader2, Download } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { toLocationString, type LocationType } from '@/lib/countries';
import {
  blankToNull, MATCH_FIELD_LABELS, normalizeMatchEmail, normalizeMatchMobile, normalizeMatchName,
  type CustomerMatchField, type FindCustomerMatchesRpc,
} from '@/lib/customer-matches';

type Step = 'upload' | 'preview' | 'importing' | 'done';

interface ParsedRow {
  rowNum: number;
  full_name: string;
  facebook_name: string;
  messenger_link: string;
  mobile_number: string;
  email: string;
  location_type: string;
  notes: string;
}

interface ValidatedRow extends ParsedRow {
  // 'duplicate' = matched an existing customer or another row of this file, so
  // it was NOT inserted (owner rules 2026-09-23 — no override).
  status: 'valid' | 'error' | 'imported' | 'failed' | 'duplicate';
  errors: string[];
  duplicateOf?: string[];
}

interface ImportCustomersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CSV_HEADERS = [
  'full_name',
  'facebook_name',
  'messenger_link',
  'mobile_number',
  'email',
  'location_type',
  'notes',
];

const VALID_LOCATION_TYPES: LocationType[] = ['japan', 'philippines', 'international'];

function parseCSV(text: string): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (cols.length === 0 || cols.every(c => !c)) continue;
    rows.push({
      rowNum: i,
      full_name: cols[0] ?? '',
      facebook_name: cols[1] ?? '',
      messenger_link: cols[2] ?? '',
      mobile_number: cols[3] ?? '',
      email: cols[4] ?? '',
      location_type: cols[5] ?? '',
      notes: cols[6] ?? '',
    });
  }
  return rows;
}

function downloadCSV(filename: string, headers: string[], rows: string[][]) {
  const csv = [
    headers.join(','),
    ...rows.map(r => r.map(c => `"${(c ?? '').replace(/"/g, '""')}"`).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function validateRow(row: ParsedRow): string[] {
  const errs: string[] = [];
  if (!row.full_name.trim()) errs.push('Full name is required');
  const lt = row.location_type.trim().toLowerCase();
  if (lt && !VALID_LOCATION_TYPES.includes(lt as LocationType)) {
    errs.push(`location_type must be japan | philippines | international`);
  }
  return errs;
}

const fieldList = (fields: CustomerMatchField[]) => fields.map(f => MATCH_FIELD_LABELS[f] ?? f).join(', ');

/**
 * Rows of the same file that match each other on any duplicate field. Both
 * sides of a match are held back: nothing in the file says which one is right.
 * Same normalisation as public.find_customer_matches.
 */
function inFileDuplicates(rows: ValidatedRow[]): Map<number, string[]> {
  const keys = rows.map(r => ({
    full_name: normalizeMatchName(r.full_name),
    facebook_name: normalizeMatchName(r.facebook_name),
    mobile: normalizeMatchMobile(r.mobile_number),
    email: normalizeMatchEmail(r.email),
  }));
  const out = new Map<number, string[]>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows.length; j++) {
      if (i === j) continue;
      const hits = (Object.keys(keys[i]) as CustomerMatchField[])
        .filter(f => keys[i][f] !== null && keys[i][f] === keys[j][f]);
      if (hits.length > 0) {
        const list = out.get(i) ?? [];
        list.push(`Row ${rows[j].rowNum} in this file (${fieldList(hits)})`);
        out.set(i, list);
      }
    }
  }
  return out;
}

export default function ImportCustomersDialog({ open, onOpenChange }: ImportCustomersDialogProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('upload');
  const [validated, setValidated] = useState<ValidatedRow[]>([]);
  const [importProgress, setImportProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setStep('upload');
    setValidated([]);
    setImportProgress(0);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) reset();
  };

  const downloadTemplate = () => {
    downloadCSV(
      'customers-import-template.csv',
      CSV_HEADERS,
      [[
        'Maria Santos',
        'Maria Santos FB',
        'm.me/mariasantos',
        '+63 912 345 6789',
        'maria@email.com',
        'philippines',
        'VIP customer',
      ]],
    );
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.endsWith('.csv')) {
      toast.error('Please select a CSV file');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCSV(text);
      if (rows.length === 0) {
        toast.error('No data rows found in CSV');
        return;
      }
      setValidated(rows.map(r => ({
        ...r,
        status: validateRow(r).length === 0 ? 'valid' : 'error',
        errors: validateRow(r),
      })));
      setStep('preview');
    };
    reader.readAsText(f);
  };

  const validCount = validated.filter(r => r.status === 'valid').length;
  const errorCount = validated.filter(r => r.status === 'error').length;
  const importedCount = validated.filter(r => r.status === 'imported').length;
  const failedCount = validated.filter(r => r.status === 'failed').length;
  const duplicateCount = validated.filter(r => r.status === 'duplicate').length;

  const handleImport = useCallback(async () => {
    const toImport = validated.filter(r => r.status === 'valid');
    if (toImport.length === 0) return;

    setStep('importing');
    setImportProgress(0);
    const updated: ValidatedRow[] = [...validated];

    // Rows of this file that duplicate each other are never inserted.
    const validIdx = updated.map((r, i) => (r.status === 'valid' ? i : -1)).filter(i => i >= 0);
    const inFile = inFileDuplicates(validIdx.map(i => updated[i]));
    validIdx.forEach((rowIdx, k) => {
      const dup = inFile.get(k);
      if (dup) updated[rowIdx] = { ...updated[rowIdx], status: 'duplicate', errors: [], duplicateOf: dup };
    });

    for (let i = 0; i < updated.length; i++) {
      const row = updated[i];
      if (row.status !== 'valid') continue;

      // Check against existing customers BEFORE inserting. A failed check is
      // a failed row — it never falls through to the insert.
      const { data: found, error: checkErr } = await (supabase.rpc as unknown as FindCustomerMatchesRpc)(
        'find_customer_matches',
        {
          p_full_name: blankToNull(row.full_name),
          p_facebook_name: blankToNull(row.facebook_name),
          p_mobile: blankToNull(row.mobile_number),
          p_email: blankToNull(row.email),
        },
      );
      if (checkErr) {
        updated[i] = { ...row, status: 'failed', errors: [`Duplicate check failed, not imported: ${checkErr.message}`] };
        setImportProgress(Math.round(((i + 1) / updated.length) * 100));
        setValidated([...updated]);
        continue;
      }
      if (found && found.length > 0) {
        updated[i] = {
          ...row,
          status: 'duplicate',
          errors: [],
          duplicateOf: found.map(m => `${m.customer_code ?? 'No code'} — ${m.full_name ?? '(no name)'} (${fieldList(m.matched_on)})`),
        };
        setImportProgress(Math.round(((i + 1) / updated.length) * 100));
        setValidated([...updated]);
        continue;
      }

      const lt = (row.location_type.trim().toLowerCase() || 'philippines') as LocationType;
      const location = toLocationString(lt, '') ?? null;

      try {
        const { error } = await supabase
          .from('customers')
          .insert({
            full_name: row.full_name.trim(),
            facebook_name: row.facebook_name.trim() || null,
            messenger_link: row.messenger_link.trim() || null,
            mobile_number: row.mobile_number.trim() || null,
            email: row.email.trim() || null,
            location,
            notes: row.notes.trim() || null,
          });
        if (error) throw error;
        updated[i] = { ...row, status: 'imported', errors: [] };
      } catch (err) {
        const msg = (err as Error).message || 'Insert failed';
        updated[i] = { ...row, status: 'failed', errors: [msg] };
      }
      setImportProgress(Math.round(((i + 1) / updated.length) * 100));
      setValidated([...updated]);
    }

    setStep('done');
    qc.invalidateQueries({ queryKey: ['customers'] });
    const success = updated.filter(r => r.status === 'imported').length;
    const dups = updated.filter(r => r.status === 'duplicate').length;
    toast.success(`${success} customer${success !== 1 ? 's' : ''} imported`
      + (dups > 0 ? ` — ${dups} not imported (existing customer)` : ''));
  }, [validated, qc]);

  const downloadErrors = () => {
    const errorRows = validated.filter(r => r.status === 'error' || r.status === 'failed' || r.status === 'duplicate');
    downloadCSV(
      'customer-import-errors.csv',
      ['Row #', ...CSV_HEADERS, 'Errors'],
      errorRows.map(r => [
        String(r.rowNum),
        r.full_name, r.facebook_name, r.messenger_link, r.mobile_number,
        r.email, r.location_type, r.notes,
        r.status === 'duplicate' ? `Not imported — matches: ${(r.duplicateOf ?? []).join('; ')}` : r.errors.join('; '),
      ]),
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Customers</DialogTitle>
          <DialogDescription>
            Upload a CSV file to bulk import customers. Download the template to get started.
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <div className="space-y-4 py-2">
            <Button variant="outline" size="sm" onClick={downloadTemplate} className="gap-1.5">
              <Download className="h-3.5 w-3.5" /> Download CSV Template
            </Button>

            <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden"
                id="customer-csv-input"
              />
              <label htmlFor="customer-csv-input" className="cursor-pointer block">
                <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Click to select a CSV file</p>
              </label>
            </div>

            <p className="text-xs text-muted-foreground">
              Required column: <code className="bg-muted px-1 rounded">full_name</code>.
              <span className="ml-1">
                <code className="bg-muted px-1 rounded">location_type</code> must be one of
                {' '}<code className="bg-muted px-1 rounded">japan</code>,
                {' '}<code className="bg-muted px-1 rounded">philippines</code>, or
                {' '}<code className="bg-muted px-1 rounded">international</code>.
              </span>
            </p>
          </div>
        )}

        {step === 'preview' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{validated.length} rows</Badge>
              <Badge className="bg-green-500/10 text-green-600 border-green-500/30">{validCount} valid</Badge>
              {errorCount > 0 && (
                <Badge className="bg-destructive/10 text-destructive border-destructive/30">{errorCount} errors</Badge>
              )}
            </div>

            <div className="overflow-x-auto rounded-md border border-border max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border bg-muted/30">
                    <th className="py-2 px-2">#</th>
                    <th className="py-2 px-2">Full Name</th>
                    <th className="py-2 px-2">Mobile</th>
                    <th className="py-2 px-2">Email</th>
                    <th className="py-2 px-2">Location</th>
                    <th className="py-2 px-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {validated.map((row, idx) => (
                    <tr key={idx} className={`border-b border-border/50 ${row.status === 'error' ? 'bg-destructive/5' : ''}`}>
                      <td className="py-1.5 px-2 text-muted-foreground">{row.rowNum}</td>
                      <td className="py-1.5 px-2">{row.full_name || '—'}</td>
                      <td className="py-1.5 px-2">{row.mobile_number || '—'}</td>
                      <td className="py-1.5 px-2">{row.email || '—'}</td>
                      <td className="py-1.5 px-2">{row.location_type || '—'}</td>
                      <td className="py-1.5 px-2">
                        {row.status === 'valid' && (
                          <Badge className="bg-green-500/10 text-green-600 border-green-500/30 text-[10px]">Valid</Badge>
                        )}
                        {row.status === 'error' && (
                          <div>
                            <Badge className="bg-destructive/10 text-destructive border-destructive/30 text-[10px]">Error</Badge>
                            <p className="text-[10px] text-destructive mt-0.5">{row.errors.join(', ')}</p>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => reset()}>Back</Button>
              <Button
                onClick={handleImport}
                disabled={validCount === 0}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Import {validCount} customer{validCount !== 1 ? 's' : ''}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'importing' && (
          <div className="py-6 space-y-4">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Importing customers…
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-all rounded-full"
                  style={{ width: `${importProgress}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">{importProgress}%</span>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4 py-2">
            <div className="flex flex-wrap gap-3">
              {importedCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <span className="text-sm font-medium text-green-700 dark:text-green-400">
                    {importedCount} imported
                  </span>
                </div>
              )}
              {duplicateCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
                  <XCircle className="h-5 w-5 text-warning" />
                  <span className="text-sm font-medium text-warning">
                    {duplicateCount} not imported — existing customer
                  </span>
                </div>
              )}
              {failedCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
                  <XCircle className="h-5 w-5 text-destructive" />
                  <span className="text-sm font-medium text-destructive">
                    {failedCount} failed
                  </span>
                </div>
              )}
            </div>

            {failedCount > 0 && (
              <div className="overflow-x-auto rounded-md border border-border max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border bg-muted/30">
                      <th className="py-2 px-2">#</th>
                      <th className="py-2 px-2">Full Name</th>
                      <th className="py-2 px-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validated.filter(r => r.status === 'failed').map((row, idx) => (
                      <tr key={idx} className="border-b border-border/50">
                        <td className="py-1.5 px-2 text-muted-foreground">{row.rowNum}</td>
                        <td className="py-1.5 px-2">{row.full_name}</td>
                        <td className="py-1.5 px-2 text-destructive">{row.errors.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {duplicateCount > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  These rows match an existing customer (or another row in this file) and were NOT imported.
                  Confirm the details with the customer and use the existing account.
                </p>
                <div className="overflow-x-auto rounded-md border border-border max-h-56 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border bg-muted/30">
                        <th className="py-2 px-2">#</th>
                        <th className="py-2 px-2">Full Name</th>
                        <th className="py-2 px-2">Matches</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validated.filter(r => r.status === 'duplicate').map((row, idx) => (
                        <tr key={idx} className="border-b border-border/50 align-top">
                          <td className="py-1.5 px-2 text-muted-foreground">{row.rowNum}</td>
                          <td className="py-1.5 px-2">{row.full_name}</td>
                          <td className="py-1.5 px-2">
                            {(row.duplicateOf ?? []).map((d, k) => <div key={k}>{d}</div>)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <DialogFooter className="gap-2">
              {(errorCount > 0 || failedCount > 0 || duplicateCount > 0) && (
                <Button variant="outline" onClick={downloadErrors} className="gap-1.5">
                  <FileText className="h-3.5 w-3.5" /> Download Error Report
                </Button>
              )}
              <Button
                onClick={() => handleOpenChange(false)}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Close
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
