import { LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: LucideIcon;
  trend?: { value: string; positive: boolean };
  variant?: 'default' | 'gold' | 'success' | 'warning' | 'danger';
  href?: string;
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

const valueVariantStyles = {
  default: 'text-card-foreground',
  gold: 'gold-text',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

export default function StatCard({ title, value, subtitle, icon: Icon, trend, variant = 'default', href }: StatCardProps) {
  const navigate = useNavigate();

  return (
    <div
      className={`rounded-xl border p-4 sm:p-5 card-hover transition-all ${variantStyles[variant]} ${
        href ? 'cursor-pointer hover:ring-1 hover:ring-primary/40' : ''
      }`}
      onClick={href ? () => navigate(href) : undefined}
      role={href ? 'link' : undefined}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1.5 min-w-0 flex-1">
          <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider leading-tight">{title}</p>
          <p className={`text-xl sm:text-2xl font-bold font-display tabular-nums ${valueVariantStyles[variant]}`}>{value}</p>
          {subtitle && <p className="text-[10px] sm:text-xs text-muted-foreground truncate">{subtitle}</p>}
          {trend && (
            <p className={`text-xs font-medium ${trend.positive ? 'text-success' : 'text-destructive'}`}>
              {trend.positive ? '↑' : '↓'} {trend.value}
            </p>
          )}
        </div>
        <div className={`flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-lg shrink-0 ml-2 ${iconVariantStyles[variant]}`}>
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
      </div>
    </div>
  );
}
