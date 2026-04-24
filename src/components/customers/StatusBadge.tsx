import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type CashOrderStatus = 'pending' | 'completed' | 'cancelled' | string;

const statusStyles: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  completed: 'bg-success/10 text-success border-success/20',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

const statusLabel: Record<string, string> = {
  pending: 'Pending',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export default function StatusBadge({ status, className }: { status: CashOrderStatus; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px] shrink-0', statusStyles[status] || 'bg-muted text-muted-foreground border-border', className)}
    >
      {statusLabel[status] || status}
    </Badge>
  );
}
