/**
 * parse-import-docs — RETIRED (2026-08-01)
 *
 * One-time migration tooling for the March 2026 bulk-import cohort.
 *
 * Its AI system prompt hardcoded the 2024-2025 import season for year
 * inference ("Use year 2025 for months Oct-Dec and 2025 for Jan-Sep",
 * "due_date (use year 2025 for most dates)"). That line also contained a
 * contradiction — both branches said 2025. Any document parsed after that
 * season would be silently stamped with 2025 dates.
 *
 * It had zero callers in the app: nothing in src/ referenced it, and the
 * only insert path it fed (bulk-import) is likewise unreferenced.
 *
 * The DB trigger that used to reject wrong-year installment 1 rows
 * (trg_validate_schedule_start_year) was dropped 2026-08-01 as Bug #253 —
 * it had become permanently unsatisfiable and was blocking ALL layaway
 * account creation. Nothing validates this function's output any more.
 *
 * Do NOT re-enable. If historical document import is ever needed again,
 * write a new function that takes the base year as an explicit parameter
 * instead of inferring it from a hardcoded season.
 */
Deno.serve(async (_req) => {
  return new Response(
    JSON.stringify({
      error: "parse-import-docs is retired. It hardcoded the 2024-2025 import season for year inference.",
      disabled: true,
    }),
    {
      status: 410,
      headers: { "Content-Type": "application/json" },
    }
  );
});
