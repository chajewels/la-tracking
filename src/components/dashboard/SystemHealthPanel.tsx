import { Activity, Gavel, Scale, Bell, XCircle } from 'lucide-react';

interface SystemHealthProps {
  summary: any;
}

export default function SystemHealthPanel({ summary }: SystemHealthProps) {
  const stats = [
    { label: 'Penalties Applied', value: summary?.total_penalties_applied ?? 0, icon: Gavel, color: 'text-destructive' },
    { label: 'Penalties Waived', value: summary?.total_penalties_waived ?? 0, icon: Scale, color: 'text-warning' },
    { label: 'Reminders Sent', value: summary?.reminder_total ?? 0, icon: Bell, color: 'text-info' },
    { label: 'Reminders Failed', value: summary?.reminder_failed ?? 0, icon: XCircle, color: 'text-destructive' },
  ];

  const successRate = summary?.reminder_total > 0
    ? Math.round((summary.reminder_success / summary.reminder_total) * 100)
    : 100;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-card-foreground">System Health</h3>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        {stats.map(s => (
          <div key={s.label} className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
            <s.icon className={`h-3.5 w-3.5 ${s.color}`} />
            <div>
              <p className="text-sm font-bold text-card-foreground">{s.value}</p>
              <p className="text-[10px] text-muted-foreground">{s.label}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between p-2 rounded-lg bg-muted/30">
        <span className="text-xs text-muted-foreground">Reminder Success Rate</span>
        <span className={`text-sm font-bold ${successRate >= 90 ? 'text-success' : successRate >= 70 ? 'text-warning' : 'text-destructive'}`}>
          {successRate}%
        </span>
      </div>
    </div>
  );
}
