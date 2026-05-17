import { useNavigate } from 'react-router-dom';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Receipt, User as UserIcon } from 'lucide-react';
import type { LoyaltyTransactionRow } from '@/hooks/loyalty-admin/useLoyaltyTransactions';

const POSITIVE_TYPES = new Set(['earned', 'bonus', 'birthday_bonus']);

function isPositive(row: LoyaltyTransactionRow): boolean {
  if (row.transaction_type === 'adjusted') return row.points_amount >= 0;
  return POSITIVE_TYPES.has(row.transaction_type);
}

function fmtPoints(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${Math.abs(n).toLocaleString('en-US')}`;
}

function fmtYen(n: number | null): string {
  if (n == null) return '—';
  return `¥${n.toLocaleString('en-US')}`;
}

function fmtFull(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between text-sm gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right break-all">{children}</span>
    </div>
  );
}

interface Props {
  transaction: LoyaltyTransactionRow | null;
  onClose: () => void;
}

export default function TransactionsDrawer({ transaction, onClose }: Props) {
  const navigate = useNavigate();

  const positive = transaction ? isPositive(transaction) : false;
  const pointsColor = positive ? 'text-emerald-600' : 'text-destructive';

  return (
    <Sheet open={!!transaction} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto"
      >
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-primary" />
            Transaction Details
          </SheetTitle>
        </SheetHeader>

        {transaction && (
          <div className="space-y-5 mt-5">
            {/* Header card */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                    positive
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
                      : 'border-destructive/30 bg-destructive/10 text-destructive'
                  }`}
                >
                  {transaction.transaction_type}
                </span>
                <span className={`text-sm font-semibold ${pointsColor}`}>
                  {fmtPoints(transaction.points_amount)} pts
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {fmtFull(transaction.created_at)}
              </div>
            </div>

            {/* Member */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5">
                <UserIcon className="h-3.5 w-3.5" />
                Member
              </p>
              <p className="text-sm font-medium">
                {transaction.customer_code ?? '—'}
                {transaction.customer_full_name
                  ? ` · ${transaction.customer_full_name}`
                  : ''}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onClose();
                  navigate('/loyalty?tab=members');
                }}
              >
                Open member profile
              </Button>
            </div>

            {/* Transaction */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                Transaction
              </p>
              <Row label="Type">{transaction.transaction_type}</Row>
              <Row label="Points">
                <span className={pointsColor}>
                  {fmtPoints(transaction.points_amount)}
                </span>
              </Row>
              {transaction.spend_amount_jpy != null && (
                <Row label="Spend (¥)">
                  {fmtYen(transaction.spend_amount_jpy)}
                </Row>
              )}
              {transaction.tier_at_time != null && (
                <Row label="Tier at time">{transaction.tier_at_time}</Row>
              )}
              {transaction.rate_snapshot != null && (
                <Row label="Rate snapshot">
                  {transaction.rate_snapshot}
                </Row>
              )}
              {transaction.invoice_number != null && (
                <Row label="Invoice">{transaction.invoice_number}</Row>
              )}
              <Row label="Created at">
                <span className="font-mono text-[11px]">
                  {fmtFull(transaction.created_at)}
                </span>
              </Row>
            </div>

            {/* Tier change highlight — parsed from the canonical notes
                format emitted by award-loyalty-points:
                "Tier upgraded: X → Y at N JPY cumulative spend".
                Falls back silently to the Notes section if the format
                doesn't match (parsing is best-effort, never throws). */}
            {transaction.transaction_type === 'tier_changed' &&
              (() => {
                const m = transaction.notes?.match(
                  /Tier upgraded:\s*(.+?)\s*→\s*(.+?)\s*at\s*([\d,]+)\s*JPY/i,
                );
                if (!m) return null;
                return (
                  <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-4 space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-purple-600 font-semibold">
                      Tier change
                    </p>
                    <p className="text-sm font-semibold">
                      {m[1]}{' '}
                      <span className="text-purple-600">→</span> {m[2]}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      at {m[3]} JPY cumulative spend
                    </p>
                  </div>
                );
              })()}

            {/* Source — only non-null */}
            {(transaction.account_id ||
              transaction.cash_order_id ||
              transaction.payment_id) && (
              <div className="rounded-xl border border-border bg-card p-4 space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  Source
                </p>
                {transaction.account_id && (
                  <Row label="Layaway account">
                    {transaction.invoice_number ? (
                      <a
                        className="text-primary hover:underline"
                        href={`/accounts/${transaction.invoice_number}`}
                      >
                        {transaction.invoice_number}
                      </a>
                    ) : (
                      <span className="font-mono text-[11px]">
                        {transaction.account_id}
                      </span>
                    )}
                  </Row>
                )}
                {transaction.cash_order_id && (
                  <Row label="Cash order">
                    {transaction.invoice_number ? (
                      <a
                        className="text-primary hover:underline"
                        href={`/cash-orders/${transaction.invoice_number}`}
                      >
                        {transaction.invoice_number}
                      </a>
                    ) : (
                      <span className="font-mono text-[11px]">
                        {transaction.cash_order_id}
                      </span>
                    )}
                  </Row>
                )}
                {transaction.payment_id && (
                  <Row label="Payment">
                    <span className="font-mono text-[11px]">
                      {transaction.payment_id}
                    </span>
                  </Row>
                )}
              </div>
            )}

            {/* Notes */}
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                Notes
              </p>
              {transaction.notes ? (
                <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 overflow-x-auto">
                  {transaction.notes}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground italic px-3 py-2 rounded-md border border-border bg-muted/30">
                  (none)
                </p>
              )}
            </div>

            {/* Raw IDs */}
            <details className="rounded-xl border border-border bg-card p-4">
              <summary className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold cursor-pointer">
                Raw IDs
              </summary>
              <div className="mt-3 space-y-2">
                <Row label="Transaction ID">
                  <span className="font-mono text-[11px]">
                    {transaction.id}
                  </span>
                </Row>
                <Row label="Member ID">
                  <span className="font-mono text-[11px]">
                    {transaction.member_id}
                  </span>
                </Row>
              </div>
            </details>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
