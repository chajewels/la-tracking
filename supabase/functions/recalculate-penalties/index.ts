/**
 * recalculate-penalties — DISABLED (2026-04-10)
 *
 * This function was silently waiving penalties that penalty-engine
 * correctly created, corrupting account states with no audit trail.
 *
 * Use penalty-engine (daily cron) for all penalty management.
 * Use add-penalty for manual single-penalty additions.
 * Use approve-waiver for admin-approved penalty waivers.
 */
Deno.serve(async (_req) => {
  return new Response(
    JSON.stringify({
      error: "recalculate-penalties is disabled. Use penalty-engine for penalty management.",
      disabled: true,
    }),
    {
      status: 410,
      headers: { "Content-Type": "application/json" },
    }
  );
});
