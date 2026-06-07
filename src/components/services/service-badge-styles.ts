import type { ServiceStatus, ServiceType } from './ServiceJobDialog';

// Theme-token-based badge classes — no hardcoded brand hex.
export function serviceStatusBadgeClass(status: ServiceStatus): string {
  switch (status) {
    case 'Process':
      return 'bg-muted/40 text-muted-foreground border-border';
    case 'On-going':
      return 'bg-blue-500/10 text-blue-500 border-blue-500/30';
    case 'Pending':
      return 'bg-amber-500/10 text-amber-500 border-amber-500/30';
    case 'Cancelled':
      return 'bg-destructive/10 text-destructive border-destructive/30';
    case 'Completed':
      return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30';
    default:
      return 'bg-muted/40 text-muted-foreground border-border';
  }
}

export function serviceTypeBadgeClass(type: ServiceType): string {
  // Calm, theme-token style — one accent variant per type for at-a-glance scan.
  switch (type) {
    case 'Ring Resize':
      return 'bg-primary/10 text-primary border-primary/30';
    case 'Certificate':
      return 'bg-amber-500/10 text-amber-500 border-amber-500/30';
    case 'Repair':
      return 'bg-orange-500/10 text-orange-500 border-orange-500/30';
    case 'Bracelet Resize':
      return 'bg-violet-500/10 text-violet-500 border-violet-500/30';
    case 'Polishing':
      return 'bg-sky-500/10 text-sky-500 border-sky-500/30';
    case 'Watch Polishing':
      return 'bg-cyan-500/10 text-cyan-500 border-cyan-500/30';
    case 'Color Change':
      return 'bg-pink-500/10 text-pink-500 border-pink-500/30';
    default:
      return 'bg-muted/40 text-muted-foreground border-border';
  }
}
