import { useId } from 'react';
import { chartColors } from '@/theme/tokens';

/**
 * Decorative micro-trend for KPI cards: single gold 2px line with a soft
 * area fill, no axes/grid (per the stat-tile spec — the tile's value carries
 * the number; the sparkline only shows shape). aria-hidden with an sr-only
 * description so screen readers aren't fed an unlabeled squiggle.
 */
interface SparklineProps {
  points: number[];
  /** Accessible one-liner, e.g. "Collections trend, last 6 months". */
  label: string;
  width?: number;
  height?: number;
}

export default function Sparkline({ points, label, width = 96, height = 28 }: SparklineProps) {
  const gradientId = useId();
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (points.length - 1);
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / span);
  const coords = points.map((v, i) => [pad + i * stepX, y(v)] as const);
  const line = coords.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = `${line} ${(pad + (points.length - 1) * stepX).toFixed(1)},${height} ${pad},${height}`;

  return (
    <span className="inline-block">
      <span className="sr-only">{label}</span>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={chartColors.primary} stopOpacity={0.28} />
            <stop offset="100%" stopColor={chartColors.primary} stopOpacity={0} />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gradientId})`} />
        <polyline
          points={line}
          fill="none"
          stroke={chartColors.primary}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
