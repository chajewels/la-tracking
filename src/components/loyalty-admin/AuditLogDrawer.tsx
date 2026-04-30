import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { History, User as UserIcon } from 'lucide-react';
import type { LoyaltyAuditRow } from '@/hooks/loyalty-admin/useLoyaltyAuditLog';

const ENTITY_LABELS: Record<string, string> = {
  loyalty_tier: 'Tier',
  loyalty_settings: 'Settings',
  loyalty_beta: 'Beta Whitelist',
  loyalty_redemption: 'Redemption',
  loyalty_member: 'Member',
  loyalty_promo: 'Promo',
  loyalty_reward: 'Reward',
  loyalty_banner: 'Banner',
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const display = value == null ? null : JSON.stringify(value, null, 2);
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
        {label}
      </p>
      {display == null ? (
        <p className="text-xs text-muted-foreground italic px-3 py-2 rounded-md border border-border bg-muted/30">
          (none)
        </p>
      ) : (
        <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 overflow-x-auto">
          {display}
        </pre>
      )}
    </div>
  );
}

interface Props {
  row: LoyaltyAuditRow | null;
  performerName: string | null;
  onClose: () => void;
}

export default function AuditLogDrawer({ row, performerName, onClose }: Props) {
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            Audit Entry
          </SheetTitle>
        </SheetHeader>

        {row && (
          <div className="space-y-5 mt-5">
            {/* Header card */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/5 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  {ENTITY_LABELS[row.entity_type] ?? row.entity_type}
                </span>
                <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-mono">
                  {row.action}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {fmtDateTime(row.created_at)}
              </div>
            </div>

            {/* Metadata */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <UserIcon className="h-3.5 w-3.5" />
                  Performed by
                </span>
                <span className="font-medium">
                  {performerName ?? (row.performed_by_user_id ? '—' : 'system')}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Entity ID</span>
                <span className="font-mono text-[11px] text-foreground truncate ml-3 max-w-[60%]">
                  {row.entity_id}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Audit ID</span>
                <span className="font-mono text-[11px] text-muted-foreground truncate ml-3 max-w-[60%]">
                  {row.id}
                </span>
              </div>
            </div>

            {/* JSON diff */}
            <div className="space-y-3">
              <JsonBlock label="Old Value" value={row.old_value_json} />
              <JsonBlock label="New Value" value={row.new_value_json} />
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
