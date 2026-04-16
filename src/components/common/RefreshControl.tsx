import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface RefreshControlProps {
  lastRefreshedAt: Date;
  refreshing: boolean;
  onRefresh: () => void;
  className?: string;
}

/**
 * Small "Last updated: HH:MM AM/PM" timestamp + a RefreshCw icon button.
 * Button spins while `refreshing` is true. Tooltip via title="Refresh data".
 */
export default function RefreshControl({
  lastRefreshedAt,
  refreshing,
  onRefresh,
  className,
}: RefreshControlProps) {
  const timeLabel = lastRefreshedAt.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
        Last updated: {timeLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRefresh}
        disabled={refreshing}
        title="Refresh data"
        className="h-7 w-7 text-muted-foreground hover:text-primary"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
      </Button>
    </div>
  );
}
