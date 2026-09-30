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
import { pickLine, fillLine, type MessagePools } from '@/lib/message-lines';
import { getPortalLinkForCustomer, isTokenLink } from '@/lib/portal-link';

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
  authUserId?: string | null;
  /** When the customer chose a portal password (customers.portal_password_at). */
  portalPasswordAt?: string | null;
  customerPin?: string | null;
}

function hasPortalAccess(alert: AlertItem): boolean {
  return !!(alert.authUserId || alert.portalToken || alert.portalPasswordAt);
}

function portalUrlFor(alert: AlertItem): string {
  return getPortalLinkForCustomer({
    auth_user_id: alert.authUserId ?? null,
    portal_password_at: alert.portalPasswordAt ?? null,
    portal_token: alert.portalToken,
  });
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

export function generateReminderMessage(alert: AlertItem, pools?: MessagePools): string {
  const ml = (type: string, part: string, days_ago?: string) =>
    fillLine(pickLine(pools, type, part), { name: alert.customer, invoice: alert.invoice, due_date: dueStr, days_ago });
  const dueStr = new Date(alert.dueDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const amtStr = formatCurrency(alert.amount, alert.currency);
  const portalUrl = hasPortalAccess(alert) ? portalUrlFor(alert) : null;
  const portalLink = portalUrl
    ? `\n\n📱 View your account anytime:\n${portalUrl}`
    : '';
  // PIN line iff the link is a token link (it opens the PIN gate) and a PIN exists.
  const pinLine = (portalUrl && isTokenLink(portalUrl) && alert.customerPin)
    ? `\n\n🔐 Your portal PIN is the last 4 digits of your mobile number on file: ${alert.customerPin}`
    : '';

  if (alert.type === 'overdue') {
    return `${ml('reminder_overdue', 'opening', `${alert.daysOverdue} days ago`)}\n\nRemaining amount due: ${amtStr}\n\nPlease settle at your earliest convenience to avoid additional penalties.${portalLink}${pinLine}\n\n${ml('reminder_overdue', 'closing')}`;
  } else if (alert.type === 'grace_period') {
    const graceEnd = new Date(alert.dueDate);
    graceEnd.setDate(graceEnd.getDate() + 7);
    const graceEndStr = graceEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const portalLine = portalUrl ? `\n\nSettle your payment here:\n${portalUrl}` : '';
    return `⏳ Cha Jewels Grace Period Reminder\n\n${ml('reminder_grace', 'opening', `${alert.daysOverdue} day${alert.daysOverdue !== 1 ? 's' : ''} ago`)}\n\nAmount Due: ${amtStr}\n\nYou are currently within your 7-day grace period, which ends on ${graceEndStr}.\n\nTo avoid penalties, please settle your payment before the grace period expires.${portalLine}${pinLine}\n\n${ml('thanks_choosing', 'closing')}`;
  } else if (alert.type === 'due_today') {
    const dueDate = new Date(alert.dueDate);
    const graceEnd = new Date(dueDate);
    graceEnd.setDate(graceEnd.getDate() + 7);
    const graceEndStr = graceEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const portalLine = portalUrl ? `\n\nSecure your account by completing your payment here:\n${portalUrl}` : '';
    return `⚠️ Cha Jewels Payment Due Today\n\n${ml('reminder_due_today', 'opening')}\n\nAmount Due: ${amtStr}\n\nTo avoid any inconvenience, we highly encourage you to settle your payment today.\n\nYou are still within your 7-day grace period until ${graceEndStr}, after which penalties may apply.${portalLine}${pinLine}\n\n${ml('thanks_choosing', 'closing')}`;
  } else {
    return `${ml('reminder_upcoming', 'opening')}\n\nAmount due: ${amtStr}${portalLink}${pinLine}\n\n${ml('reminder_upcoming', 'closing')}`;
  }
}

interface ReminderCardProps {
  alert: AlertItem;
  notifMap: Map<string, { notified_by_name: string; notified_at: string }>;
  onOpenMessenger: (alert: AlertItem, message: string) => void;
  /** message_lines pools (undefined → today's text). */
  pools?: MessagePools;
}

export default function ReminderCard({ alert, notifMap, onOpenMessenger, pools }: ReminderCardProps) {
  const [copiedPortal, setCopiedPortal] = useState(false);

  const config = alertTypeConfig[alert.type];
  const Icon = iconMap[alert.type];
  const stage = bucketToStage(alert.bucket);
  const existingNotif = stage ? notifMap.get(`${alert.scheduleId}_${stage}`) || null : null;
  const hasPortal = hasPortalAccess(alert);
  const portalUrl = hasPortal ? portalUrlFor(alert) : null;

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
    const msg = generateReminderMessage(alert, pools);
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
            onClick={() => onOpenMessenger(alert, generateReminderMessage(alert, pools))}
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
