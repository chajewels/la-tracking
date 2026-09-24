import { cn } from '@/lib/utils';

/**
 * The one "this is a test record" tag (customers.is_test / TEST- invoices).
 * Test customers stay findable in the directory, but every place that shows
 * one must say so (owner decision 2026-09-24); dashboard totals exclude them
 * (CLAUDE.md TEST ACCOUNT EXCLUSION).
 */
export default function TestTag({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded-md border border-info/20 bg-info/10 px-1.5 py-0.5 text-[10px] font-bold text-info', className)}
      title="Test customer — excluded from dashboard totals"
    >
      🧪 TEST
    </span>
  );
}
