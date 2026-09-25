import { supabase } from '@/integrations/supabase/client';

/**
 * page365_stock_lines ships in migration 20260926120000_page365_stock_sync and
 * is not in src/integrations/supabase/types.ts until Lovable regenerates it on
 * its next deploy. types.ts is never hand-edited (CLAUDE.md, GENERATED FILES),
 * so the one untyped access lives here instead of as a cast at every call site.
 * Rows are read as Page365StockLine (src/lib/page365-stock.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untyped = supabase as unknown as { from: (table: string) => any };

export const ledgerTable = () => untyped.from('page365_stock_lines');
