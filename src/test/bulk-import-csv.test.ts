import { describe, it, expect } from 'vitest';
import { parseCSV } from '@/pages/BulkPaymentImport';

// The optional 6th column (proof_url) rides along; five-column files still parse.
describe('bulk import CSV', () => {
  it('reads the optional proof_url column and defaults method to cash', () => {
    const rows = parseCSV('invoice,amount,date,method,remarks,proof_url\n18189,3136,2026-10-01,,Oct catch-up,https://x.test/p.jpg\n18190,2800,2026-10-01,gcash,\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rowNum: 1, invoice_number: '18189', amount_paid: '3136', payment_method: 'cash', remarks: 'Oct catch-up', proof_url: 'https://x.test/p.jpg' });
    expect(rows[1]).toMatchObject({ invoice_number: '18190', payment_method: 'gcash', remarks: '', proof_url: '' });
  });
  it('skips blank and header-only input', () => {
    expect(parseCSV('invoice,amount\n')).toEqual([]);
    expect(parseCSV('invoice,amount,date\n,,\n')).toEqual([]);
  });
});
