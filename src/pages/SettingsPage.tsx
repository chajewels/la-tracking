import { useState } from 'react';
import { Settings } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { getConversionRate, setConversionRate } from '@/lib/currency-converter';
import { toast } from '@/hooks/use-toast';

export default function SettingsPage() {
  const [rate, setRate] = useState(getConversionRate().toString());

  const handleSave = () => {
    const parsed = parseFloat(rate);
    if (isNaN(parsed) || parsed <= 0) {
      toast({ title: 'Invalid rate', description: 'Please enter a positive number.', variant: 'destructive' });
      return;
    }
    setConversionRate(parsed);
    toast({ title: 'Conversion rate updated', description: `PHP → JPY rate set to ${parsed}` });
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Settings className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Settings</h1>
            <p className="text-sm text-muted-foreground mt-0.5">System configuration</p>
          </div>
        </div>

        {/* Currency Conversion Settings */}
        <div className="rounded-xl border border-border bg-card p-6 max-w-lg">
          <h3 className="text-sm font-semibold text-card-foreground mb-4">Currency Conversion</h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rate" className="text-sm text-card-foreground">
                PHP → JPY Conversion Rate
              </Label>
              <p className="text-xs text-muted-foreground">
                Formula: JPY = PHP ÷ Rate. Default: 0.42
              </p>
              <div className="flex items-center gap-3">
                <Input
                  id="rate"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  className="w-32"
                />
                <Button onClick={handleSave} size="sm">
                  Save
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Example: PHP 10,000 ÷ {rate} = ¥ {Math.round(10000 / (parseFloat(rate) || 0.42)).toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">More settings coming soon. Connect Lovable Cloud to enable authentication, roles, and database.</p>
        </div>
      </div>
    </AppLayout>
  );
}
