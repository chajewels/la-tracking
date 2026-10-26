-- ============================================================================
-- Expenses — purchases booked straight to cost of sales (owner 2026-10-26 23:51 JST).
--
-- Changes Phase 5 decision D2. The owner will not enter a cost per sale; purchases are the cost of sales
-- in the month they are bought (the periodic method the 税理士 uses: 仕入高 = 売上原価, a stock count trues
-- it up at year end). So the "Inventory purchases" category posts to 5100 instead of 1300.
--
-- Unchanged: trade-in buybacks still go to 1310 and reach 5500 when the piece is resold (automatic, per
-- piece); the per-sale cost machinery (sale_costs, cogs_sale / cogs_return events, Cost of goods tab) stays
-- in place and simply posts nothing while no sale has a cost. 1300 keeps the opening balance; the year-end
-- stock count is a manual journal 1300 <-> 5100 for (counted - opening).
--
-- Re-runnable. Reference data only; no function changes. Expense journals already posted with the old
-- account (none on live at the time) would be reversed and reposted by the engine on the next run.
-- ============================================================================

SET lock_timeout = '15s';

UPDATE public.expense_categories
   SET gl_account_code = '5100'
 WHERE group_key = 'cost_of_goods'
   AND name = 'Inventory purchases (supplier, gold, preloved buys)'
   AND gl_account_code IS DISTINCT FROM '5100';
