import { useState } from 'react';
import { CheckCircle, Bell, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export type ReminderStage = '7_DAYS' | '3_DAYS' | 'DUE_TODAY' | 'GRACE_PERIOD';

interface NotifiedButtonProps {
  accountId: string;
  scheduleId: string;
  customerId: string;
  invoiceNumber: string;
  dueDate: string;
  stage: ReminderStage;
  /** Pre-loaded notification record if exists */
  existingNotification?: {
    notified_by_name: string;
    notified_at: string;
  } | null;
}

export default function NotifiedButton({
  accountId,
  scheduleId,
  customerId,
  invoiceNumber,
  dueDate,
  stage,
  existingNotification,
}: NotifiedButtonProps) {
  const { user, profile } = useAuth();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const isNotified = !!existingNotification;

  const handleNotify = async () => {
    if (!user || isNotified) return;
    setSaving(true);
    try {
      const staffName = profile?.full_name || user.email || 'Unknown';

      const { error } = await supabase.from('csr_notifications').insert({
        account_id: accountId,
        schedule_id: scheduleId,
        customer_id: customerId,
        invoice_number: invoiceNumber,
        due_date: dueDate,
        reminder_stage: stage,
        notified_by_user_id: user.id,
        notified_by_name: staffName,
      });

      if (error) {
        if (error.code === '23505') {
          toast.info('Already marked as notified for this stage.');
        } else {
          throw error;
        }
      } else {
        // Also log to audit_logs
        await supabase.from('audit_logs').insert({
          entity_type: 'csr_notification',
          entity_id: accountId,
          action: 'CSR_REMINDER_NOTIFIED',
          performed_by_user_id: user.id,
          new_value_json: {
            invoice_number: invoiceNumber,
            due_date: dueDate,
            reminder_stage: stage,
            notified_by: staffName,
          },
        });

        toast.success(`Marked as notified (${stage.replace('_', ' ')})`);
      }

      queryClient.invalidateQueries({ queryKey: ['csr-notifications'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to record notification');
    } finally {
      setSaving(false);
    }
  };

  if (isNotified) {
    const notifDate = new Date(existingNotification.notified_at);
    const dateStr = notifDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = notifDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-success/10 border border-success/20 cursor-default select-none">
              <CheckCircle className="h-3 w-3 text-success" />
              <span className="text-[10px] font-medium text-success">Notified</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="text-xs">
            <p>Notified by {existingNotification.notified_by_name}</p>
            <p className="text-muted-foreground">{dateStr} at {timeStr}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleNotify(); }}
      disabled={saving}
      className="h-7 px-2.5 text-xs gap-1 border-primary/30 text-primary hover:bg-primary/10"
    >
      {saving ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Bell className="h-3 w-3" />
      )}
      Notify
    </Button>
  );
}
