import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { getPHTToday } from '@/lib/date-utils';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

export const SERVICE_TYPES = [
  'Ring Resize',
  'Certificate',
  'Repair',
  'Bracelet Resize',
  'Polishing',
  'Watch Polishing',
  'Color Change',
] as const;
export type ServiceType = typeof SERVICE_TYPES[number];

export const SERVICE_STATUSES = [
  'Process',
  'On-going',
  'Pending',
  'Cancelled',
  'Completed',
] as const;
export type ServiceStatus = typeof SERVICE_STATUSES[number];

export const UPDATED_BY_OPTIONS = [
  'Brenda',
  'Cris',
  'Kaila',
  'Richelle',
  'Gayle',
  'Antonette',
] as const;

export interface ServiceJobRow {
  id: string;
  date_received: string;
  invoice_number: string;
  account_type: string;
  customer_id: string | null;
  service_description: string | null;
  service_fee: number | null;
  service_type: ServiceType;
  service_status: ServiceStatus;
  notes: string | null;
  estimated_completion: string | null;
  date_completed: string | null;
  updated_by: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  customers?: { id: string; full_name: string } | null;
}

interface ServiceJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'add' | 'edit';
  initialJob?: ServiceJobRow | null;
}

// Ring resize fee table — derives fee from the size token in the description.
function ringResizeFee(sizeRaw: number): number | null {
  if (sizeRaw === 0) return null;
  if (sizeRaw > 0) {
    if (sizeRaw <= 4.5) return 1500;
    if (sizeRaw <= 5.5) return 2000;
    if (sizeRaw <= 6.5) return 2500;
    if (sizeRaw <= 7.5) return 3000;
    if (sizeRaw <= 8.5) return 3500;
    if (sizeRaw <= 9.5) return 4000;
    if (sizeRaw <= 10.5) return 4500;
    if (sizeRaw <= 11.5) return 5000;
    if (sizeRaw <= 12.5) return 5500;
    if (sizeRaw <= 13.5) return 6000;
    if (sizeRaw <= 14.5) return 6500;
    return 7000; // +15 and above
  }
  // Negative direction
  if (sizeRaw >= -8.5) return 1500;
  return null; // below -8.5, manual entry
}

function parseRingResizeSize(description: string): number | null {
  // Match +N or -N (optionally with decimals), e.g. +3.5, -2, +0.75
  const m = description.match(/([+-])\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const num = parseFloat(m[2]);
  if (!Number.isFinite(num)) return null;
  return sign * num;
}

// Add N working days to a YYYY-MM-DD date string (skip Sat + Sun), return YYYY-MM-DD.
function addWorkingDays(baseISO: string, days: number): string {
  const [y, m, d] = baseISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  let added = 0;
  while (added < days) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay(); // 0 Sun, 6 Sat
    if (dow !== 0 && dow !== 6) added++;
  }
  return dt.toISOString().slice(0, 10);
}

export default function ServiceJobDialog({
  open, onOpenChange, mode, initialJob,
}: ServiceJobDialogProps) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const isEdit = mode === 'edit';

  const [dateReceived, setDateReceived] = useState<string>(getPHTToday());
  const [invoiceNumber, setInvoiceNumber] = useState<string>('');
  const [serviceType, setServiceType] = useState<ServiceType | ''>('');
  const [serviceDescription, setServiceDescription] = useState<string>('');
  const [serviceFee, setServiceFee] = useState<string>('');
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('Process');
  const [notes, setNotes] = useState<string>('');
  const [estimatedCompletion, setEstimatedCompletion] = useState<string>('');
  const [dateCompleted, setDateCompleted] = useState<string>('');
  const [updatedBy, setUpdatedBy] = useState<string>('');

  // Invoice resolution state
  const [accountType, setAccountType] = useState<'layaway' | 'cash_order' | ''>('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string>('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string>('');

  // Reset on open / hydrate on edit
  useEffect(() => {
    if (!open) return;
    if (isEdit && initialJob) {
      setDateReceived(initialJob.date_received);
      setInvoiceNumber(initialJob.invoice_number);
      setServiceType(initialJob.service_type);
      setServiceDescription(initialJob.service_description ?? '');
      setServiceFee(initialJob.service_fee != null ? String(Math.round(Number(initialJob.service_fee))) : '');
      setServiceStatus(initialJob.service_status);
      setNotes(initialJob.notes ?? '');
      setEstimatedCompletion(initialJob.estimated_completion ?? '');
      setDateCompleted(initialJob.date_completed ?? '');
      setUpdatedBy(initialJob.updated_by ?? '');
      setAccountType((initialJob.account_type as 'layaway' | 'cash_order') ?? '');
      setCustomerId(initialJob.customer_id);
      setCustomerName(initialJob.customers?.full_name ?? '');
      setResolveError('');
    } else {
      setDateReceived(getPHTToday());
      setInvoiceNumber('');
      setServiceType('');
      setServiceDescription('');
      setServiceFee('');
      setServiceStatus('Process');
      setNotes('');
      setEstimatedCompletion('');
      setDateCompleted('');
      setUpdatedBy('');
      setAccountType('');
      setCustomerId(null);
      setCustomerName('');
      setResolveError('');
    }
  }, [open, isEdit, initialJob]);

  // Resolve invoice on blur / when typed
  const resolveInvoice = async (raw: string) => {
    const inv = raw.trim();
    if (!inv) {
      setAccountType('');
      setCustomerId(null);
      setCustomerName('');
      setResolveError('');
      return;
    }
    if (!/^[0-9]+$/.test(inv)) {
      setAccountType('');
      setCustomerId(null);
      setCustomerName('');
      setResolveError('Invoice # not found');
      return;
    }
    setResolving(true);
    setResolveError('');
    try {
      const [laRes, coRes] = await Promise.all([
        supabase
          .from('layaway_accounts')
          .select('customer_id, customers:customer_id (full_name)')
          .eq('invoice_number', inv)
          .maybeSingle(),
        supabase
          .from('cash_orders')
          .select('customer_id, customers:customer_id (full_name)')
          .eq('invoice_number', inv)
          .maybeSingle(),
      ]);

      const la = laRes.data as { customer_id: string | null; customers: { full_name: string } | null } | null;
      const co = coRes.data as { customer_id: string | null; customers: { full_name: string } | null } | null;

      if (la) {
        setAccountType('layaway');
        setCustomerId(la.customer_id);
        setCustomerName(la.customers?.full_name ?? '');
      } else if (co) {
        setAccountType('cash_order');
        setCustomerId(co.customer_id);
        setCustomerName(co.customers?.full_name ?? '');
      } else {
        setAccountType('');
        setCustomerId(null);
        setCustomerName('');
        setResolveError('Invoice # not found');
      }
    } catch (err) {
      setResolveError('Lookup failed: ' + ((err as Error).message || String(err)));
    } finally {
      setResolving(false);
    }
  };

  // Service Type → fee auto-fill
  const applyServiceTypeDefaults = (nextType: ServiceType) => {
    let fee: string = serviceFee;
    if (nextType === 'Certificate') fee = '880';
    else if (nextType === 'Polishing') fee = '2100';
    else if (nextType === 'Watch Polishing') fee = '10000';
    else if (nextType === 'Repair') fee = '3500';
    else if (nextType === 'Bracelet Resize' || nextType === 'Color Change') fee = '';
    else if (nextType === 'Ring Resize') {
      const size = parseRingResizeSize(serviceDescription);
      if (size != null) {
        const f = ringResizeFee(size);
        fee = f != null ? String(f) : '';
      } else {
        fee = '';
      }
    }
    setServiceFee(fee);
  };

  const handleServiceTypeChange = (nextType: ServiceType) => {
    setServiceType(nextType);
    applyServiceTypeDefaults(nextType);
  };

  // Ring Resize description-blur fee recalc
  const handleDescriptionBlur = () => {
    if (serviceType !== 'Ring Resize') return;
    const size = parseRingResizeSize(serviceDescription);
    if (size == null) return; // no match → leave fee as-is
    const f = ringResizeFee(size);
    if (f != null) setServiceFee(String(f));
  };

  // Status side-effects
  const handleStatusChange = (next: ServiceStatus) => {
    setServiceStatus(next);
    if (next === 'On-going') {
      const base = dateReceived || getPHTToday();
      setEstimatedCompletion(addWorkingDays(base, 7));
    } else if (next === 'Completed') {
      setDateCompleted(getPHTToday());
    } else {
      setDateCompleted('');
    }
  };

  const canSave = useMemo(() => {
    if (!invoiceNumber.trim()) return false;
    if (resolveError) return false;
    if (!accountType) return false;
    if (!serviceType) return false;
    if (!serviceDescription.trim()) return false;
    if (!updatedBy) return false;
    return true;
  }, [invoiceNumber, resolveError, accountType, serviceType, serviceDescription, updatedBy]);

  const mutation = useMutation({
    mutationFn: async () => {
      const feeNum = serviceFee === '' ? null : Math.round(Number(serviceFee));
      const basePayload = {
        date_received: dateReceived,
        invoice_number: invoiceNumber.trim(),
        account_type: accountType,
        customer_id: customerId,
        service_description: serviceDescription.trim() || null,
        service_fee: feeNum,
        service_type: serviceType as ServiceType,
        service_status: serviceStatus,
        notes: notes.trim() || null,
        estimated_completion: estimatedCompletion || null,
        date_completed: dateCompleted || null,
        updated_by: updatedBy,
      };
      if (isEdit && initialJob) {
        const { error } = await supabase
          .from('service_jobs')
          .update({ ...basePayload, updated_at: new Date().toISOString() })
          .eq('id', initialJob.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('service_jobs')
          .insert({ ...basePayload, created_by_user_id: user?.id ?? null });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('Service job saved');
      qc.invalidateQueries({ queryKey: ['service-jobs'] });
      qc.invalidateQueries({ queryKey: ['service-jobs-by-invoice'] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error('Save failed', { description: err.message });
    },
  });

  const invoiceRef = useRef<HTMLInputElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Service Job' : 'New Service Job'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update an existing service job entry.' : 'Record a new service job against an existing invoice.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="date_received">Date Received</Label>
              <Input
                id="date_received"
                type="date"
                value={dateReceived}
                onChange={(e) => setDateReceived(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="invoice_number">Invoice #</Label>
              <Input
                id="invoice_number"
                ref={invoiceRef}
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                onBlur={() => resolveInvoice(invoiceNumber)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    resolveInvoice(invoiceNumber);
                  }
                }}
                placeholder="e.g. 19105"
                disabled={isEdit}
              />
              <div className="mt-1 min-h-[18px] text-xs">
                {resolving && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Resolving…
                  </span>
                )}
                {!resolving && customerName && (
                  <span className="inline-flex items-center gap-1 text-emerald-500">
                    <CheckCircle2 className="h-3 w-3" /> {customerName}
                    <span className="text-muted-foreground ml-1">({accountType === 'layaway' ? 'Layaway' : 'Cash Order'})</span>
                  </span>
                )}
                {!resolving && resolveError && (
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <XCircle className="h-3 w-3" /> {resolveError}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Service Type</Label>
              <Select value={serviceType} onValueChange={(v) => handleServiceTypeChange(v as ServiceType)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select service type" />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Service Fee (¥)</Label>
              <Input
                inputMode="numeric"
                placeholder="0"
                value={serviceFee}
                onChange={(e) => setServiceFee(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="service_description">Service Description</Label>
            <Input
              id="service_description"
              value={serviceDescription}
              onChange={(e) => setServiceDescription(e.target.value)}
              onBlur={handleDescriptionBlur}
              placeholder={serviceType === 'Ring Resize' ? 'e.g. Ring resize +3.5 → 7.5' : 'Describe the service'}
            />
            {serviceType === 'Ring Resize' && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Include the size change as <code>+N</code> or <code>-N</code> (decimals OK) — fee auto-fills on blur.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>Service Status</Label>
              <Select value={serviceStatus} onValueChange={(v) => handleStatusChange(v as ServiceStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="estimated_completion">Estimated Completion</Label>
              <Input
                id="estimated_completion"
                type="date"
                value={estimatedCompletion}
                onChange={(e) => setEstimatedCompletion(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="date_completed">Date Completed</Label>
              <Input
                id="date_completed"
                type="date"
                value={dateCompleted}
                onChange={(e) => setDateCompleted(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="notes">Notes / Issues</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional notes or issues encountered"
            />
          </div>

          <div>
            <Label>Updated By</Label>
            <Select value={updatedBy} onValueChange={setUpdatedBy}>
              <SelectTrigger>
                <SelectValue placeholder="Select staff member" />
              </SelectTrigger>
              <SelectContent>
                {UPDATED_BY_OPTIONS.map((u) => (
                  <SelectItem key={u} value={u}>{u}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!canSave || mutation.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {mutation.isPending ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Service Job')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
