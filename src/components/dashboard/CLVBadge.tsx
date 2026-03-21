import { Badge } from '@/components/ui/badge';
import { CLVTier } from '@/lib/types';
import { clvStyles } from '@/lib/business-rules';

interface CLVBadgeProps {
  tier: CLVTier;
  className?: string;
}

export default function CLVBadge({ tier, className = '' }: CLVBadgeProps) {
  const style = clvStyles[tier];
  return (
    <Badge variant="outline" className={`text-[10px] ${style.bg} ${style.text} ${style.border} ${className}`}>
      {tier === 'vip' ? '👑' : tier === 'gold' ? '⭐' : tier === 'silver' ? '🥈' : '🥉'} {style.label}
    </Badge>
  );
}
