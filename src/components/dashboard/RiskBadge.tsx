import { Badge } from '@/components/ui/badge';
import { RiskLevel } from '@/lib/types';
import { riskStyles } from '@/lib/analytics-engine';

interface RiskBadgeProps {
  level: RiskLevel;
  showEmoji?: boolean;
  className?: string;
}

export default function RiskBadge({ level, showEmoji = true, className = '' }: RiskBadgeProps) {
  const style = riskStyles[level];
  return (
    <Badge variant="outline" className={`text-[10px] ${style.bg} ${style.text} ${style.border} ${className}`}>
      {showEmoji && <span className="mr-1">{style.emoji}</span>}
      {style.label}
    </Badge>
  );
}
