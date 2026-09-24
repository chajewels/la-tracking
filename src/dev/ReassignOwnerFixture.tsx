/**
 * DEV-only Playwright fixture for ReassignOwnerDialog (/__fixtures/?view=reassign-owner).
 * A fixture has no session and the edge function is not deployed, so the two
 * network calls the dialog makes are answered here with canned payloads in
 * the exact shape reassign_order_owner_atomic returns:
 *   - supabase.functions.invoke('reassign-order-owner') → preview / applied
 *   - supabase.from('loyalty_members')                   → candidate tier/points
 * Three dialogs: a layaway catch-up, a cash order whose points are born
 * expired, and a layaway that is refused because its owner has points.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReassignOwnerDialog from '@/components/accounts/ReassignOwnerDialog';
import { supabase } from '@/integrations/supabase/client';

const side = (id: string, name: string, member: null | { tier: string; points: number; spend: number }) => ({
  customer_id: id, full_name: name, is_test: false,
  enrolled: !!member, enrolled_at: member ? '2026-01-10T00:00:00Z' : null, tier: member?.tier ?? null,
  points: member?.points ?? 0, points_earned: member?.points ?? 0, spend_jpy: member?.spend ?? 0,
  has_points: !!member && member.points > 0,
});

function payload(orderId: string, targetId: string, targetName: string, apply: boolean) {
  const base = {
    ok: true, applied: false, order_id: orderId, status: 'active',
    current: side('fixture-owner', 'Carmela Bautista', null),
    target: side(targetId, targetName, { tier: 'Radiant', points: 0, spend: 0 }),
    refusals: [] as { code: string; message: string }[],
    can_apply: true,
    loyalty_jpy_amount: { stored: 250000, proposed: null, effective: 250000, changes: false },
    award_point: { at: '2026-08-02T02:00:00Z', source: 'downpayment_payment' },
    child_rows: { payment_submissions: 2, extension_requests: 0, service_jobs: 1, service_requests: 0, checkout_quotes: 0, csr_notifications: 1, ship_to_address_detached: 0 },
  };
  let p;
  if (orderId === 'fixture-reassign-refused') {
    p = {
      ...base, invoice_number: '18777', order_date: '2026-08-01', can_apply: false,
      current: side('fixture-owner', 'Carmela Bautista', { tier: 'Glimmer', points: 1200, spend: 120000 }),
      refusals: [{ code: 'points_account_is_current_owner', message: "This order stays with Carmela Bautista: Carmela Bautista's account has loyalty history." }],
      catch_up: { eligible: false, reason: 'not_at_award_point', grace_days: 3, expected_points: 0, below_minimum: false, expired_on_award: false, lot_expires_on: '2027-01-28', loyalty_enabled: true },
    };
  } else if (orderId === 'fixture-reassign-cash') {
    p = {
      ...base, invoice_number: '19506', order_date: '2026-02-01',
      award_point: { at: '2026-02-05T01:00:00Z', source: 'fully_paid_payment' },
      child_rows: { ...base.child_rows, ship_to_address_detached: 1, csr_notifications: 0 },
      catch_up: { eligible: true, reason: 'eligible', grace_days: 3, expected_points: 3600, below_minimum: false, expired_on_award: true, lot_expires_on: '2026-07-31', loyalty_enabled: true },
    };
  } else {
    p = {
      ...base, invoice_number: '18042', order_date: '2026-08-01',
      catch_up: { eligible: true, reason: 'eligible', grace_days: 3, expected_points: 5000, below_minimum: false, expired_on_award: false, lot_expires_on: '2027-01-28', loyalty_enabled: true },
    };
  }
  if (!apply) return p;
  return { ...p, applied: true, award: { outcome: 'awarded', awarded: true, points_earned: p.catch_up.expected_points } };
}

function stubNetwork() {
  // supabase.functions is a getter that builds a new FunctionsClient on every
  // access, so the stub goes on the class prototype, not on one instance.
  type Invoke = (this: unknown, name: string, o: { body: Record<string, unknown> }) => Promise<unknown>;
  const proto = Object.getPrototypeOf(supabase.functions) as { invoke: Invoke };
  const realInvoke = proto.invoke;
  proto.invoke = async function (name, o) {
    if (name !== 'reassign-order-owner') return realInvoke.call(this, name, o);
    await new Promise((r) => setTimeout(r, 250));
    const b = o.body;
    return { data: payload(String(b.order_id), String(b.new_customer_id), 'Selected customer', b.apply === true), error: null };
  };
  const client = supabase as unknown as { from: (t: string) => unknown };
  const realFrom = client.from.bind(client);
  client.from = (t: string) => {
    if (t !== 'loyalty_members') return realFrom(t);
    return {
      select: () => ({
        in: async (_col: string, ids: string[]) => ({
          data: ids.filter((_, i) => i % 3 !== 2).map((id, i) => ({
            customer_id: id, remaining_points: i * 700, cumulative_spend_jpy: i * 65000,
            current_tier: { name: i % 4 === 0 ? 'Glimmer' : 'Radiant' },
          })),
          error: null,
        }),
      }),
    };
  };
}

export default function ReassignOwnerFixture() {
  const queryClient = useQueryClient();
  useState(() => {
    stubNetwork();
    for (const [kind, id] of [['layaway', 'fixture-reassign-layaway'], ['cash', 'fixture-reassign-cash'], ['layaway', 'fixture-reassign-refused']]) {
      queryClient.setQueryDefaults(['order-loyalty-award', kind, id], { staleTime: Infinity, retry: false });
      queryClient.setQueryData(['order-loyalty-award', kind, id], { awarded: false, points: 0, spend: 0, at: null });
    }
    return null;
  });
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h2 className="font-display text-lg text-card-foreground">Reassign Owner — fixture</h2>
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1"><p className="text-xs text-muted-foreground">Layaway · catch-up</p>
          <ReassignOwnerDialog kind="layaway" orderId="fixture-reassign-layaway" invoiceNumber="18042" currentCustomerId="fixture-cust-0010"
            currentCustomerName="Carmela Bautista" status="active" loyaltyJpyAmount={250000} suggestedLoyaltyJpy={250000} /></div>
        <div className="space-y-1"><p className="text-xs text-muted-foreground">Cash · born expired</p>
          <ReassignOwnerDialog kind="cash" orderId="fixture-reassign-cash" invoiceNumber="19506" currentCustomerId="fixture-cust-0010"
            currentCustomerName="Carmela Bautista" status="completed" loyaltyJpyAmount={null} suggestedLoyaltyJpy={180000} /></div>
        <div className="space-y-1"><p className="text-xs text-muted-foreground">Layaway · refused</p>
          <ReassignOwnerDialog kind="layaway" orderId="fixture-reassign-refused" invoiceNumber="18777" currentCustomerId="fixture-cust-0010"
            currentCustomerName="Carmela Bautista" status="active" loyaltyJpyAmount={250000} /></div>
      </div>
    </div>
  );
}
