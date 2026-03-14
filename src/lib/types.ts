export type Currency = 'PHP' | 'JPY';
export type PaymentPlan = 3 | 6;
export type AccountStatus = 'active' | 'completed' | 'defaulted' | 'cancelled';
export type PenaltyStatus = 'pending' | 'paid' | 'waived';
export type WaiverStatus = 'pending' | 'approved' | 'rejected';
export type RiskLevel = 'low' | 'medium' | 'high';
export type CLVTier = 'high' | 'medium' | 'low';

export interface Customer {
  id: string;
  name: string;
  facebook_name?: string;
  messenger_link?: string;
  phone?: string;
  email?: string;
  clv_score?: CLVTier;
  created_at: string;
}

export interface LayawayAccount {
  id: string;
  invoice_number: string;
  customer_id: string;
  customer: Customer;
  currency: Currency;
  total_amount: number;
  payment_plan: PaymentPlan;
  order_date: string;
  status: AccountStatus;
  total_paid: number;
  remaining_balance: number;
  created_at: string;
}

export interface ScheduleItem {
  id: string;
  account_id: string;
  month_number: number;
  due_date: string;
  base_amount: number;
  penalty_amount: number;
  total_due: number;
  paid_amount: number;
  is_paid: boolean;
  paid_date?: string;
}

export interface Payment {
  id: string;
  account_id: string;
  amount: number;
  currency: Currency;
  payment_date: string;
  recorded_by: string;
  notes?: string;
}

export interface Penalty {
  id: string;
  account_id: string;
  schedule_item_id: string;
  amount: number;
  currency: Currency;
  reason: string;
  status: PenaltyStatus;
  applied_date: string;
}

export interface PenaltyWaiver {
  id: string;
  penalty_id: string;
  requested_by: string;
  reason: string;
  status: WaiverStatus;
  reviewed_by?: string;
  reviewed_at?: string;
  created_at: string;
}

export interface AgingBucket {
  label: string;
  count: number;
  amount: number;
  currency: Currency;
}

export interface CollectionSummary {
  today: number;
  yesterday: number;
  thisWeek: number;
  thisMonth: number;
  thisYear: number;
  currency: Currency;
}
