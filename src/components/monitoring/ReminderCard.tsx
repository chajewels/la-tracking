import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MessageCircle, Copy, Check, ExternalLink, Eye, User, FileText,
  MoreHorizontal, Link2, AlertTriangle, Clock, CalendarCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import NotifiedButton, { type ReminderStage } from '@/components/notifications/NotifiedButton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { alertTypeConfig, type AlertType, type AccountBucket, daysOverdueFromToday } from '@/lib/business-rules';
import { toast } from 'sonner';

const PORTAL_BASE = 'https://chajewelslayaway.web.app';

export interface AlertItem {
  type: AlertType | 'grace_period';
  bucket: AccountBucket;
  customer: string;
  invoice: string;
  dueDate: string;
  amount: number;
  remainingBalance: number;
  currency: Currency;
  daysOverdue: number;
  accountId: string;
  scheduleId: string;
  customerId: string;
  messengerLink?: string | null;
  portalToken?: string | null;
}

const iconMap: Record<string, any> = {
  overdue: AlertTriangle,
  grace_period: Clock,
  due_today: Clock,
  upcoming: CalendarCheck,
};

function bucketToStage(bucket: AccountBucket): ReminderStage | null {
  if (bucket === 'due_7_days') return '7_DAYS';
  if (bucket === 'due_3_days') return '3_DAYS';
  if (bucket === 'due_today') return 'DUE_TODAY';
  if (bucket === 'grace_period') return 'GRACE_PERIOD';
  return null;
}

export function generateReminderMessage(alert: AlertItem): string {
  const dueStr = new Date(alert.dueDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const amtStr = formatCurrency(alert.amount, alert.currency);
  const portalLink = alert.portalToken
    ? `\n\n📱 View your account anytime:\n${PORTAL_BASE}/portal?token=${alert.portalToken}`
    : '';

  if (alert.type === 'overdue') {
    return `Hi ${alert.customer}! 👋\n\nThis is a friendly reminder from Cha Jewels that your layaway payment for INV #${alert.invoice} was due on ${dueStr} (${alert.daysOverdue} days ago).\n\nRemaining amount due: ${amtStr}\n\nPlease settle at your earliest convenience to avoid additional penalties.${portalLink}\n\nThank you! 💎`;
  } else if (alert.type === 'grace_period') {
    const graceEnd = new Date(alert.dueDate);
    graceEnd.setDate(graceEnd.getDate() + 7);
    const graceEndStr = graceEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const portalLine = alert.portalToken ? `\n\nSettle your payment here:\n${PORTAL_BASE}/portal?token=${alert.portalToken}` : '';
    return `⏳ Cha Jewels Grace Period Reminder\n\nHi Ma'am/Sir 💎\n\nYour layaway payment for Invoice #${alert.invoice} was due on ${dueStr} (${alert.daysOverdue} day${alert.daysOverdue !== 1 ? 's' : ''} ago).\n\nAmount Due: ${amtStr}\n\nYou are currently within your 7-day grace period, which ends on ${graceEndStr}.\n\nTo avoid penalties, please settle your payment before the grace period expires.${portalLine}\n\nThank you for choosing Cha Jewels 💛`;
  } else if (alert.type === 'due_today') {
    const dueDate = new Date(alert.dueDate);
    const graceEnd = new Date(dueDate);
    graceEnd.setDate(graceEnd.getDate() + 7);
    const graceEndStr = graceEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const portalLine = alert.portalToken ? `\n\nSecure your account by completing your payment here:\n${PORTAL_BASE}/portal?token=${alert.portalToken}` : '';
    return `⚠️ Cha Jewels Payment Due Today\n\nHi Ma'am/Sir 💎\n\nYour layaway payment for Invoice #${alert.invoice} is due TODAY, ${dueStr}.\n\nAmount Due: ${amtStr}\n\nTo avoid any inconvenience, we highly encourage you to settle your payment today.\n\nYou are still within your 7-day grace period until ${graceEndStr}, after which penalties may apply.${portalLine}\n\nThank you for choosing Cha Jewels 💛`;
  } else {
    return `Hi ${alert.customer}! 👋\n\nThis is a friendly heads-up from Cha Jewels — your next layaway payment for INV #${alert.invoice} is coming up on ${dueStr}.\n\nAmount due: ${amtStr}${portalLink}\n\nThank you for staying on track! 💎`;
  }
}

interface ReminderCardProps {
  alert: AlertItem;
  notifMap: Map<string, { notified_by_name: string; notified_at: string }>;
  onOpenMessenger: (alert: AlertItem, message: string) => void;
}

export default function ReminderCard({ alert, notifMap, onOpenMessenger }: ReminderCardProps) {
  const [copiedPortal, setCopiedPortal] = useState(false);

  const config = alertTypeConfig[alert.type];
  const Icon = iconMap[alert.type];
  const stage = bucketToStage(alert.bucket);
  const existingNotif = stage ? notifMap.get(`${alert.scheduleId}_${stage}`) || null : null;
  const hasPortal = !!alert.portalToken;
  const portalUrl = hasPortal ? `${PORTAL_BASE}/portal?token=${alert.portalToken}` : null;

  const handleCopyPortalLink = async () => {
    if (!portalUrl) {
      toast.error('No portal link available for this customer');
      return;
    }
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopiedPortal(true);
      toast.success('Portal link copied!');
      setTimeout(() => setCopiedPortal(false), 2000);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleCopyMessage = async () => {
    const msg = generateReminderMessage(alert);
    try {
      await navigator.clipboard.writeText(msg);
      toast.success('Reminder message copied!');
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <div className={`rounded-xl border bg-card p-4 ${config.borderClass} hover:bg-muted/30 transition-colors`}>
      <div className="flex items-start justify-between gap-3">
        {/* Left: Icon + Info */}
        <Link to={`/accounts/${alert.accountId}`} className="flex items-start gap-3 flex-1 min-w-0 cursor-pointer group">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${config.iconBg}`}>
            <Icon className={`h-5 w-5 ${config.iconColor}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-card-foreground group-hover:text-primary transition-colors">{alert.customer}</p>
              <Badge variant="outline" className={`text-[10px] ${config.badgeClass}`}>{config.label}</Badge>
              {hasPortal ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link2 className="h-3 w-3 text-success" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">Portal link active</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link2 className="h-3 w-3 text-muted-foreground/40" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">No portal link — generate from Customer Detail</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              INV #{alert.invoice} · Due {new Date(alert.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              {alert.daysOverdue > 0 && ` · ${alert.daysOverdue}d overdue`}
            </p>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-xs text-muted-foreground">
                Installment: <span className="font-semibold text-card-foreground">{formatCurrency(alert.amount, alert.currency)}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                Balance: <span className="font-semibold text-card-foreground">{formatCurrency(alert.remainingBalance, alert.currency)}</span>
              </span>
            </div>
          </div>
        </Link>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {stage && (
            <NotifiedButton
              accountId={alert.accountId}
              scheduleId={alert.scheduleId}
              customerId={alert.customerId}
              invoiceNumber={alert.invoice}
              dueDate={alert.dueDate}
              stage={stage}
              existingNotification={existingNotif}
            />
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-info"
            title="Generate Messenger message"
            onClick={() => onOpenMessenger(alert, generateReminderMessage(alert))}
          >
            <MessageCircle className="h-4 w-4" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={handleCopyMessage}>
                <Copy className="h-3.5 w-3.5 mr-2" />
                Copy Reminder Message
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyPortalLink} disabled={!hasPortal}>
                {copiedPortal ? <Check className="h-3.5 w-3.5 mr-2 text-success" /> : <Link2 className="h-3.5 w-3.5 mr-2" />}
                {copiedPortal ? 'Copied!' : 'Copy Portal Link'}
              </DropdownMenuItem>
              {portalUrl && (
                <DropdownMenuItem asChild>
                  <a href={portalUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 mr-2" />
                    Open Customer Portal
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to={`/accounts/${alert.accountId}`}>
                  <Eye className="h-3.5 w-3.5 mr-2" />
                  View Invoice Detail
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to={`/customers/${alert.customerId}`}>
                  <User className="h-3.5 w-3.5 mr-2" />
                  View Customer
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
