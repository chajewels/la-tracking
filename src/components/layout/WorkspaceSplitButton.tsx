import { useEffect, useState } from 'react';
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

type DropdownAction = { label: string; action: () => void };

type SplitConfig = {
  primaryLabel: string;
  primaryAction: () => void;
  dropdownItems: DropdownAction[];
};

// Maps AI-extracted `payment_channel` strings (lowercased) to the canonical
// payment-method labels the RecordPayment dialogs expect.
const channelMap: Record<string, string> = {
  gcash: 'GCash',
  bdo: 'BDO',
  bpi: 'BPI',
  metrobank: 'Metrobank',
  paypal: 'PayPal',
  cash: 'Cash',
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
    const tab = searchParams.get('tab') ?? 'cash';

    if (tab === 'payments' || tab === 'waivers') {
      return null;
    }

    if (tab === 'cash') {
      return {
        primaryLabel: '+ New Cash Order',
        primaryAction: () => navigate('/cash-orders/new'),
        dropdownItems: [
          { label: 'New Layaway Order', action: () => navigate('/accounts/new') },
          { label: 'Record Payment', action: () => setRecordOpen(true) },
        ],
      };
    }

    return {
      primaryLabel: '+ New Account',
      primaryAction: () => navigate('/accounts/new'),
      dropdownItems: [
        { label: 'New Cash Order', action: () => navigate('/cash-orders/new') },
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
          label: 'Import Customers',
          action: () => window.dispatchEvent(new CustomEvent('open-import-customers')),
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
  const [initialInvoice, setInitialInvoice] = useState<string | null>(null);
  const [initialPaymentMethod, setInitialPaymentMethod] = useState<string | null>(null);
  const [initialPaymentMode, setInitialPaymentMode] = useState<'single' | 'split' | null>(null);

  // AICommandModal's RECORD_PAYMENT path dispatches this CustomEvent so
  // staff land directly on the existing RecordPaymentModal flow (proof
  // upload still required there).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setInitialInvoice(detail.invoice_number ?? null);
      setInitialPaymentMethod(
        channelMap[(detail.payment_channel ?? '').toLowerCase()] ?? null,
      );
      setInitialPaymentMode(detail.payment_mode ?? null);
      setRecordOpen(true);
    };
    window.addEventListener('open-record-payment-modal', handler);
    return () => window.removeEventListener('open-record-payment-modal', handler);
  }, []);
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
      <RecordPaymentModal
        open={recordOpen}
        onOpenChange={(next) => {
          setRecordOpen(next);
          if (!next) {
            setInitialInvoice(null);
            setInitialPaymentMethod(null);
            setInitialPaymentMode(null);
          }
        }}
        initialInvoice={initialInvoice}
        initialPaymentMethod={initialPaymentMethod}
        initialPaymentMode={initialPaymentMode}
      />
    </>
  );
}
