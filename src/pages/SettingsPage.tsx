import { Settings } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';

export default function SettingsPage() {
  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Settings className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Settings</h1>
            <p className="text-sm text-muted-foreground mt-0.5">System configuration</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">Settings panel coming soon. Connect Lovable Cloud to enable authentication, roles, and database.</p>
        </div>
      </div>
    </AppLayout>
  );
}
