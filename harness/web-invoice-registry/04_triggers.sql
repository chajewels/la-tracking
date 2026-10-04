CREATE TRIGGER trg_checkout_quotes_reserve_invoice BEFORE INSERT ON public.checkout_quotes FOR EACH ROW EXECUTE FUNCTION checkout_quotes_reserve_invoice();
CREATE TRIGGER trg_zz_invoice_registry_cash BEFORE INSERT OR UPDATE OF invoice_number ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION register_invoice_number();
CREATE TRIGGER trg_zz_invoice_registry_layaway BEFORE INSERT OR UPDATE OF invoice_number ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION register_invoice_number();
CREATE TRIGGER trg_zz_invoice_registry_cash_del AFTER DELETE ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION register_invoice_number();
CREATE TRIGGER trg_zz_invoice_registry_layaway_del AFTER DELETE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION register_invoice_number();
