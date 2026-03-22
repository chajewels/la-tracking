import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, MessageCircle, ChevronRight, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CustomerCardProps {
  customer: any;
  activeCount: number;
  completedCount: number;
  onEdit: (c: any) => void;
}

const CustomerCard = memo(function CustomerCard({ customer: c, activeCount, completedCount, onEdit }: CustomerCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5 card-hover group animate-fade-in">
      <div className="flex items-start justify-between mb-3">
        <Link to={`/customers/${c.id}`} className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0">
            {c.full_name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-card-foreground truncate group-hover:text-primary transition-colors">
              {c.full_name}
            </p>
            {c.facebook_name && (
              <p className="text-xs text-muted-foreground truncate">@{c.facebook_name}</p>
            )}
          </div>
        </Link>
        <Button
          variant="ghost" size="icon"
          className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          onClick={() => onEdit(c)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
        {c.location && (
          <span className="flex items-center gap-1">
            <MapPin className="h-3 w-3" /> {c.location}
          </span>
        )}
        {c.customer_code && (
          <span className="font-mono">{c.customer_code}</span>
        )}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-border">
        <div className="flex items-center gap-3 text-xs">
          {activeCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/10 text-success font-medium">
              {activeCount} active
            </span>
          )}
          {completedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {completedCount} done
            </span>
          )}
          {activeCount === 0 && completedCount === 0 && (
            <span className="text-muted-foreground">No accounts</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {c.messenger_link && (
            <a href={c.messenger_link} target="_blank" rel="noopener noreferrer">
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-info">
                <MessageCircle className="h-3.5 w-3.5" />
              </Button>
            </a>
          )}
          <Link to={`/customers/${c.id}`}>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
});

export default CustomerCard;
