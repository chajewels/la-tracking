import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import DashboardTab from '@/components/loyalty-admin/DashboardTab';
import MembersTab from '@/components/loyalty-admin/MembersTab';
import RedemptionsTab from '@/components/loyalty-admin/RedemptionsTab';
import BetaWhitelistTab from '@/components/loyalty-admin/BetaWhitelistTab';
import { useLoyaltyPendingCount } from '@/hooks/useLoyaltyPendingCount';

type LoyaltyAdminTab = 'dashboard' | 'members' | 'redemptions' | 'beta';

const VALID_TABS: ReadonlySet<LoyaltyAdminTab> = new Set([
  'dashboard',
  'members',
  'redemptions',
  'beta',
]);

function readTab(value: string | null): LoyaltyAdminTab {
  if (value && VALID_TABS.has(value as LoyaltyAdminTab)) {
    return value as LoyaltyAdminTab;
  }
  return 'dashboard';
}

export default function LoyaltyAdmin() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = readTab(searchParams.get('tab'));
  const { count: pendingRedemptions } = useLoyaltyPendingCount();

  // Drawer-selected member id is owned at this level so the
  // dashboard's recent-enrollments rows can deep-link into the
  // Members tab + open the drawer in one click.
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);

  const handleTabChange = useCallback(
    (next: string) => {
      const tab = readTab(next);
      const params = new URLSearchParams(searchParams);
      if (tab === 'dashboard') {
        params.delete('tab');
      } else {
        params.set('tab', tab);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const jumpToRedemptions = useCallback(() => {
    handleTabChange('redemptions');
  }, [handleTabChange]);

  const jumpToMember = useCallback(
    (memberId: string) => {
      setSelectedMemberId(memberId);
      handleTabChange('members');
    },
    [handleTabChange],
  );

  return (
    <AppLayout>
      <div className="container mx-auto p-6 space-y-6">
        {/* Page header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg gold-gradient">
            <Sparkles className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Loyalty</h1>
            <p className="text-sm text-muted-foreground">
              Manage members, redemptions, and program access
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-5">
          <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4">
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="redemptions">
              Redemptions
              {pendingRedemptions > 0 && (
                <span
                  className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{
                    background: 'rgba(245, 158, 11, 0.18)',
                    color: '#B45309',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                  }}
                >
                  {pendingRedemptions}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="beta">Beta Whitelist</TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="mt-0">
            <DashboardTab
              onJumpToRedemptions={jumpToRedemptions}
              onJumpToMember={jumpToMember}
            />
          </TabsContent>

          <TabsContent value="members" className="mt-0">
            <MembersTab
              selectedMemberId={selectedMemberId}
              setSelectedMemberId={setSelectedMemberId}
            />
          </TabsContent>

          <TabsContent value="redemptions" className="mt-0">
            <RedemptionsTab />
          </TabsContent>

          <TabsContent value="beta" className="mt-0">
            <BetaWhitelistTab />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
