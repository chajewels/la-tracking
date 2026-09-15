-- Triggers: exactly the pg_get_triggerdef output from live (2026-09-15) for the
-- tables these three RPCs touch. Omitted: cash-order triggers that reference
-- tables outside the harness (support verifier is included; the Shopify/sync
-- ones are listed below and noted as absent).
CREATE TRIGGER enforce_total_amount_admin_only BEFORE UPDATE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION prevent_total_amount_change();
CREATE TRIGGER layaway_accounts_autofill_support_verifier AFTER INSERT ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION autofill_sales_log_support_verifier();
CREATE TRIGGER trg_audit_layaway_accounts AFTER INSERT OR DELETE OR UPDATE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION log_admin_table_change();
CREATE TRIGGER trg_enforce_plan_minimum BEFORE INSERT OR UPDATE OF payment_plan_months, total_amount, currency ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION enforce_plan_minimum_amount();
CREATE TRIGGER trg_note_account_status_change AFTER UPDATE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION note_account_status_change();
CREATE TRIGGER trg_notify_account_created AFTER INSERT ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION notify_account_created();
CREATE TRIGGER trg_prevent_paid_layaway_delete BEFORE DELETE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION prevent_paid_order_delete();
CREATE TRIGGER trg_prevent_web_layaway_delete BEFORE DELETE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION prevent_web_layaway_delete();
CREATE TRIGGER trg_test_invoice_prefix_layaway BEFORE INSERT OR UPDATE OF invoice_number, customer_id ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION enforce_test_invoice_prefix();
CREATE TRIGGER trigger_set_completed_at BEFORE UPDATE ON public.layaway_accounts FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION set_completed_at();
CREATE TRIGGER update_layaway_accounts_updated_at BEFORE UPDATE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER enforce_immutable_base BEFORE UPDATE ON public.layaway_schedule FOR EACH ROW EXECUTE FUNCTION prevent_base_amount_change();
CREATE TRIGGER enforce_paid_row_freeze BEFORE UPDATE ON public.layaway_schedule FOR EACH ROW EXECUTE FUNCTION prevent_paid_row_modification();
CREATE TRIGGER log_schedule_deletion_trigger AFTER DELETE ON public.layaway_schedule FOR EACH ROW EXECUTE FUNCTION log_schedule_deletion();
CREATE TRIGGER prevent_schedule_deletion_trigger BEFORE DELETE ON public.layaway_schedule FOR EACH ROW EXECUTE FUNCTION prevent_schedule_deletion();
CREATE TRIGGER trg_validate_schedule_chronology BEFORE INSERT OR UPDATE OF due_date ON public.layaway_schedule FOR EACH ROW EXECUTE FUNCTION validate_schedule_chronology();
CREATE TRIGGER update_layaway_schedule_updated_at BEFORE UPDATE ON public.layaway_schedule FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_auto_waive_same_day AFTER INSERT ON public.payment_submissions FOR EACH ROW EXECUTE FUNCTION auto_waive_same_day_penalties();
CREATE TRIGGER trg_notify_submission_created AFTER INSERT ON public.payment_submissions FOR EACH ROW EXECUTE FUNCTION notify_submission_created();

CREATE TRIGGER trg_audit_payments AFTER INSERT OR DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION log_admin_table_change();
CREATE TRIGGER trigger_auto_backup_payment AFTER INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION auto_backup_payment();

CREATE TRIGGER trg_website_variants_revalidate AFTER INSERT OR DELETE OR UPDATE ON public.website_product_variants FOR EACH ROW EXECUTE FUNCTION notify_website_revalidate();
CREATE TRIGGER trg_website_variants_updated_at BEFORE UPDATE ON public.website_product_variants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER cash_orders_autofill_support_verifier AFTER INSERT ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION autofill_sales_log_support_verifier();
CREATE TRIGGER cash_orders_updated_at BEFORE UPDATE ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION update_cash_orders_updated_at();
CREATE TRIGGER trg_prevent_paid_cash_order_delete BEFORE DELETE ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION prevent_paid_order_delete();

CREATE TRIGGER auto_generate_customer_code BEFORE INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
