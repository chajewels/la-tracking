import { useMemo, useState, type MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ExternalLink, Package } from 'lucide-react';

// Pancake holding area — unconfirmed Pancake POS orders.
// Orders NEVER auto-create accounts. Staff confirm the type here, and creation
// runs through the existing validated flows (/accounts/new, /cash-orders/new)
// so plan minimums, permissions, loyalty and is_test rules all still apply.

interface PancakeItem {
  quantity?: number;
  note_product?: string;
  variation_info?: { name?: string; retail_price?: number };
}

interface PancakeEventRow {
  id: string;
  pancake_order_id: string;
  event_updated_at: string;
  raw_payload: Record<string, unknown>;
}

interface PendingOrder {
  eventId: string;
  pancakeOrderId: string;
  customerName: string;
  phone: string;
  total: number;
  currency: string;
  orderDate: string;
  items: Array<{ name: string; qty: number }>;
  orderLink: string | null;
}

interface Props {
  embedded?: boolean;
  searchValue?: string;
  exportRef?: MutableRefObject<(() => void) | null>;
}

function num(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export default function PancakeOrdersList({ searchValue = '' }: Props) {
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: rows, isLoading, refetch } = useQuery({
    queryKey: ['pancake-pending-events'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('pancake_events')
        .select('id, pancake_order_id, event_updated_at, raw_payload')
        .eq('status', 'pending')
        .order('event_updated_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as PancakeEventRow[];
    },
  });

  // Newest event per order wins; only real orders (items AND total > 0) show.
  const orders = useMemo<PendingOrder[]>(() => {
    const seen = new Set<string>();
    const out: PendingOrder[] = [];
    for (const row of rows ?? []) {
      if (seen.has(row.pancake_order_id)) continue;
      seen.add(row.pancake_order_id);

      const p = (row.raw_payload ?? {}) as Record<string, any>;
      const rawItems: PancakeItem[] = Array.isArray(p.items) ? p.items : [];
      const total = num(p.total_price);
      if (rawItems.length === 0 || total <= 0) continue;
      if (Number(p.status) === 6) continue; // cancelled

      const cust = (p.customer ?? {}) as Record<string, any>;
      out.push({
        eventId: row.id,
        pancakeOrderId: row.pancake_order_id,
        customerName: String(p.bill_full_name ?? cust.name ?? 'Unknown'),
        phone: String(
          p.bill_phone_number ??
          p.shipping_address?.phone_number ??
          (Array.isArray(cust.phone_numbers) && cust.phone_numbers.length > 0 ? cust.phone_numbers[0] : '') ??
          '',
        ),
        total,
        currency: String(p.order_currency ?? 'JPY'),
        orderDate: String(p.inserted_at ?? '').split('T')[0],
        items: rawItems.map((it) => ({
          name: String(it?.variation_info?.name ?? it?.note_product ?? 'Item'),
          qty: num(it?.quantity) || 1,
        })),
        orderLink: typeof p.order_link === 'string' ? p.order_link : null,
      });
    }
    return out;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) =>
      o.customerName.toLowerCase().includes(q) ||
      o.phone.includes(q) ||
      o.pancakeOrderId.includes(q) ||
      o.items.some((i) => i.name.toLowerCase().includes(q)),
    );
  }, [orders, searchValue]);

  const confirm = (o: PendingOrder, type: 'cash' | 'layaway') => {
    setBusyId(o.eventId);
    const params = new URLSearchParams({
      customer_name: o.customerName,
      amount: String(o.total),
      currency: o.currency,
      pancake_order_id: o.pancakeOrderId,
    });
    navigate(`${type === 'cash' ? '/cash-orders/new' : '/accounts/new'}?${params.toString()}`);
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Loading Pancake orders…</p>;
  }

  if (filtered.length === 0) {
    return (
      <div className="py-12 text-center">
        <Package className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">No unconfirmed Pancake orders.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {filtered.length} unconfirmed order{filtered.length === 1 ? '' : 's'} from Pancake.
        Confirm each as Cash or Layaway — nothing is created until you do.
      </p>

      {filtered.map((o) => (
        <Card key={o.eventId} className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{o.customerName}</span>
                <Badge variant="outline">PKE-{o.pancakeOrderId}</Badge>
                {o.orderLink && (
                  <a
                    href={o.orderLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Pancake <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {o.phone || 'No phone'} · {o.orderDate}
              </p>
              <p className="text-sm text-muted-foreground truncate">
                {o.items.map((i) => `${i.name} x${i.qty}`).join(', ')}
              </p>
              <p className="text-sm font-semibold text-foreground">
                {o.currency} {o.total.toLocaleString()}
              </p>
            </div>

            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === o.eventId}
                onClick={() => confirm(o, 'cash')}
              >
                Confirm as Cash
              </Button>
              <Button
                size="sm"
                disabled={busyId === o.eventId}
                onClick={() => confirm(o, 'layaway')}
              >
                Confirm as Layaway
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
