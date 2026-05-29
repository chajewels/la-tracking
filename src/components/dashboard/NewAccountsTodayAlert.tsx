import { Link } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';
import { Sparkles, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useNewLayawayTodayCount } from '@/hooks/useNewLayawayTodayCount';
import { useNewCashOrdersTodayCount } from '@/hooks/useNewCashOrdersTodayCount';

export default function NewAccountsTodayAlert() {
  const { count: newLayaway } = useNewLayawayTodayCount();
  const { count: newCash } = useNewCashOrdersTodayCount();

  if (newLayaway === 0 && newCash === 0) return null;

  const total = newLayaway + newCash;

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-display flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-warning" />
            New Accounts Today
          </CardTitle>
          <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20 text-xs">
            {total} new
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs py-1.5 border-b border-border/50 last:border-0">
          <p className={`font-medium ${newLayaway > 0 ? 'text-foreground' : 'text-muted-foreground/60'}`}>
            {newLayaway} new layaway accounts
          </p>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs py-1.5 border-b border-border/50 last:border-0">
          <p className={`font-medium ${newCash > 0 ? 'text-foreground' : 'text-muted-foreground/60'}`}>
            {newCash} new cash orders
          </p>
        </div>
        <div className="flex gap-2 mt-1">
          <Link to={ROUTES.CUSTOMERS} className="flex-1">
            <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs">
              View Layaway <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
          <Link to="/customers?tab=cash" className="flex-1">
            <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs">
              View Cash Orders <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
