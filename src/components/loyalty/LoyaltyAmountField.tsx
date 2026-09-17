import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { OrderLoyaltyAward } from '@/hooks/useOrderLoyaltyAward';

interface LoyaltyAmountFieldProps {
  value: string;
  onChange: (v: string) => void;
  /** Customer is a loyalty member → amount is required (> 0). */
  required: boolean;
  /** edit_loyalty_amount */
  canEdit: boolean;
  award: OrderLoyaltyAward | undefined;
  awardLoading: boolean;
  /** (total − shipping) expressed in JPY; null hides the nudge. */
  suggestedJpy: number | null;
  disabled?: boolean;
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`;

export default function LoyaltyAmountField({
  value, onChange, required, canEdit, award, awardLoading, suggestedJpy, disabled,
}: LoyaltyAmountFieldProps) {
  const awarded = award?.awarded === true;
  const editable = canEdit && !awarded && !awardLoading && !disabled;
  const current = value.trim() === '' ? null : Number(value);
  const missing = required && editable && (current === null || !(current > 0));
  const showNudge =
    editable && suggestedJpy !== null && suggestedJpy > 0 && current !== Math.round(suggestedJpy);

  return (
    <div className="space-y-1.5">
      <Label className={`text-xs ${missing ? 'text-destructive' : 'text-muted-foreground'}`}>
        Loyalty Product Amount (JPY){required ? ' *' : ''}
      </Label>
      <Input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. 107143"
        disabled={!editable}
        className={`h-9 text-sm tabular-nums ${editable ? 'bg-background' : 'bg-muted cursor-not-allowed'}`}
        title={!canEdit ? 'Only admins and permitted staff can edit the loyalty amount.' : undefined}
      />
      {awarded && (
        <p className="text-[11px] text-muted-foreground">
          Points were already awarded on {yen(award!.spend)} ({award!.points.toLocaleString('en-US')} points
          {award!.at ? `, ${award!.at.slice(0, 10)}` : ''}). Changing this amount would not change the points, so it is locked.
        </p>
      )}
      {!awarded && !canEdit && (
        <p className="text-[11px] text-muted-foreground">Read-only — requires the Edit Loyalty Amount permission.</p>
      )}
      {missing && (
        <p className="text-[11px] text-destructive font-medium">Required for loyalty members.</p>
      )}
      {showNudge && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-amber-400/40 bg-amber-400/5 px-2 py-1.5">
          <span className="text-[11px] text-amber-400">
            Loyalty amount is {current === null ? 'empty' : yen(current)} — the order is {yen(suggestedJpy!)} (total − shipping).
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 text-[11px] border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
            onClick={() => onChange(String(Math.round(suggestedJpy!)))}
          >
            Use {yen(suggestedJpy!)}
          </Button>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        Product value in JPY only. Exclude shipping, service fees, and insurance. Used for loyalty points — not shown to the customer.
      </p>
    </div>
  );
}
