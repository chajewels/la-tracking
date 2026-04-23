
Goal: unblock the edge-function build by fixing the shared email template typing issue, then validate that the cascade is cleared and deploy the six requested backend functions.

1. Fix the shared email template typing error
- Update `supabase/functions/_shared/transactional-email-templates/penalty-applied.tsx`.
- Change the `<Preview>` content so it is built as a string before rendering, matching the existing pattern already used in `payment-reminder.tsx`.
- Keep `daysOverdue` as a numeric prop everywhere else in the email body; only the preview line changes.

2. Preserve current email behavior and branding
- Keep the existing subject line, preview data, luxury styling, copy, and portal CTA unchanged.
- Do not alter the registry entry or any other template unless another blocking type error appears during validation.

3. Re-run type/build validation for the affected functions
- Validate that the shared template fix removes the cascading failure from all functions importing the transactional email registry, including:
  - `bulk-import`
  - `create-layaway-account`
  - `add-penalty`
  - `create-team-member`
  - `auto-forfeit-settlement`
  - `finance-reconciliation`
  - `dashboard-summary`
  - `edit-payment-submission`
  - `parse-import-docs`
  - `penalty-engine`
  - `record-multi-payment`
  - `preview-transactional-email`
  - `reactivate-account`
  - `record-payment`
  - `restore-payment`
  - `restructure-account`
  - `send-reminders`
  - `system-health-v2`
  - `send-transactional-email`
  - `void-payment`
- If any additional blocker remains after the preview fix, apply only the smallest safe change required to complete deployment.

4. Deploy the six requested backend functions
- Deploy:
  - `void-payment`
  - `approve-waiver`
  - `reactivate-account`
  - `penalty-engine`
  - `manual-forfeit`
  - `auto-forfeit-settlement`
- Use the current project function configuration already defined in `supabase/config.toml`.

5. Report deployment results clearly
- Return a per-function status summary:
  - deployed successfully
  - blocked with reason
  - any follow-up action required
- If all succeed, confirm the build issue is resolved and the six functions are live.

Technical details
- Root cause: `@react-email/components` types require string-compatible content for `<Preview>`, and `daysOverdue` is currently injected as a number inside `penalty-applied.tsx`.
- The safest implementation is to create a single `previewText` string, then render `<Preview>{previewText}</Preview>`.
- No database migration is required.
- No frontend publish step is required for this backend-only work; function deployments go live immediately after successful deployment.
