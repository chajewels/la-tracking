<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

### Forensic repair (manual customer_code edits)

  If a customer_code is ever corrupted (e.g., a row backfilled
  from an external source with malformed data, or a manual
  override before the EditCustomer lock landed on 2026-04-28),
  the only repair path is direct SQL Editor.

  After the prevent_customer_code_change trigger landed
  (2026-05-08), forensic repairs require a transaction-scoped
  GUC bypass via SET LOCAL. Without it, the UPDATE fails with:
  "customer_code is immutable post-creation..."

    BEGIN;
    SET LOCAL app.allow_customer_code_change = 'on';
    UPDATE public.customers
       SET customer_code = 'CJ-YYYY-XXXXX'
     WHERE id = '<uuid>';
    INSERT INTO public.audit_logs
      (entity_type, entity_id, action,
       old_value_json, new_value_json,
       performed_by_user_id)
    VALUES ('customer', '<uuid>',
            'manual_customer_code_repair',
            jsonb_build_object('customer_code', '<old>'),
            jsonb_build_object('customer_code', 'CJ-YYYY-XXXXX'),
            auth.uid());
    COMMIT;

  EditCustomerDialog UI does NOT allow customer_code edits
  (locked 2026-04-28 after the Charm Monaka incident — see
  Known Fixed Bugs #54).

