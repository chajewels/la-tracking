import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import RecordPaymentModal from '@/components/payments/RecordPaymentModal';
import { toast } from 'sonner';

type DropdownAction = { label: string; action: () => void };

type SplitConfig = {
  primaryLabel: string;
  primaryAction: () => void;
  dropdownItems: DropdownAction[];
};

function resolveConfig(
  pathname: string,
  navigate: ReturnType<typeof useNavigate>,
  setRecordOpen: (open: boolean) => void,
  searchParams: URLSearchParams,
): SplitConfig | null {
  if (
    pathname.startsWith('/sales') ||
    pathname.startsWith('/cash-orders') ||
    pathname.startsWith('/layaway') ||
    pathname.startsWith('/accounts') ||
    pathname.startsWith('/payments-hub') ||
    pathname.startsWith('/waivers')
  ) {
    const tab = searchParams.get('tab');

    if (tab === 'payments' || tab === 'waivers') {
      return null;
    }

    return {
      primaryLabel: '+ New Account',
      primaryAction: () => navigate('/accounts/new'),
      dropdownItems: [
        { label: 'New Cash Order', action: () => navigate('/cash-orders/new') },
        { label: 'New Layaway Order', action: () => navigate('/accounts/new') },
        { label: 'Record Payment', action: () => setRecordOpen(true) },
      ],
    };
  }
  if (pathname.startsWith('/services')) {
    const tab = searchParams.get('tab') ?? 'service-jobs';

    if (tab === 'trade-ins') {
      return {
        primaryLabel: '+ Log Trade-In',
        primaryAction: () => {
          navigate('/services?tab=trade-ins');
          setTimeout(() => window.dispatchEvent(new CustomEvent('open-trade-in-dialog')), 150);
        },
        dropdownItems: [],
      };
    }

    return {
      primaryLabel: '+ New Job',
      primaryAction: () => {
        navigate('/services?tab=service-jobs');
        setTimeout(() => window.dispatchEvent(new CustomEvent('open-new-service-job')), 150);
      },
      dropdownItems: [],
    };
  }
  if (pathname.startsWith('/customers')) {
    return {
      primaryLabel: '+ New Customer',
      primaryAction: () => window.dispatchEvent(new CustomEvent('open-new-customer-dialog')),
      dropdownItems: [
        {
          label: 'New Contact',
          action: () => window.dispatchEvent(new CustomEvent('open-new-customer-dialog')),
        },
        {
          label: 'Import Customers',
          action: () => toast.info('Customer import coming soon'),
        },
        {
          label: 'Manage Groups',
          action: () => window.dispatchEvent(new CustomEvent('toggle-grouped-view')),
        },
      ],
    };
  }
  return null;
}

export default function WorkspaceSplitButton() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [recordOpen, setRecordOpen] = useState(false);
  const config = resolveConfig(pathname, navigate, setRecordOpen, searchParams);
  if (!config) return null;

  const hasDropdown = config.dropdownItems.length > 0;

  return (
    <>
      <div className="flex items-center">
        <Button
          type="button"
          onClick={config.primaryAction}
          className={
            hasDropdown
              ? 'h-10 rounded-r-none bg-primary text-primary-foreground hover:bg-primary/90'
              : 'h-10 bg-primary text-primary-foreground hover:bg-primary/90'
          }
        >
          {config.primaryLabel}
        </Button>
        {hasDropdown && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                className="h-10 rounded-l-none border-l border-primary-foreground/20 bg-primary px-2 text-primary-foreground hover:bg-primary/90"
                aria-label="More actions"
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {config.dropdownItems.map((item) => (
                <DropdownMenuItem
                  key={item.label}
                  onSelect={item.action}
                >
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <RecordPaymentModal open={recordOpen} onOpenChange={setRecordOpen} />
    </>
  );
}
