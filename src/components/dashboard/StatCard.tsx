import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: LucideIcon;
  trend?: { value: string; positive: boolean };
  variant?: 'default' | 'gold' | 'success' | 'warning' | 'danger';
}

const variantStyles = {
  default: 'bg-card border-border',
  gold: 'bg-card border-primary/30',
  success: 'bg-card border-success/30',
  warning: 'bg-card border-warning/30',
  danger: 'bg-card border-destructive/30',
};

const iconVariantStyles = {
  default: 'bg-secondary text-secondary-foreground',
  gold: 'gold-gradient text-primary-foreground',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-destructive/10 text-destructive',
};

export default function StatCard({ title, value, subtitle, icon: Icon, trend, variant = 'default' }: StatCardProps) {
  return (
    <div className={`rounded-xl border p-5 card-hover ${variantStyles[variant]}`}>
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
          <p className="text-2xl font-bold text-card-foreground font-display">{value}</p>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          {trend && (
            <p className={`text-xs font-medium ${trend.positive ? 'text-success' : 'text-destructive'}`}>
              {trend.positive ? '↑' : '↓'} {trend.value}
            </p>
          )}
        </div>
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconVariantStyles[variant]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}
