import { Hourglass } from 'lucide-react';
import { formatPHTDisplay } from '@/lib/date-utils';
import { formatReservationAge, reservationAutoCancelAt } from '@/lib/web-reservations';
import ReservationActions from './ReservationActions';

/**
 * The top-of-page panel on a web order or plan that is still a RESERVATION
 * (reserve-first A2). It cannot be scrolled past: the customer has no payment
 * details until someone here confirms the piece, and the order cancels itself
 * after 72 hours. Staff without confirm_web_order_ready see the state but no
 * buttons.
 */
export default function ReservationPanel({
  entityType, entityId, reference, createdAt, canAct,
}: {
  entityType: 'cash_order' | 'layaway';
  entityId: string;
  reference: string;
  createdAt: string | null | undefined;
  canAct: boolean;
}) {
  const cancelAt = reservationAutoCancelAt(createdAt);
  return (
    <div
      role="status"
      className="rounded-xl border-2 border-warning/60 bg-warning/10 p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Hourglass className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="space-y-1">
            <p className="font-deco text-lg font-semibold leading-tight text-champagne">
              Reservation — confirm the piece
            </p>
            <p className="text-xs text-muted-foreground">
              Reserved {formatReservationAge(createdAt)} ago. The customer has no payment details and no
              deadline until this is confirmed.
              {cancelAt && <> It cancels automatically on <strong>{formatPHTDisplay(cancelAt)}</strong> if nobody acts.</>}
            </p>
          </div>
        </div>
        {canAct ? (
          <div className="shrink-0">
            <ReservationActions entityType={entityType} entityId={entityId} reference={reference} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Ask an admin, staff or CSR member to confirm it.</p>
        )}
      </div>
    </div>
  );
}
