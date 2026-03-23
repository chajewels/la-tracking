import { useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Currency } from '@/lib/types';
import { formatCurrency } from '@/lib/calculations';

interface Props {
  accountId: string;
  invoiceNumber: string;
  currency: Currency;
  hasOverride: boolean;
  planMonths: number;
}

export default function ApplyPenaltyCapDialog({ accountId, invoiceNumber, currency, hasOverride, planMonths }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  const capAmount = currency === 'PHP' ? 1000 : 2000;
  const capDisplay = formatCurrency(capAmount, currency);

  const handleApply = async () => {
    setLoading(true);
    try {
      const user = (await supabase.auth.getUser()).data.user;
      if (!user) throw new Error('Not authenticated');

      // Upsert override record
      const { error } = await supabase
        .from('penalty_cap_overrides' as any)
        .upsert({
          account_id: accountId,
          currency,
          penalty_cap_amount: capAmount,
          penalty_cap_scope: 'Due months 1-5 only',
          is_active: true,
          applied_by_user_id: user.id,
          applied_at: new Date().toISOString(),
          notes: `Penalty capped at ${capDisplay} (1–5 months rule), global system unchanged`,
        }, { onConflict: 'account_id' });

      if (error) throw error;

      // Audit log
      await supabase.from('audit_logs').insert({
        entity_type: 'penalty_cap_override',
        entity_id: accountId,
        action: 'manual_penalty_cap_override',
        performed_by_user_id: user.id,
        new_value_json: {
          invoice_number: invoiceNumber,
          currency,
          penalty_cap_amount: capAmount,
          penalty_cap_scope: 'Due months 1-5 only',
          notes: `Penalty capped (1–5 months rule), global system unchanged`,
        },
      });

      // Now enforce the cap: waive penalties that exceed cap for non-final months
      // For a 3-month plan, only months 1-2 are capped; for 6-month, months 1-5
      const lastCappedMonth = planMonths - 1;
      const { data: schedItems } = await supabase
        .from('layaway_schedule')
        .select('id, installment_number, penalty_amount, base_installment_amount, total_due_amount, paid_amount, status')
        .eq('account_id', accountId)
        .lte('installment_number', lastCappedMonth)
        .order('installment_number', { ascending: true });

      if (schedItems) {
        // Get all penalty_fees for these schedule items
        const schedIds = schedItems.map(s => s.id);
        const { data: penaltyFees } = await supabase
          .from('penalty_fees')
          .select('*')
          .in('schedule_id', schedIds)
          .in('status', ['unpaid', 'paid'])
          .order('created_at', { ascending: true });

        if (penaltyFees && penaltyFees.length > 0) {
          // Calculate total active penalties across months 1-5
          const totalActivePenalty = penaltyFees.reduce((s, p) => s + Number(p.penalty_amount), 0);

          if (totalActivePenalty > capAmount) {
            // Need to waive excess penalties (waive from newest first)
            const sorted = [...penaltyFees].sort((a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            );

            let excess = totalActivePenalty - capAmount;
            const toWaive: string[] = [];

            for (const p of sorted) {
              if (excess <= 0) break;
              const amt = Number(p.penalty_amount);
              if (amt <= excess) {
                toWaive.push(p.id);
                excess -= amt;
              }
            }

            if (toWaive.length > 0) {
              await supabase
                .from('penalty_fees')
                .update({ status: 'waived', waived_at: new Date().toISOString() })
                .in('id', toWaive);

              // Recalculate schedule penalty_amount from remaining active penalties
              for (const sched of schedItems) {
                const activePens = (penaltyFees || []).filter(
                  p => p.schedule_id === sched.id && !toWaive.includes(p.id)
                );
                const newPenalty = activePens.reduce((s, p) => s + Number(p.penalty_amount), 0);
                const newTotal = Number(sched.base_installment_amount) + newPenalty;

                await supabase
                  .from('layaway_schedule')
                  .update({
                    penalty_amount: newPenalty,
                    total_due_amount: newTotal,
                  })
                  .eq('id', sched.id);
              }

              // Recalculate remaining_balance
              const { data: allSched } = await supabase
                .from('layaway_schedule')
                .select('total_due_amount, paid_amount, status')
                .eq('account_id', accountId);

              if (allSched) {
                const newRemaining = allSched.reduce((sum, s) => {
                  if (s.status === 'paid' || s.status === 'cancelled') return sum;
                  return sum + Math.max(0, Number(s.total_due_amount) - Number(s.paid_amount));
                }, 0);
                await supabase
                  .from('layaway_accounts')
                  .update({ remaining_balance: newRemaining })
                  .eq('id', accountId);
              }
            }
          }
        }
      }

      queryClient.invalidateQueries({ queryKey: ['penalty-cap-override', accountId] });
      queryClient.invalidateQueries({ queryKey: ['penalties', accountId] });
      queryClient.invalidateQueries({ queryKey: ['schedule', accountId] });
      queryClient.invalidateQueries({ queryKey: ['accounts', accountId] });
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });

      toast.success(`Penalty cap override applied — capped at ${capDisplay}`);
      setOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to apply override');
    } finally {
      setLoading(false);
    }
  };

  if (hasOverride) return null;

  return (
    <>
      <Button
        variant="outline"
        className="border-primary/30 text-primary hover:bg-primary/10"
        onClick={() => setOpen(true)}
      >
        <ShieldCheck className="h-4 w-4 mr-2" /> Apply Penalty Cap Override
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply Penalty Cap Override</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>This will cap the total penalty for <strong>INV #{invoiceNumber}</strong> at <strong>{capDisplay}</strong> for overdue months 1–5.</p>
              <ul className="list-disc list-inside text-xs space-y-1 mt-2">
                <li>Penalties exceeding the cap will be waived</li>
                <li>No new penalties will be added beyond the cap</li>
                <li>Only the final payment may include remaining adjustments</li>
                <li>This does NOT affect any other invoices</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleApply} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
              Confirm Override
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
