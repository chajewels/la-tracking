import { Users, MessageCircle, ExternalLink } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { mockCustomers, mockAccounts } from '@/lib/mock-data';

const clvStyles = {
  high: 'bg-success/10 text-success border-success/20',
  medium: 'bg-warning/10 text-warning border-warning/20',
  low: 'bg-muted text-muted-foreground border-border',
};

export default function Customers() {
  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Customers</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{mockCustomers.length} registered customers</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Contact</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Accounts</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">CLV</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mockCustomers.map(c => {
                const accountCount = mockAccounts.filter(a => a.customer_id === c.id).length;
                return (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">
                          {c.name.charAt(0)}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-card-foreground">{c.name}</p>
                          {c.facebook_name && <p className="text-xs text-muted-foreground">@{c.facebook_name}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{c.phone || '—'}</td>
                    <td className="px-5 py-3 text-center text-sm text-card-foreground">{accountCount}</td>
                    <td className="px-5 py-3 text-center">
                      {c.clv_score && (
                        <Badge variant="outline" className={`text-[10px] ${clvStyles[c.clv_score]}`}>
                          {c.clv_score} value
                        </Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 text-center">
                      {c.messenger_link && (
                        <a href={c.messenger_link} target="_blank" rel="noopener noreferrer">
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-info">
                            <MessageCircle className="h-4 w-4" />
                          </Button>
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
