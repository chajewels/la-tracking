import { Currency, ScheduleItem } from './types';

/**
 * Format currency amount with proper symbol and formatting.
 * All amounts are whole currency units (no decimals).
 */
export function formatCurrency(amount: number, currency: Currency): string {
  const symbol = currency === 'PHP' ? '₱' : '¥';
  // PHP may have decimals; JPY is always whole units
  if (currency === 'JPY') {
    return `${symbol} ${Math.round(amount).toLocaleString('en-US')}`;
  }
  const rounded = Math.round(amount * 100) / 100;
  const formatted = rounded % 1 === 0
    ? rounded.toLocaleString('en-US')
    : rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${symbol} ${formatted}`;
}

export function formatCurrencyWithCode(amount: number, currency: Currency): string {
  const formatted = Math.round(amount).toLocaleString('en-US');
  return `${currency} ${formatted}`;
}

/**
 * Generate payment schedule dates based on order date and plan.
 * Each installment falls on the same day of month as the order date.
 */
export function generateScheduleDates(orderDate: string, planMonths: number): string[] {
  const start = new Date(orderDate);
  const dayOfMonth = start.getDate();
  const dates: string[] = [];

  for (let i = 0; i < planMonths; i++) {
    const date = new Date(start.getFullYear(), start.getMonth() + i, dayOfMonth);
    // Handle months with fewer days (e.g., Feb 30 -> Feb 28)
    if (date.getDate() !== dayOfMonth) {
      date.setDate(0); // last day of previous month
    }
    dates.push(date.toISOString().split('T')[0]);
  }
  return dates;
}

/**
 * Calculate installment amounts with remainder distribution.
 * Remainder is added to the NEXT (first unpaid) payment only.
 */
export function calculateInstallments(
  remainingBalance: number,
  remainingMonths: number
): number[] {
  if (remainingMonths <= 0) return [];
  
  const balance = Math.round(remainingBalance);
  const baseAmount = Math.floor(balance / remainingMonths);
  const remainder = balance - baseAmount * remainingMonths;

  const installments: number[] = [];
  for (let i = 0; i < remainingMonths; i++) {
    installments.push(i === 0 ? baseAmount + remainder : baseAmount);
  }
  return installments;
}

/**
 * Build a full payment schedule with penalty support.
 */
export function buildSchedule(
  accountId: string,
  totalAmount: number,
  totalPaid: number,
  orderDate: string,
  planMonths: number,
  paidInstallments: number,
  penalties: { monthNumber: number; amount: number }[] = []
): ScheduleItem[] {
  const dates = generateScheduleDates(orderDate, planMonths);
  const remainingBalance = totalAmount - totalPaid;
  const remainingMonths = planMonths - paidInstallments;
  const installments = calculateInstallments(remainingBalance, remainingMonths);

  const schedule: ScheduleItem[] = [];

  for (let i = 0; i < planMonths; i++) {
    const isPaid = i < paidInstallments;
    const unpaidIndex = i - paidInstallments;
    const baseAmount = isPaid ? 0 : (installments[unpaidIndex] || 0);
    const penalty = penalties.find(p => p.monthNumber === i + 1);
    const penaltyAmount = penalty?.amount || 0;

    schedule.push({
      id: `${accountId}-${i + 1}`,
      account_id: accountId,
      month_number: i + 1,
      due_date: dates[i],
      base_amount: baseAmount,
      penalty_amount: penaltyAmount,
      total_due: baseAmount + penaltyAmount,
      paid_amount: isPaid ? baseAmount : 0,
      is_paid: isPaid,
    });
  }

  return schedule;
}

/**
 * Generate customer Messenger message.
 */
export function generateCustomerMessage(
  invoiceNumber: string,
  customerName: string,
  totalAmount: number,
  totalPaid: number,
  currency: Currency,
  schedule: ScheduleItem[],
  totalPenalty: number
): string {
  const remaining = totalAmount - totalPaid;
  const unpaidItems = schedule.filter(s => !s.is_paid);
  const remainingMonths = unpaidItems.length;

  let message = `✨ Cha Jewels Layaway Payment Summary\n\n`;
  message += `Inv # ${invoiceNumber}\n`;
  
  if (totalPenalty > 0) {
    message += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)} + ${formatCurrency(totalPenalty, currency)} (Penalty)\n`;
  } else {
    message += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)}\n`;
  }
  
  message += `Amount Paid: ${formatCurrency(totalPaid, currency)}\n\n`;
  message += `================\n\n`;
  message += `${customerName} remaining balance - ${formatCurrency(remaining, currency)} to pay in ${remainingMonths} months\n\n`;
  message += `Monthly Payment:\n\n`;

  const ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

  unpaidItems.forEach((item, idx) => {
    const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    if (item.penalty_amount > 0) {
      message += `${ordinals[idx]} month ${dateStr}: ${formatCurrency(item.base_amount, currency)} + ${formatCurrency(item.penalty_amount, currency)} (Penalty) = ${formatCurrency(item.total_due, currency)}\n`;
    } else {
      message += `${ordinals[idx]} month ${dateStr}: ${formatCurrency(item.base_amount, currency)}\n`;
    }
  });

  if (unpaidItems.length > 0) {
    // Next-due +14 day rule: if the next item has penalty and is overdue, shift by 14 days
    const nextItem = unpaidItems[0];
    const now = new Date();
    const dueDate = new Date(nextItem.due_date);
    const isOverdue = dueDate < now;
    const hasPenalty = nextItem.penalty_amount > 0;
    
    let displayDate: Date;
    if (hasPenalty && isOverdue) {
      displayDate = new Date(dueDate);
      displayDate.setDate(displayDate.getDate() + 14);
    } else {
      displayDate = dueDate;
    }
    
    const nextDate = displayDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    message += `\nPlease note your next monthly payment is on ${nextDate}. Please expect another payment reminder from us.\n\n`;
    message += `Thank you for your continued trust in Cha Jewels. We appreciate your business! 💛`;
  }

  return message;
}

/**
 * Check if a payment is overdue and calculate penalty.
 */
export function checkOverdue(dueDate: string): { isOverdue: boolean; daysOverdue: number; penaltyWeeks: number } {
  const now = new Date();
  const due = new Date(dueDate);
  const diffMs = now.getTime() - due.getTime();
  const daysOverdue = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (daysOverdue <= 0) {
    return { isOverdue: false, daysOverdue: 0, penaltyWeeks: 0 };
  }

  const penaltyWeeks = Math.floor(daysOverdue / 7);
  return { isOverdue: true, daysOverdue, penaltyWeeks };
}
