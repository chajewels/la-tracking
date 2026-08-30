import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Truck, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { getPHTToday, formatPHTDisplay } from '@/lib/date-utils';

interface ShippingMethod {
  id: string;
  provider_name: string;
  title: string;
  tracking_url_template: string;
  supports_deeplink: boolean | null;
}

interface ShipmentTrackingCardProps {
  kind: 'layaway' | 'cash_order';
  recordId: string;
  trackingNumber: string | null;
  shippingMethodId: string | null;
  shippedAt: string | null;
  trackingUpdatedAt: string | null;
  canEdit: boolean;
  onSaved: () => void;
}

export default function ShipmentTrackingCard({
  kind,
  recordId,
  trackingNumber,
  shippingMethodId,
  shippedAt,
  trackingUpdatedAt,
  canEdit,
  onSaved,
}: ShipmentTrackingCardProps) {
  const [editing, setEditing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [saving, setSaving] = useState(false);
  const [methodId, setMethodId] = useState<string>(shippingMethodId ?? '');
  const [numberInput, setNumberInput] = useState<string>(trackingNumber ?? '');
  const [shipDate, setShipDate] = useState<string>(
    (shippedAt ?? '').slice(0, 10) || getPHTToday(),
  );

  const { data: methods = [] } = useQuery<ShippingMethod[]>({
    queryKey: ['shipping-methods'],
    staleTime: 300_000, // carriers change rarely
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shipping_methods')
        .select('id, provider_name, title, tracking_url_template, supports_deeplink')
        .eq('is_active', true)
        .order('provider_name', { ascending: true })
        .order('title', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ShippingMethod[];
    },
  });

  const activeMethod = useMemo(
    () => methods.find((m) => m.id === shippingMethodId) ?? null,
    [methods, shippingMethodId],
  );

  const hasTracking = !!trackingNumber && !!shippingMethodId;

  // Deep link only when the carrier's template carries the placeholder;
  // otherwise the template is a landing page and the number is shown for
  // manual entry.
  const trackUrl = useMemo(() => {
    if (!activeMethod || !trackingNumber) return null;
    return activeMethod.supports_deeplink
      ? activeMethod.tracking_url_template.replace(
          '{tracking_code}',
          encodeURIComponent(trackingNumber),
        )
      : activeMethod.tracking_url_template;
  }, [activeMethod, trackingNumber]);

  // DB constraint: (tracking_number IS NULL) = (shipping_method_id IS NULL).
  // Save stays disabled until BOTH are present so we can never write half a pair.
  const canSave = !!methodId && numberInput.trim().length > 0;

  const openEditor = () => {
    setMethodId(shippingMethodId ?? '');
    setNumberInput(trackingNumber ?? '');
    setShipDate((shippedAt ?? '').slice(0, 10) || getPHTToday());
    setConfirmingClear(false);
    setEditing(true);
  };

  // order_tracking_history.changed_by is NOT NULL — without a signed-in user
  // we cannot attribute the change, so we refuse rather than fail at insert.
  const currentUserId = async (): Promise<string | null> => {
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  };

  const handleSave = async () => {
    const trimmed = numberInput.trim();
    if (!methodId || !trimmed) return; // constraint 1, belt-and-braces
    setSaving(true);
    try {
      const uid = await currentUserId();
      if (!uid) {
        toast.error('You must be signed in to record tracking.');
        return;
      }

      const payload = {
        shipping_method_id: methodId,
        tracking_number: trimmed,
        shipped_at: shipDate || null,
        tracking_set_by: uid,
        tracking_updated_at: new Date().toISOString(),
      };
      const { error: updateError } = kind === 'layaway'
        ? await supabase.from('layaway_accounts').update(payload).eq('id', recordId)
        : await supabase.from('cash_orders').update(payload).eq('id', recordId);
      if (updateError) {
        toast.error(updateError.message);
        return;
      }

      // XOR constraint: exactly one parent id, never both, never neither.
      // changed_at is left to the column default.
      const { error: historyError } = await supabase
        .from('order_tracking_history')
        .insert({
          account_id: kind === 'layaway' ? recordId : null,
          cash_order_id: kind === 'cash_order' ? recordId : null,
          tracking_number: trimmed,
          shipping_method_id: methodId,
          action: trackingNumber ? 'updated' : 'set',
          changed_by: uid,
        });
      if (historyError) {
        toast.error(historyError.message);
        return;
      }

      toast.success(trackingNumber ? 'Tracking updated' : 'Tracking added');
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error((err as Error).message || 'Failed to save tracking');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const uid = await currentUserId();
      if (!uid) {
        toast.error('You must be signed in to clear tracking.');
        return;
      }

      // All three null together — never one alone (constraint 1).
      const payload = {
        shipping_method_id: null,
        tracking_number: null,
        shipped_at: null,
        tracking_set_by: uid,
        tracking_updated_at: new Date().toISOString(),
      };
      const { error: updateError } = kind === 'layaway'
        ? await supabase.from('layaway_accounts').update(payload).eq('id', recordId)
        : await supabase.from('cash_orders').update(payload).eq('id', recordId);
      if (updateError) {
        toast.error(updateError.message);
        return;
      }

      // Record WHAT was removed, so the trail is readable after the fact.
      const { error: historyError } = await supabase
        .from('order_tracking_history')
        .insert({
          account_id: kind === 'layaway' ? recordId : null,
          cash_order_id: kind === 'cash_order' ? recordId : null,
          tracking_number: trackingNumber,
          shipping_method_id: shippingMethodId,
          action: 'cleared',
          changed_by: uid,
        });
      if (historyError) {
        toast.error(historyError.message);
        return;
      }

      toast.success('Tracking cleared');
      setConfirmingClear(false);
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error((err as Error).message || 'Failed to clear tracking');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
          <Truck className="h-4 w-4 text-primary" /> Shipment Tracking
        </h3>
        {canEdit && !editing && (
          <Button variant="outline" size="sm" onClick={openEditor}>
            {hasTracking ? 'Edit' : 'Add tracking'}
          </Button>
        )}
      </div>

      {!editing && (
        <>
          {hasTracking ? (
            <div className="space-y-1.5 text-sm">
              <div className="text-card-foreground">
                {activeMethod?.title ?? 'Carrier'}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="tabular-nums text-card-foreground">{trackingNumber}</span>
                {trackUrl && (
                  <a
                    href={trackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {activeMethod?.supports_deeplink ? 'Track parcel' : "Carrier's tracking page"}
                  </a>
                )}
              </div>
              {activeMethod && !activeMethod.supports_deeplink && (
                <p className="text-[11px] text-muted-foreground">
                  This carrier has no direct link yet — enter the number above on their page.
                </p>
              )}
              {shippedAt && (
                <div className="text-xs text-muted-foreground">
                  Shipped {String(shippedAt).slice(0, 10)}
                </div>
              )}
              {trackingUpdatedAt && (
                <div className="text-xs text-muted-foreground">
                  Updated {formatPHTDisplay(trackingUpdatedAt)}
                </div>
              )}
              {canEdit && (
                <div className="pt-2">
                  {confirmingClear ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Remove the carrier and tracking number?
                      </span>
                      <Button
                        size="sm"
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        disabled={saving}
                        onClick={handleClear}
                      >
                        {saving ? 'Clearing…' : 'Yes, clear'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saving}
                        onClick={() => setConfirmingClear(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-destructive/30 text-destructive hover:bg-destructive/10"
                      onClick={() => setConfirmingClear(true)}
                    >
                      Clear tracking
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No tracking information</p>
          )}
        </>
      )}

      {editing && (
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Carrier</Label>
            <Select value={methodId} onValueChange={setMethodId}>
              <SelectTrigger className="h-9 text-sm bg-background">
                <SelectValue placeholder="Select a carrier" />
              </SelectTrigger>
              <SelectContent>
                {methods.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="tracking-number" className="text-xs text-muted-foreground">
              Tracking number
            </Label>
            <Input
              id="tracking-number"
              value={numberInput}
              onChange={(e) => setNumberInput(e.target.value)}
              placeholder="e.g. EE123456789JP"
              className="h-9 text-sm tabular-nums"
            />
          </div>
          <div>
            <Label htmlFor="shipped-at" className="text-xs text-muted-foreground">
              Shipped date
            </Label>
            <Input
              id="shipped-at"
              type="date"
              value={shipDate}
              onChange={(e) => setShipDate(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" disabled={!canSave || saving} onClick={handleSave}>
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => { setEditing(false); setConfirmingClear(false); }}
            >
              Cancel
            </Button>
          </div>
          {!canSave && (
            <p className="text-[11px] text-muted-foreground">
              A carrier and a tracking number are both required — they are stored together.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
