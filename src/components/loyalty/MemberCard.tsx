import { CSSProperties } from 'react';

const CG = "'Cormorant Garamond',Georgia,serif";

const COLORS = {
  goldHi: '#F4D78F',
  goldMid: '#D4AF37',
  goldLo: '#B8941F',
  inkDeep: '#3D2F0E',
  inkSoft: '#5C4A1F',
  warning: '#C46B1F',
} as const;

// Keyframes + scoped styles for the shimmer + damask layers. Rendered once per
// instance; duplicate <style> blocks are harmless (browser collapses them).
const STYLE_BLOCK = `
@keyframes member-card-shimmer {
  0%   { transform: translateX(-120%) skewX(-12deg); }
  100% { transform: translateX(220%)  skewX(-12deg); }
}
.member-card-shimmer-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  border-radius: inherit;
}
.member-card-shimmer-layer::before {
  content: '';
  position: absolute;
  top: -20%;
  bottom: -20%;
  width: 35%;
  left: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255,255,255,0) 25%,
    rgba(255,255,255,0.55) 50%,
    rgba(255,255,255,0) 75%,
    transparent 100%
  );
  filter: blur(8px);
  mix-blend-mode: screen;
  animation: member-card-shimmer 7s linear infinite;
}
.member-card-damask {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  opacity: 0.08;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'><g fill='none' stroke='%233D2F0E' stroke-width='0.6'><path d='M20 4 L36 20 L20 36 L4 20 Z'/><circle cx='20' cy='20' r='3'/></g></svg>");
  background-size: 48px 48px;
}
`;

export interface MemberCardProps {
  customerName: string;
  customerCode: string;
  tierName: string;
  isDowngraded?: boolean;
}

export function MemberCard({
  customerName,
  customerCode,
  tierName,
  isDowngraded = false,
}: MemberCardProps) {
  const cardStyle: CSSProperties = {
    background: `linear-gradient(135deg, ${COLORS.goldMid} 0%, ${COLORS.goldHi} 50%, ${COLORS.goldLo} 100%)`,
    border: '1px solid rgba(255,255,255,0.4)',
    boxShadow: '0 10px 40px rgba(212,175,55,0.3), 0 4px 12px rgba(0,0,0,0.1)',
    fontFamily: CG,
    color: COLORS.inkDeep,
  };

  const labelStyle: CSSProperties = {
    fontWeight: 700,
    color: COLORS.inkDeep,
    letterSpacing: '0.04em',
  };
  const valueStyle: CSSProperties = {
    fontWeight: 400,
    color: COLORS.inkDeep,
  };

  return (
    <div
      className="relative w-full max-w-md aspect-[1.586/1] rounded-2xl overflow-hidden"
      style={cardStyle}
      role="img"
      aria-label={`Cha Jewels Loyalty member card for ${customerName}, ${tierName} tier`}
    >
      <style>{STYLE_BLOCK}</style>

      <div className="member-card-damask" />
      <div className="member-card-shimmer-layer" />

      {/* Sparkle accents */}
      <div
        className="absolute left-3 top-2 text-[14px]"
        style={{ color: COLORS.inkSoft, opacity: 0.6 }}
        aria-hidden="true"
      >
        ✦
      </div>
      <div
        className="absolute right-3 top-2 text-[14px]"
        style={{ color: COLORS.inkSoft, opacity: 0.6 }}
        aria-hidden="true"
      >
        ✦
      </div>

      <div className="relative flex h-full flex-col px-5 py-4 sm:px-7 sm:py-5">
        {/* Header */}
        <div
          className="text-center"
          style={{
            fontSize: '13px',
            color: COLORS.inkSoft,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            fontWeight: 600,
          }}
        >
          ✨&nbsp;Cha Jewels Loyalty Member&nbsp;✨
        </div>

        {/* Ornamental divider */}
        <div
          className="mx-auto mt-2 h-px w-1/2"
          style={{
            background:
              'linear-gradient(90deg, transparent 0%, rgba(61,47,14,0.5) 50%, transparent 100%)',
          }}
        />

        {/* Body — Name / Member ID / Tier */}
        <div className="mt-3 flex flex-1 flex-col justify-center gap-1.5 text-[13px] sm:text-sm">
          <Row label="Name" value={customerName} labelStyle={labelStyle} valueStyle={valueStyle} />
          <Row
            label="Member ID"
            value={customerCode}
            labelStyle={labelStyle}
            valueStyle={{ ...valueStyle, fontFamily: 'monospace', letterSpacing: '0.04em' }}
          />
          <Row label="Tier" value={tierName} labelStyle={labelStyle} valueStyle={valueStyle} />
          {isDowngraded && (
            <div
              className="pl-[88px] text-[10px] italic"
              style={{ color: COLORS.warning, letterSpacing: '0.02em' }}
            >
              ⚠ Reduced from earned tier due to inactivity
            </div>
          )}
        </div>

        {/* Ornamental divider */}
        <div
          className="mx-auto mb-2 h-px w-1/3"
          style={{
            background:
              'linear-gradient(90deg, transparent 0%, rgba(61,47,14,0.4) 50%, transparent 100%)',
          }}
        />

        {/* Footer tagline */}
        <div
          className="text-center italic"
          style={{
            fontSize: '11px',
            color: COLORS.inkSoft,
            letterSpacing: '0.22em',
          }}
        >
          Luxury · Discipline · Investment
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  labelStyle,
  valueStyle,
}: {
  label: string;
  value: string;
  labelStyle: CSSProperties;
  valueStyle: CSSProperties;
}) {
  return (
    <div className="flex items-baseline">
      <span className="w-[88px] shrink-0" style={labelStyle}>
        {label}:
      </span>
      <span className="truncate" style={valueStyle}>
        {value}
      </span>
    </div>
  );
}

export default MemberCard;
