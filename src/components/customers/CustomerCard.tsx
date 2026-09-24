import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, MessageCircle, ChevronRight, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import LoyaltyTierBadge from '@/components/loyalty/LoyaltyTierBadge';
import Monogram from '@/components/shared/Monogram';
import { CustomerOrderPills } from '@/components/customers/CustomerDirectoryTable';

interface CustomerCardProps {
  customer: any;
  activeCount: number;
  completedCount: number;
  tierName?: string | null;
  onEdit: (c: any) => void;
}

// Phones (and the directory below the desktop breakpoint). The edit pencil is
// always shown on touch screens; only a fine pointer gets the hover reveal.
const CustomerCard = memo(function CustomerCard({ customer: c, activeCount, completedCount, tierName, onEdit }: CustomerCardProps) {
  return (
    <div className="rounded-xl border border-gold-500/15 bg-card p-4 sm:p-5 card-hover group">
      <div className="flex items-start justify-between gap-2 mb-3">
        <Link to={`/customers/${c.id}`} className="flex items-center gap-3 flex-1 min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Monogram name={c.full_name} size="sm" />
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-card-foreground transition-colors [@media(hover:hover)_and_(pointer:fine)]:group-hover:text-gold-300" title={c.full_name}>
                {c.full_name}
              </span>
              {tierName && <LoyaltyTierBadge tierName={tierName} className="shrink-0" />}
            </p>
            {c.facebook_name && (
              <p className="text-xs text-muted-foreground truncate" title={`@${c.facebook_name}`}>@{c.facebook_name}</p>
            )}
          </div>
        </Link>
        <Button
          variant="ghost" size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-gold-300 shrink-0 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onEdit(c)}
          aria-label={`Edit ${c.full_name}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground mb-3">
        {c.location && (
          <span className="flex min-w-0 items-center gap-1">
            <MapPin className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate">{c.location}</span>
          </span>
        )}
        {c.customer_code && (
          <span className="font-mono shrink-0">{c.customer_code}</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-3 hairline-t">
        <CustomerOrderPills activeCount={activeCount} completedCount={completedCount} />
        <div className="flex items-center gap-1">
          {c.messenger_link && (
            <a href={c.messenger_link} target="_blank" rel="noopener noreferrer" aria-label={`Messenger — ${c.full_name}`}>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-info" tabIndex={-1}>
                <MessageCircle className="h-3.5 w-3.5" />
              </Button>
            </a>
          )}
          <Link to={`/customers/${c.id}`} aria-label={`Open ${c.full_name}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" tabIndex={-1}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
});

export default CustomerCard;
