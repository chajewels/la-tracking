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

// The carrier arrives already resolved on the account/order payload. It is
// NOT read from the client: shipping_methods is `FOR SELECT TO authenticated`,
// and a portal-token customer is anon, so a browser query returns zero rows
// and the Track button would never render. customer-portal resolves it
// service-side after verifying the token.
export interface PortalShippingMethod {
  id: string;
  provider_name: string;
  title: string;
  tracking_url_template: string;
  supports_deeplink: boolean | null;
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
  shippingMethod?: PortalShippingMethod | null;
  shippedAt?: string | null;
}

export default function PortalTrackingRow({
  trackingNumber,
  shippingMethod,
  shippedAt,
}: PortalTrackingRowProps) {
  // Nothing to show until a tracking number exists — no empty state.
  if (!trackingNumber) return null;

  const method = shippingMethod ?? null;

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
            // The enclosing card is clickable and opens account history —
            // without this the click falls through and the carrier page never opens.
            onClick={(e) => e.stopPropagation()}
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
