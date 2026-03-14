import { Customer, LayawayAccount, Payment, Currency } from './types';

export const mockCustomers: Customer[] = [
  { id: 'c1', name: 'Maria Santos', facebook_name: 'maria.santos', messenger_link: 'https://m.me/maria.santos', phone: '+63 917 123 4567', clv_score: 'high', created_at: '2024-06-01' },
  { id: 'c2', name: 'LA JUN', facebook_name: 'la.jun', messenger_link: 'https://m.me/la.jun', phone: '+81 90 1234 5678', clv_score: 'medium', created_at: '2024-08-15' },
  { id: 'c3', name: 'Yuki Tanaka', facebook_name: 'yuki.tanaka', messenger_link: 'https://m.me/yuki.tanaka', clv_score: 'high', created_at: '2024-03-10' },
  { id: 'c4', name: 'Ana Reyes', facebook_name: 'ana.reyes', messenger_link: 'https://m.me/ana.reyes', phone: '+63 918 987 6543', clv_score: 'low', created_at: '2025-01-05' },
  { id: 'c5', name: 'Ken Watanabe', facebook_name: 'ken.wat', messenger_link: 'https://m.me/ken.wat', clv_score: 'medium', created_at: '2024-11-20' },
];

// Helper to get dates relative to today for realistic demo data
function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function monthsAgo(months: number, day?: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  if (day) d.setDate(day);
  return d.toISOString().split('T')[0];
}

export const mockAccounts: LayawayAccount[] = [
  {
    id: 'a1', invoice_number: '18351', customer_id: 'c1', customer: mockCustomers[0],
    currency: 'PHP', total_amount: 83311, payment_plan: 6, order_date: monthsAgo(2, 13),
    status: 'active', total_paid: 34716, remaining_balance: 48595, created_at: monthsAgo(2, 13),
  },
  {
    id: 'a2', invoice_number: '17833', customer_id: 'c2', customer: mockCustomers[1],
    currency: 'JPY', total_amount: 73780, payment_plan: 6, order_date: monthsAgo(2, 2),
    status: 'active', total_paid: 22134, remaining_balance: 51646, created_at: monthsAgo(2, 2),
  },
  {
    id: 'a3', invoice_number: '19001', customer_id: 'c3', customer: mockCustomers[2],
    currency: 'JPY', total_amount: 45000, payment_plan: 3, order_date: monthsAgo(1, 10),
    status: 'active', total_paid: 15000, remaining_balance: 30000, created_at: monthsAgo(1, 10),
  },
  {
    id: 'a4', invoice_number: '19102', customer_id: 'c4', customer: mockCustomers[3],
    currency: 'PHP', total_amount: 29638, payment_plan: 3, order_date: monthsAgo(1, 20),
    status: 'active', total_paid: 0, remaining_balance: 29638, created_at: monthsAgo(1, 20),
  },
  {
    id: 'a5', invoice_number: '18900', customer_id: 'c5', customer: mockCustomers[4],
    currency: 'JPY', total_amount: 120000, payment_plan: 6, order_date: monthsAgo(3, 15),
    status: 'active', total_paid: 60000, remaining_balance: 60000, created_at: monthsAgo(3, 15),
  },
  {
    id: 'a6', invoice_number: '17500', customer_id: 'c1', customer: mockCustomers[0],
    currency: 'PHP', total_amount: 55000, payment_plan: 3, order_date: monthsAgo(4, 1),
    status: 'completed', total_paid: 55000, remaining_balance: 0, created_at: monthsAgo(4, 1),
  },
];

export const mockPayments: Payment[] = [
  { id: 'p1', account_id: 'a1', amount: 24993, currency: 'PHP', payment_date: monthsAgo(2, 13), recorded_by: 'CSR Alice' },
  { id: 'p2', account_id: 'a1', amount: 9723, currency: 'PHP', payment_date: monthsAgo(1, 13), recorded_by: 'CSR Alice' },
  { id: 'p3', account_id: 'a2', amount: 12000, currency: 'JPY', payment_date: monthsAgo(2, 2), recorded_by: 'CSR Bob' },
  { id: 'p4', account_id: 'a2', amount: 10134, currency: 'JPY', payment_date: monthsAgo(1, 2), recorded_by: 'CSR Bob' },
  { id: 'p5', account_id: 'a3', amount: 15000, currency: 'JPY', payment_date: monthsAgo(1, 10), recorded_by: 'CSR Alice' },
  { id: 'p6', account_id: 'a5', amount: 20000, currency: 'JPY', payment_date: monthsAgo(3, 15), recorded_by: 'CSR Bob' },
  { id: 'p7', account_id: 'a5', amount: 20000, currency: 'JPY', payment_date: monthsAgo(2, 15), recorded_by: 'CSR Bob' },
  { id: 'p8', account_id: 'a5', amount: 20000, currency: 'JPY', payment_date: monthsAgo(1, 15), recorded_by: 'CSR Alice' },
  { id: 'p9', account_id: 'a6', amount: 18334, currency: 'PHP', payment_date: monthsAgo(4, 1), recorded_by: 'CSR Alice' },
  { id: 'p10', account_id: 'a6', amount: 18333, currency: 'PHP', payment_date: monthsAgo(3, 1), recorded_by: 'CSR Alice' },
  { id: 'p11', account_id: 'a6', amount: 18333, currency: 'PHP', payment_date: monthsAgo(2, 1), recorded_by: 'CSR Bob' },
];

export function getDashboardStats(currency?: Currency) {
  const activeAccounts = mockAccounts.filter(a => a.status === 'active' && (!currency || a.currency === currency));
  const totalReceivables = activeAccounts.reduce((sum, a) => sum + a.remaining_balance, 0);

  const now = new Date();
  const todayPayments = mockPayments.filter(p => {
    const d = new Date(p.payment_date);
    return d.toDateString() === now.toDateString() && (!currency || p.currency === currency);
  });

  const thisMonthPayments = mockPayments.filter(p => {
    const d = new Date(p.payment_date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && (!currency || p.currency === currency);
  });

  return {
    totalReceivables,
    activeAccounts: activeAccounts.length,
    collectionsToday: todayPayments.reduce((s, p) => s + p.amount, 0),
    collectionsThisMonth: thisMonthPayments.reduce((s, p) => s + p.amount, 0),
    overdueCount: 2,
    completedThisMonth: 1,
  };
}
