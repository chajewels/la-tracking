import { Wallet } from 'lucide-react';
import { pt } from '@/i18n/portal';

export interface StoreCreditLot {
  id: string;
  currency: 'JPY' | 'PHP';
  original_amount: number;
  remaining_amount: number;
  status: 'active' | 'consumed' | 'expired' | 'voided';
  source_type: 'cancelled_layaway' | 'cancelled_cash' | 'manual_admin';
  issued_at: string;
  expires_at: string;
}

export interface StoreCreditTxn {
  id: string;
  txn_type: 'issued' | 'redeemed' | 'expired' | 'voided' | 'adjusted';
  amount: number;
  currency: 'JPY' | 'PHP';
  balance_after: number | null;
  notes: string | null;
  created_at: string;
}

export interface PortalStoreCredit {
  balances: Record<string, number>;
  lots: StoreCreditLot[];
  transactions: StoreCreditTxn[];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
// Transactions that reduce the customer's available credit.
const NEGATIVE_TXN = new Set(['redeemed', 'expired', 'voided']);

// Mirrors CustomerPortal's fmt(): ¥ for JPY (no decimals), ₱ for PHP.
function money(amount: number, currency: string): string {
  const n = Number(amount);
  const isWhole = n % 1 === 0;
  if (currency === 'JPY') {
    return `¥${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }
  return `₱${n.toLocaleString('en-US', {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  })}`;
}

function expiryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

function txnDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Read-only store-credit summary for the portal Home tab (Maison light
 * theme). Balance is shown PER CURRENCY — JPY and PHP are never converted
 * or summed. Customers cannot spend credit here; staff apply it to an order.
 */
export default function StoreCreditCard({ storeCredit }: { storeCredit?: PortalStoreCredit }) {
  if (!storeCredit) return null;

  const lots = storeCredit.lots ?? [];
  const transactions = storeCredit.transactions ?? [];

  // Positive per-currency balances only. Zero rows are omitted.
  const currencyRows = Object.entries(storeCredit.balances ?? {})
    .filter(([, amt]) => Number(amt) > 0)
    .map(([currency, amt]) => [currency, Number(amt)] as [string, number]);

  // Never render an empty card for a customer who has never had credit.
  if (currencyRows.length === 0 && lots.length === 0) return null;

  const now = Date.now();

  // Soonest-expiring ACTIVE, UNEXPIRED lot drives the expiry line.
  const activeLots = lots
    .filter((l) => l.status === 'active' && new Date(l.expires_at).getTime() > now)
    .sort((a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime());
  const soonest = activeLots[0] ?? null;
  const soonestSoon =
    soonest != null && new Date(soonest.expires_at).getTime() - now <= THIRTY_DAYS_MS;

  const recentTxns = transactions.slice(0, 5);

  return (
    <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Wallet className="h-4 w-4 text-primary" />
        <h3 className="font-display text-base text-foreground">{pt('storeCredit.heading')}</h3>
      </div>

      {/* Per-currency balances — never combined */}
      {currencyRows.length > 0 && (
        <div className="space-y-3">
          {currencyRows.map(([currency, amount]) => (
            <div key={currency}>
              <p className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.15em' }}>
                {pt('storeCredit.available', { currency })}
              </p>
              <p className="font-display text-2xl text-foreground tabular-nums mt-0.5">
                {money(amount, currency)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Soonest expiry — warning styling when within 30 days */}
      {soonest && (
        <p className={`text-xs ${soonestSoon ? 'text-amber-600 font-medium' : 'text-muted-foreground'}`}>
          {pt('storeCredit.expiresLine', {
            amount: money(Number(soonest.remaining_amount), soonest.currency),
            date: expiryDate(soonest.expires_at),
          })}
        </p>
      )}

      {/* Recent history */}
      {recentTxns.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.15em' }}>
            {pt('storeCredit.history')}
          </p>
          <ul className="space-y-1.5">
            {recentTxns.map((t) => {
              const negative = NEGATIVE_TXN.has(t.txn_type);
              const amt = money(Number(t.amount), t.currency);
              return (
                <li key={t.id} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {txnDate(t.created_at)} · {pt(`storeCredit.type.${t.txn_type}`)}
                  </span>
                  <span className={`tabular-nums font-medium ${negative ? 'text-danger' : 'text-success'}`}>
                    {negative ? `−${amt}` : `+${amt}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground leading-relaxed">{pt('storeCredit.note')}</p>
    </div>
  );
}
