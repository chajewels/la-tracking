import { Link } from 'react-router-dom';
import { CreditCard, ArrowRight, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/calculations';
import { usePendingSubmissions, usePendingSubmissionCount } from '@/hooks/use-pending-submissions';

export default function PendingSubmissionsAlert() {
  const { data: count } = usePendingSubmissionCount();
  const { data: submissions } = usePendingSubmissions(5);

  if (!count || count === 0) return null;

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-display flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-warning" />
            Pending Payment Submissions
          </CardTitle>
          <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20 text-xs">
            {count} pending
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {(submissions || []).map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-2 text-xs py-1.5 border-b border-border/50 last:border-0">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground truncate">{s.customer_name}</p>
              <p className="text-muted-foreground">
                INV #{s.invoice_number} · {s.payment_method}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-bold text-foreground tabular-nums">
                {formatCurrency(s.submitted_amount, s.currency as 'PHP' | 'JPY')}
              </p>
              <p className="text-muted-foreground flex items-center gap-1 justify-end">
                <Clock className="h-3 w-3" />
                {new Date(s.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </p>
            </div>
          </div>
        ))}
        <Link to="/payment-submissions">
          <Button variant="outline" size="sm" className="w-full gap-1.5 mt-1 text-xs">
            Review All Submissions <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
