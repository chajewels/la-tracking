import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { palette, hslTriplets } from '@/theme/portal-tokens';

// Maison inline-style palette — mirrors the `M` objects in CustomerPortal.tsx
// and CashOrdersSection.tsx. Sourced from portal-tokens.ts (single token
// source) so no gold hex is typed here.
const M = {
  s2: palette.surface2,
  br: `hsl(${hslTriplets.gold600} / 0.18)`,
  gp: palette.gold600,
  tp: palette.ink,
  ts: palette.inkMuted,
  success: palette.success,
} as const;

interface PortalShippingMethod {
  id: string;
  provider_name: string;
  title: string;
  tracking_url_template: string;
  supports_deeplink: boolean | null;
}

// Shared by the layaway account card and the cash order card so both surfaces
// stay identical by construction. The query key is shared too, so the carrier
// list is fetched once no matter how many cards render.
export function usePortalShippingMethods() {
  return useQuery<PortalShippingMethod[]>({
    queryKey: ['portal-shipping-methods'],
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shipping_methods')
        .select('id, provider_name, title, tracking_url_template, supports_deeplink')
        .eq('is_active', true)
        .order('provider_name', { ascending: true })
        .order('title', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PortalShippingMethod[];
    },
  });
}

function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

interface PortalTrackingRowProps {
  trackingNumber?: string | null;
  shippingMethodId?: string | null;
  shippedAt?: string | null;
}

export default function PortalTrackingRow({
  trackingNumber,
  shippingMethodId,
  shippedAt,
}: PortalTrackingRowProps) {
  const { data: methods = [] } = usePortalShippingMethods();

  // Nothing to show until a tracking number exists — no empty state.
  if (!trackingNumber) return null;

  const method = methods.find((m) => m.id === shippingMethodId) ?? null;

  // Deep link when the carrier's template carries the placeholder; otherwise
  // send them to the carrier's landing page. Either way the number is on
  // screen and selectable for manual entry.
  const trackUrl = method
    ? (method.supports_deeplink
        ? method.tracking_url_template.replace('{tracking_code}', encodeURIComponent(trackingNumber))
        : method.tracking_url_template)
    : null;

  return (
    <div
      className="mt-3"
      style={{ background: M.s2, border: `1px solid ${M.br}`, borderRadius: '8px', padding: '10px 12px' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '9px', fontWeight: 500, letterSpacing: '0.25em', textTransform: 'uppercase' as const, color: M.ts, marginBottom: '4px' }}>
            Tracking number
          </p>
          <p
            className="tabular-nums select-all break-all"
            style={{ fontFamily: 'Inter,sans-serif', fontSize: '13px', fontWeight: 600, color: M.tp, lineHeight: 1.3 }}
          >
            {trackingNumber}
          </p>
          {method && (
            <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '11px', color: M.ts, marginTop: '2px' }}>
              {method.title}
            </p>
          )}
        </div>
        {trackUrl && (
          <a
            href={trackUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0"
            style={{
              fontFamily: 'Inter,sans-serif',
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              color: M.gp,
              border: `1px solid hsl(${hslTriplets.gold600} / 0.35)`,
              borderRadius: '999px',
              padding: '4px 12px',
              background: 'transparent',
              whiteSpace: 'nowrap',
            }}
          >
            Track
          </a>
        )}
      </div>
      {shippedAt && (
        <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '11px', color: M.success, marginTop: '6px' }}>
          Shipped {fmtDate(shippedAt)}
        </p>
      )}
    </div>
  );
}
