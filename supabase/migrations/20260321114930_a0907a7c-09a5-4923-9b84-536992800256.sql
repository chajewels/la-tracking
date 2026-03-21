
-- ═══════════════════════════════════════════════════════════
-- GUARDRAIL 1: Prevent broken schedule chronology via trigger
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.validate_schedule_chronology()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  prev_due date;
BEGIN
  -- Only validate if installment_number > 1
  IF NEW.installment_number > 1 THEN
    SELECT due_date INTO prev_due
    FROM public.layaway_schedule
    WHERE account_id = NEW.account_id
      AND installment_number = NEW.installment_number - 1
      AND status != 'cancelled';
    
    IF prev_due IS NOT NULL AND NEW.due_date <= prev_due THEN
      RAISE EXCEPTION 'Schedule chronology violation: installment % due_date (%) must be after installment % due_date (%)',
        NEW.installment_number, NEW.due_date, NEW.installment_number - 1, prev_due;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_schedule_chronology
BEFORE INSERT OR UPDATE OF due_date ON public.layaway_schedule
FOR EACH ROW
EXECUTE FUNCTION public.validate_schedule_chronology();

-- ═══════════════════════════════════════════════════════════
-- GUARDRAIL 2: Prevent duplicate penalties (same schedule + stage + cycle)
-- ═══════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS uq_penalty_schedule_stage_cycle
ON public.penalty_fees (schedule_id, penalty_stage, penalty_cycle);

-- ═══════════════════════════════════════════════════════════
-- GUARDRAIL 3: Enforce start-year rule via trigger
-- Sep-Dec → 2025, Jan-Aug → 2026 for installment 1
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.validate_schedule_start_year()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  m integer;
  y integer;
BEGIN
  IF NEW.installment_number = 1 THEN
    m := EXTRACT(MONTH FROM NEW.due_date);
    y := EXTRACT(YEAR FROM NEW.due_date);
    IF m BETWEEN 9 AND 12 AND y != 2025 THEN
      RAISE EXCEPTION 'Start year rule violation: installment 1 in month % must be year 2025, got %', m, y;
    END IF;
    IF m BETWEEN 1 AND 8 AND y != 2026 THEN
      RAISE EXCEPTION 'Start year rule violation: installment 1 in month % must be year 2026, got %', m, y;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_schedule_start_year
BEFORE INSERT ON public.layaway_schedule
FOR EACH ROW
EXECUTE FUNCTION public.validate_schedule_start_year();
