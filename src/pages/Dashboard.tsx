import { DollarSign, FileText, Users, AlertTriangle, TrendingUp, CheckCircle } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import RecentPayments from '@/components/dashboard/RecentPayments';
import OverdueAlerts from '@/components/dashboard/OverdueAlerts';
import { getDashboardStats } from '@/lib/mock-data';
import { formatCurrency } from '@/lib/calculations';

export default function Dashboard() {
  const stats = getDashboardStats();

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground font-display">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Cha Jewels Layaway Payment Overview</p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <StatCard
            title="Total Receivables"
            value={formatCurrency(stats.totalReceivables, 'PHP')}
            icon={DollarSign}
            variant="gold"
          />
          <StatCard
            title="Active Accounts"
            value={stats.activeAccounts.toString()}
            subtitle="Across PHP & JPY"
            icon={FileText}
          />
          <StatCard
            title="Collections Today"
            value={formatCurrency(stats.collectionsToday, 'PHP')}
            icon={TrendingUp}
            variant="success"
          />
          <StatCard
            title="This Month"
            value={formatCurrency(stats.collectionsThisMonth, 'PHP')}
            icon={TrendingUp}
          />
          <StatCard
            title="Overdue"
            value={stats.overdueCount.toString()}
            subtitle="Requires attention"
            icon={AlertTriangle}
            variant="danger"
          />
          <StatCard
            title="Completed"
            value={stats.completedThisMonth.toString()}
            subtitle="This month"
            icon={CheckCircle}
            variant="success"
          />
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <RecentPayments />
          </div>
          <div className="space-y-6">
            <AgingBuckets />
            <OverdueAlerts />
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
