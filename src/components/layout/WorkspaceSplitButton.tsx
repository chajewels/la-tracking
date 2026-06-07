import { useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type SplitConfig = {
  primaryLabel: string;
  dropdownItems: string[];
};

function resolveConfig(pathname: string): SplitConfig | null {
  if (
    pathname.startsWith('/sales') ||
    pathname.startsWith('/cash-orders') ||
    pathname.startsWith('/layaway') ||
    pathname.startsWith('/accounts') ||
    pathname.startsWith('/payments-hub') ||
    pathname.startsWith('/waivers')
  ) {
    return {
      primaryLabel: '+ New Account',
      dropdownItems: ['New Cash Order', 'New Layaway Order', 'Record Payment'],
    };
  }
  if (pathname.startsWith('/services')) {
    return {
      primaryLabel: '+ New Job',
      dropdownItems: ['Log Trade-In'],
    };
  }
  if (pathname.startsWith('/customers')) {
    return {
      primaryLabel: '+ New Customer',
      dropdownItems: ['New Contact', 'Import Customers', 'Manage Groups'],
    };
  }
  return null;
}

export default function WorkspaceSplitButton() {
  const { pathname } = useLocation();
  const config = resolveConfig(pathname);
  if (!config) return null;

  return (
    <div className="flex items-center">
      <Button
        type="button"
        onClick={() => console.log(config.primaryLabel)}
        className="h-10 rounded-r-none bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {config.primaryLabel}
      </Button>
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
              key={item}
              onSelect={() => console.log(item)}
            >
              {item}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
