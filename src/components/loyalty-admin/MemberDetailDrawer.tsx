import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ExternalLink, Sparkles, Coins, TrendingUp, Crown, AlertTriangle, Cake } from 'lucide-react';
import { useLoyaltyMemberDetail } from '@/hooks/loyalty-admin/useLoyaltyMemberDetail';

const TX_TYPE_LABEL: Record<string, string> = {
  earned: 'Earned',
  redeemed: 'Redeemed',
  bonus: 'Bonus',
  expired: 'Expired',
  adjusted: 'Adjusted',
};

const TX_TONE: Record<string, string> = {
  earned: 'text-emerald-600',
  bonus: 'text-emerald-600',
  redeemed: 'text-amber-600',
  expired: 'text-muted-foreground',
  adjusted: 'text-foreground',
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function deriveActivity(lastPurchaseAt: string | null): 'active' | 'inactive' {
  if (!lastPurchaseAt) return 'inactive';
  const sixMonths = 1000 * 60 * 60 * 24 * 30 * 6;
  return Date.now() - new Date(lastPurchaseAt).getTime() <= sixMonths
    ? 'active'
    : 'inactive';
}

interface StatProps {
  label: string;
  value: string | number;
  Icon?: typeof Coins;
}

function MiniStat({ label, value, Icon }: StatProps) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
      </div>
      <p className="text-lg font-bold tabular-nums text-foreground mt-0.5">{value}</p>
    </div>
  );
}

export default function MemberDetailDrawer({
  memberId,
  onClose,
}: {
  memberId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useLoyaltyMemberDetail(memberId);

  const queryClient = useQueryClient();
  const customerId = data?.member?.customer_id ?? null;
  const [editing, setEditing] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [monthInput, setMonthInput] = useState('');
  const [dayInput, setDayInput] = useState('');

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const { data: bday } = useQuery({
    queryKey: ['member-birthday', customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const { data: row, error } = await supabase
        .from('customers')
        .select('birthday, birthday_locked_at, birthday_admin_edits_used')
        .eq('id', customerId!)
        .maybeSingle();
      if (error) throw error;
      return row;
    },
  });

  const fmtBday = (b: string | null | undefined) => {
    if (!b) return 'Not set';
    const parts = b.split('-');
    return `${MONTHS[parseInt(parts[1], 10) - 1]} ${parseInt(parts[2], 10)}`;
  };

  const handleCorrect = async () => {
    if (!customerId || !monthInput || !dayInput) { toast.error('Pick a month and a day'); return; }
    const p_birthday = `2000-${monthInput.padStart(2, '0')}-${dayInput.padStart(2, '0')}`;
    setCorrecting(true);
    try {
      const { error } = await supabase.rpc('admin_correct_birthday', { p_customer_id: customerId, p_birthday });
      if (error) { toast.error(error.message || 'Correction failed'); return; }
      toast.success('Birthday corrected');
      setEditing(false); setMonthInput(''); setDayInput('');
      queryClient.invalidateQueries({ queryKey: ['member-birthday', customerId] });
    } finally {
      setCorrecting(false);
    }
  };

  return (
    <Sheet open={!!memberId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto"
      >
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Member Detail
          </SheetTitle>
        </SheetHeader>

        {isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 mt-4">
            <p className="text-sm text-destructive">Failed to load member</p>
          </div>
        ) : isLoading || !data ? (
          <div className="space-y-3 mt-5">
            <Skeleton className="h-20 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-40 rounded-lg" />
          </div>
        ) : (
          <div className="space-y-5 mt-5">
            {/* Profile header */}
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-foreground">
                    {data.member.full_name}
                  </p>
                  <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                    {data.member.customer_code ?? '—'}
                  </p>
                  {data.member.email && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {data.member.email}
                    </p>
                  )}
                </div>
                <Link
                  to={`/customers/${data.member.customer_id}?tab=loyalty`}
                  className="text-[11px] text-primary hover:underline flex items-center gap-1 whitespace-nowrap"
                  onClick={onClose}
                >
                  Open in Customer Detail
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>

              {/* Tier + flags */}
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    borderColor: data.member.tier_color_hex ?? undefined,
                    color: data.member.tier_color_hex ?? undefined,
                  }}
                >
                  <Crown className="h-3 w-3" />
                  {data.member.tier_name} · {data.member.tier_multiplier}x
                </span>
                <span
                  className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                    deriveActivity(data.member.last_purchase_at) === 'active'
                      ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
                      : 'bg-muted text-muted-foreground border-border'
                  }`}
                >
                  {deriveActivity(data.member.last_purchase_at)}
                </span>
                {data.member.is_beta && (
                  <span className="inline-flex items-center rounded-md bg-primary/10 text-primary border border-primary/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                    Beta
                  </span>
                )}
                {data.member.is_downgraded && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 text-amber-700 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
                    <AlertTriangle className="h-3 w-3" />
                    Downgraded
                  </span>
                )}
              </div>
            </div>

            {/* Points stats */}
            <div className="grid grid-cols-2 gap-2">
              <MiniStat
                label="Remaining"
                value={data.member.remaining_points.toLocaleString()}
                Icon={Coins}
              />
              <MiniStat
                label="Earned (lifetime)"
                value={data.member.total_points_earned.toLocaleString()}
                Icon={Sparkles}
              />
              <MiniStat
                label="Redeemed (lifetime)"
                value={data.member.total_points_redeemed.toLocaleString()}
              />
              <MiniStat
                label="Expired (lifetime)"
                value={data.member.total_points_expired.toLocaleString()}
              />
            </div>

            {/* Spend + dates */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Cumulative Spend</span>
                <span className="font-semibold tabular-nums">
                  ¥{data.member.cumulative_spend_jpy.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last Purchase</span>
                <span>{fmtDate(data.member.last_purchase_at)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Enrolled</span>
                <span>{fmtDate(data.member.enrolled_at)}</span>
              </div>
            </div>

            {/* Birthday — admin correction (one-time) */}
            <div className="rounded-lg border border-border bg-background p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cake className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">Birthday</span>
                </div>
                <span className="text-sm text-foreground">{fmtBday(bday?.birthday)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">Corrections used: {bday?.birthday_admin_edits_used ?? 0}/1</span>
                {bday?.birthday_locked_at && (bday?.birthday_admin_edits_used ?? 0) < 1 && !editing && (
                  <button onClick={() => setEditing(true)} className="text-[12px] text-primary font-medium">Correct</button>
                )}
              </div>
              {!bday?.birthday_locked_at && (
                <p className="text-[11px] text-muted-foreground/70">Customer hasn't set their birthday yet.</p>
              )}
              {bday?.birthday_locked_at && (bday?.birthday_admin_edits_used ?? 0) >= 1 && (
                <p className="text-[11px] text-muted-foreground/70">Correction limit reached.</p>
              )}
              {editing && (
                <div className="space-y-2 pt-1">
                  <div className="flex gap-2">
                    <select value={monthInput} onChange={(e) => setMonthInput(e.target.value)} className="flex-1 px-2 py-1.5 rounded border border-border bg-background text-sm">
                      <option value="">Month</option>
                      {MONTHS.map((n, i) => (<option key={n} value={String(i + 1)}>{n}</option>))}
                    </select>
                    <select value={dayInput} onChange={(e) => setDayInput(e.target.value)} className="w-20 px-2 py-1.5 rounded border border-border bg-background text-sm">
                      <option value="">Day</option>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (<option key={d} value={String(d)}>{d}</option>))}
                    </select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => { setEditing(false); setMonthInput(''); setDayInput(''); }} disabled={correcting} className="px-3 py-1 rounded text-[12px] text-muted-foreground">Cancel</button>
                    <button onClick={handleCorrect} disabled={correcting || !monthInput || !dayInput} className="px-3 py-1 rounded text-[12px] font-medium bg-primary text-primary-foreground disabled:opacity-50">{correcting ? 'Saving…' : 'Save correction'}</button>
                  </div>
                </div>
              )}
            </div>

            {/* Recent transactions */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">Recent Transactions</h4>
                <span className="text-[11px] text-muted-foreground">last 10</span>
              </div>
              {data.transactions.length === 0 ? (
                <p className="text-xs text-muted-foreground italic p-4 text-center">
                  No transactions yet
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px]">Date</TableHead>
                      <TableHead className="text-[10px]">Type</TableHead>
                      <TableHead className="text-[10px] text-right">Points</TableHead>
                      <TableHead className="text-[10px]">Invoice</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.transactions.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="text-[11px]">{fmtDateTime(t.created_at)}</TableCell>
                        <TableCell className="text-[11px]">
                          {TX_TYPE_LABEL[t.transaction_type] ?? t.transaction_type}
                        </TableCell>
                        <TableCell
                          className={`text-[11px] tabular-nums text-right font-semibold ${
                            TX_TONE[t.transaction_type] ?? 'text-foreground'
                          }`}
                        >
                          {t.points_amount > 0 ? '+' : ''}
                          {t.points_amount.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-[10px] font-mono">
                          {t.invoice_number ? `#${t.invoice_number}` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            {/* Note about Adjust Points */}
            <p className="text-[11px] text-muted-foreground italic px-1">
              Adjust Points stays available on the customer's Loyalty tab in
              Customer Detail. Open the link above to access.
            </p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
