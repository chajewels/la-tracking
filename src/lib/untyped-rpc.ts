import { supabase } from '@/integrations/supabase/client';

/**
 * Call an RPC that is not (yet) in the auto-generated types.
 *
 * ALWAYS call it as a METHOD on the client. `const rpc = supabase.rpc; rpc(…)`
 * detaches it, and supabase-js's rpc() reads `this.rest`, so the call throws
 * "Cannot read properties of undefined (reading 'rest')" before any request is
 * sent. That is what kept the sidebar's "Email status unknown" and "Portal link
 * status unknown" pills permanently unknown from 2026-09-13 / -15 to 2026-09-24.
 */
type UntypedRpc = (
  fn: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export async function callUntypedRpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const client = supabase as unknown as { rpc: UntypedRpc };
  const { data, error } = await client.rpc(fn, args);
  if (error) throw error;
  return data as T;
}
