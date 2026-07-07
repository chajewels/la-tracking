import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Users } from 'lucide-react';
import StatCard from '@/components/dashboard/StatCard';

/**
 * Regression lock for the Phase 3 StatCard extension: the new sparkline /
 * count-up props are STRICTLY additive. These snapshots were generated from
 * the pre-extension component; every legacy prop combination (covering all
 * 48 existing render sites' prop shapes) must keep byte-identical markup.
 */
function markup(el: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);
}

describe('StatCard legacy markup (pre-Phase-3 baseline)', () => {
  it('minimal', () => {
    expect(markup(<StatCard title="Total Customers" value="662" icon={Users} />)).toMatchSnapshot();
  });

  it('with subtitle', () => {
    expect(markup(<StatCard title="Completed" value="12" subtitle="This month" icon={Users} />)).toMatchSnapshot();
  });

  it('with trend', () => {
    expect(
      markup(<StatCard title="Collections" value="¥1,234,567" icon={Users} trend={{ value: '12%', positive: true }} />),
    ).toMatchSnapshot();
  });

  it.each(['default', 'gold', 'success', 'warning', 'danger'] as const)('variant %s', (variant) => {
    expect(markup(<StatCard title="Overdue" value="8" icon={Users} variant={variant} />)).toMatchSnapshot();
  });

  it('with href and staggerIndex', () => {
    expect(
      markup(<StatCard title="Due Today" value="3" icon={Users} href="/monitoring?filter=due_today" staggerIndex={2} />),
    ).toMatchSnapshot();
  });
});
