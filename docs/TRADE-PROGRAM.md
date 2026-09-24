<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## TRADE PROGRAM — NON-NEGOTIABLE (added 2026-05-31)

### Overview
Trade Program lets fully-paid layaway customers exchange their item for a new piece. The is_trade flag on layaway_accounts and cash_orders identifies accounts/orders that originated from a trade transaction. Policy: https://chajewelstrade.chajewelsjp.com/

### is_trade flag rules
  - Set at creation only — LOCKED after creation, never editable via app UI
  - Admin override via SQL Editor is permitted for one-time backfills only
  - Pure metadata — has NO effect on calculations, payments, penalties, forfeiture, or any business rule
  - Default false on all accounts

### Display
  - "🔄 Trade" amber Badge rendered next to status pill in AccountDetail + CashOrderDetail headers
  - Visible to all roles when is_trade=true
  - No badge column in list tables (admin decision — keeps lists clean)

### Metric definitions (Finance Overview KPI cards + trend chart)
  - Active Trade: is_trade=true AND status IN ('active','overdue','extension_active','reactivated') — LAYAWAY ONLY (cash orders have no in-progress state, only completed/cancelled)
  - Total Trade: is_trade=true AND status::text != 'cancelled' — layaway + cash orders combined
  - Completed Trade: is_trade=true AND status='completed' — layaway + cash orders combined
  - Total Trade Value (JPY): SUM(total_amount) WHERE is_trade=true AND status::text != 'cancelled', PHP converted via ÷ php_jpy_rate
  - Trade Share %: (Total Trade count) / (All non-cancelled accounts count, layaway + cash combined) × 100

### RPCs (Supabase SQL Editor)
  - get_trade_kpis() → jsonb { active_count, total_count, completed_count, total_value_jpy, share_percent, all_accounts_count }
  - get_trade_monthly_trends(p_months_back int DEFAULT 12) → TABLE (month text, trade_count int, trade_value_jpy numeric); date basis: COALESCE(order_date, created_at::date); excludes cancelled

### UI surfaces (locked decisions)
  - Creation: "Trade Program" checkbox in NewAccount.tsx + NewCashOrder.tsx with amber tint when checked and policy link
  - Detail badge: amber-styled Badge next to status pill in AccountDetail.tsx + CashOrderDetail.tsx
  - Finance > Overview: 3 KPI StatCards (Trade Accounts / Total Trade Value / Trade Share) between Cash Orders row and AgingBuckets
  - Finance > Overview: TradeProgramTrends dual-line Recharts chart below MonthlyAnalyticsChart

