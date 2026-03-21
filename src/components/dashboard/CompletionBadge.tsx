import { Badge } from '@/components/ui/badge';
import { CompletionProbability } from '@/lib/types';
import { completionStyles } from '@/lib/business-rules';

interface CompletionBadgeProps {
  probability: CompletionProbability;
  className?: string;
}

export default function CompletionBadge({ probability, className = '' }: CompletionBadgeProps) {
  const style = completionStyles[probability];
  return (
    <Badge variant="outline" className={`text-[10px] ${style.bg} ${style.text} ${style.border} ${className}`}>
      {style.label}
    </Badge>
  );
}
