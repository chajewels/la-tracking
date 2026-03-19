import { ShieldAlert, TrendingUp, Crown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router-dom';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';

export function LatePaymentRiskPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['risk-panel'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customer_analytics')
        .select('*, customers(*)')
        .order('late_payment_risk_score', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
  });

  const items = data || [];
  const high = items.filter(i => i.late_payment_risk_level === 'high');
  const medium = items.filter(i => i.late_payment_risk_level === 'medium');
  const low = items.filter(i => i.late_payment_risk_level === 'low');

  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <ShieldAlert className="h-4 w-4 text-destructive" />
        <h3 className="text-sm font-semibold text-card-foreground">Late Payment Risk</h3>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="text-center p-2 rounded-lg bg-destructive/5">
          <p className="text-xl font-bold text-destructive">{high.length}</p>
          <p className="text-[10px] text-muted-foreground">High Risk</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-warning/5">
          <p className="text-xl font-bold text-warning">{medium.length}</p>
          <p className="text-[10px] text-muted-foreground">Medium</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-success/5">
          <p className="text-xl font-bold text-success">{low.length}</p>
          <p className="text-[10px] text-muted-foreground">Low</p>
        </div>
      </div>
      {high.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">High Risk Customers</p>
          {high.slice(0, 5).map((c: any) => (
            <Link key={c.id} to={`/customers/${c.customer_id}`} className="flex items-center justify-between text-xs p-2 rounded-lg hover:bg-muted/50">
              <span className="text-card-foreground font-medium">{c.customers?.full_name || 'Unknown'}</span>
              <Badge variant="outline" className="text-[10px] text-destructive border-destructive/20">
                {Math.round(c.late_payment_risk_score ?? 0)}% risk
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function CompletionProbabilityPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['completion-panel'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customer_analytics')
        .select('*, customers(*)')
        .order('completion_probability_score', { ascending: true })
        .limit(20);
      if (error) throw error;
      return data;
    },
  });

  const items = data || [];
  const likelyComplete = items.filter(i => (i.completion_probability_score ?? 0) >= 70);
  const likelyCancel = items.filter(i => (i.completion_probability_score ?? 0) < 40);

  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="h-4 w-4 text-success" />
        <h3 className="text-sm font-semibold text-card-foreground">Completion Probability</h3>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="text-center p-2 rounded-lg bg-success/5">
          <p className="text-xl font-bold text-success">{likelyComplete.length}</p>
          <p className="text-[10px] text-muted-foreground">Likely Complete</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-destructive/5">
          <p className="text-xl font-bold text-destructive">{likelyCancel.length}</p>
          <p className="text-[10px] text-muted-foreground">At Risk</p>
        </div>
      </div>
      {likelyCancel.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">At-Risk Accounts</p>
          {likelyCancel.slice(0, 5).map((c: any) => (
            <Link key={c.id} to={`/customers/${c.customer_id}`} className="flex items-center justify-between text-xs p-2 rounded-lg hover:bg-muted/50">
              <span className="text-card-foreground font-medium">{c.customers?.full_name || 'Unknown'}</span>
              <Badge variant="outline" className="text-[10px] text-warning border-warning/20">
                {Math.round(c.completion_probability_score ?? 0)}%
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function CLVPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['clv-panel'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customer_analytics')
        .select('*, customers(*)')
        .order('lifetime_value_amount', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
  });

  const items = data || [];
  const vip = items.filter(i => i.lifetime_value_tier === 'vip');
  const gold = items.filter(i => i.lifetime_value_tier === 'gold');

  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Crown className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-card-foreground">Customer Value (CLV)</h3>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="text-center p-2 rounded-lg bg-primary/5">
          <p className="text-xl font-bold text-primary">{vip.length}</p>
          <p className="text-[10px] text-muted-foreground">VIP</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-warning/5">
          <p className="text-xl font-bold text-warning">{gold.length}</p>
          <p className="text-[10px] text-muted-foreground">Gold</p>
        </div>
      </div>
      {[...vip, ...gold].slice(0, 5).length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Top Customers</p>
          {[...vip, ...gold].slice(0, 5).map((c: any) => (
            <Link key={c.id} to={`/customers/${c.customer_id}`} className="flex items-center justify-between text-xs p-2 rounded-lg hover:bg-muted/50">
              <span className="text-card-foreground font-medium">{c.customers?.full_name || 'Unknown'}</span>
              <Badge variant="outline" className={`text-[10px] ${
                c.lifetime_value_tier === 'vip' ? 'text-primary border-primary/20' : 'text-warning border-warning/20'
              }`}>
                {(c.lifetime_value_tier || 'bronze').toUpperCase()}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
