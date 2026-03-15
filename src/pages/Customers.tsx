import { Users, MessageCircle } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import CLVBadge from '@/components/dashboard/CLVBadge';
import RiskBadge from '@/components/dashboard/RiskBadge';
import { mockCustomers, mockAccounts } from '@/lib/mock-data';
import { assessCustomerCLV, assessAccountRisk } from '@/lib/analytics-engine';
import { Link } from 'react-router-dom';

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
                <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">CLV Tier</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Risk</th>
                <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mockCustomers.map(c => {
                const accountCount = mockAccounts.filter(a => a.customer_id === c.id).length;
                const clv = assessCustomerCLV(c.id);
                const activeAccount = mockAccounts.find(a => a.customer_id === c.id && a.status === 'active');
                const risk = activeAccount ? assessAccountRisk(activeAccount.id) : null;
                return (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3">
                      <Link to={activeAccount ? `/accounts/${activeAccount.id}` : '#'} className="flex items-center gap-3 group">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">
                          {c.name.charAt(0)}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-card-foreground group-hover:text-primary transition-colors">{c.name}</p>
                          {c.facebook_name && <p className="text-xs text-muted-foreground">@{c.facebook_name}</p>}
                        </div>
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">{c.phone || '—'}</td>
                    <td className="px-5 py-3 text-center text-sm text-card-foreground">{accountCount}</td>
                    <td className="px-5 py-3 text-center">
                      <CLVBadge tier={clv.tier} />
                    </td>
                    <td className="px-5 py-3 text-center">
                      {risk ? <RiskBadge level={risk.riskLevel} /> : <span className="text-xs text-muted-foreground">—</span>}
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
