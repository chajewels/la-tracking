import AppLayout from '@/components/layout/AppLayout';
import ActivityLogTab from '@/components/admin-audit/ActivityLogTab';

export default function AdminActivityLog() {
  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6 relative">
        <div className="absolute inset-0 -z-10 bg-zinc-950/90 backdrop-blur-sm rounded-xl pointer-events-none" />
        <div>
          <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-1">Admin</p>
          <h1 className="text-2xl font-bold text-foreground font-display">Admin Audit</h1>
          <p className="text-sm text-muted-foreground mt-1">Activity log of every staff, finance, and admin action — who did what, and when.</p>
        </div>
        <ActivityLogTab />
      </div>
    </AppLayout>
  );
}
