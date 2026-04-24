import { Link } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Banknote } from 'lucide-react';

export default function NewCashOrder() {
  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Link to="/customers?tab=cash">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
              <Banknote className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">New Cash Order</h1>
              <p className="text-sm text-muted-foreground">Placeholder — form coming soon</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Banknote className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm text-muted-foreground">Cash order creation form will be added in the next step.</p>
        </div>
      </div>
    </AppLayout>
  );
}
