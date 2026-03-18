import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Bulk Import Edge Function
 * 
 * Accepts structured JSON to import customers with multiple layaway accounts,
 * schedules, and historical payments in one batch.
 * 
 * Expected payload:
 * {
 *   "customers": [
 *     {
 *       "customer_code": "CUST-001",
 *       "full_name": "Osako Rhona",
 *       "facebook_name": "Osako Rhona",
 *       "messenger_link": "",
 *       "mobile_number": "",
 *       "accounts": [
 *         {
 *           "invoice_number": "18189",
 *           "currency": "JPY",
 *           "total_amount": 26880,
 *           "payment_plan_months": 6,
 *           "downpayment": 8064,
 *           "order_date": "2025-01-20",       // purchase date (1 month before 1st installment)
 *           "notes": "LA JUL",
 *           "schedule": [
 *             { "installment_number": 1, "due_date": "2025-02-20", "amount": 3136, "is_paid": true, "date_paid": "2025-02-20" },
 *             { "installment_number": 2, "due_date": "2025-03-20", "amount": 3136, "is_paid": true, "date_paid": "2025-03-20" },
 *             { "installment_number": 3, "due_date": "2025-04-20", "amount": 3136, "is_paid": false },
 *             { "installment_number": 4, "due_date": "2025-05-20", "amount": 3136, "is_paid": false },
 *             { "installment_number": 5, "due_date": "2025-06-20", "amount": 3136, "is_paid": false },
 *             { "installment_number": 6, "due_date": "2025-07-20", "amount": 3136, "is_paid": false }
 *           ]
 *         }
 *       ]
 *     }
 *   ],
 *   "dry_run": false   // if true, validate only, don't insert
 * }
 */

interface ScheduleInput {
  installment_number: number;
  due_date: string;
  amount: number;
  is_paid: boolean;
  date_paid?: string;
}

interface AccountInput {
  invoice_number: string;
  currency: "PHP" | "JPY";
  total_amount: number;
  payment_plan_months: number;
  downpayment: number;
  order_date: string;
  notes?: string;
  schedule: ScheduleInput[];
}

interface CustomerInput {
  customer_code: string;
  full_name: string;
  facebook_name?: string;
  messenger_link?: string;
  mobile_number?: string;
  email?: string;
  accounts: AccountInput[];
}

interface ImportPayload {
  customers: CustomerInput[];
  dry_run?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: ImportPayload = await req.json();
    const { customers, dry_run = false } = body;

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return new Response(JSON.stringify({ error: "No customers provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Validation pass ──
    const errors: string[] = [];
    let totalAccounts = 0;
    let totalScheduleRows = 0;
    let totalPayments = 0;

    for (let ci = 0; ci < customers.length; ci++) {
      const c = customers[ci];
      if (!c.full_name) errors.push(`Customer[${ci}]: missing full_name`);
      if (!c.customer_code) errors.push(`Customer[${ci}]: missing customer_code`);
      if (!c.accounts || c.accounts.length === 0) {
        errors.push(`Customer[${ci}] "${c.full_name}": no accounts`);
        continue;
      }

      for (let ai = 0; ai < c.accounts.length; ai++) {
        const a = c.accounts[ai];
        totalAccounts++;
        if (!a.invoice_number) errors.push(`Customer[${ci}] Acct[${ai}]: missing invoice_number`);
        if (!["PHP", "JPY"].includes(a.currency)) errors.push(`Customer[${ci}] Acct[${ai}]: invalid currency "${a.currency}"`);
        if (!a.total_amount || a.total_amount <= 0) errors.push(`Customer[${ci}] Acct[${ai}]: invalid total_amount`);
        if (![3, 6].includes(a.payment_plan_months)) errors.push(`Customer[${ci}] Acct[${ai}]: payment_plan_months must be 3 or 6`);
        if (!a.order_date) errors.push(`Customer[${ci}] Acct[${ai}]: missing order_date`);
        if (!a.schedule || a.schedule.length === 0) errors.push(`Customer[${ci}] Acct[${ai}]: missing schedule`);

        if (a.schedule) {
          for (const s of a.schedule) {
            totalScheduleRows++;
            if (s.is_paid) totalPayments++;
          }
        }
      }
    }

    if (errors.length > 0) {
      return new Response(JSON.stringify({ error: "Validation failed", details: errors }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (dry_run) {
      return new Response(JSON.stringify({
        dry_run: true,
        summary: {
          customers: customers.length,
          accounts: totalAccounts,
          schedule_rows: totalScheduleRows,
          payments: totalPayments,
        },
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Import pass ──
    const results = {
      customers_created: 0,
      customers_existing: 0,
      accounts_created: 0,
      schedule_rows_created: 0,
      payments_recorded: 0,
      errors: [] as string[],
    };

    for (const c of customers) {
      try {
        // Check if customer exists by customer_code
        const { data: existingCustomer } = await supabase
          .from("customers")
          .select("id")
          .eq("customer_code", c.customer_code)
          .maybeSingle();

        let customerId: string;

        if (existingCustomer) {
          customerId = existingCustomer.id;
          results.customers_existing++;
        } else {
          const { data: newCustomer, error: custErr } = await supabase
            .from("customers")
            .insert({
              customer_code: c.customer_code,
              full_name: c.full_name,
              facebook_name: c.facebook_name || null,
              messenger_link: c.messenger_link || null,
              mobile_number: c.mobile_number || null,
              email: c.email || null,
            })
            .select("id")
            .single();

          if (custErr) {
            results.errors.push(`Customer "${c.full_name}": ${custErr.message}`);
            continue;
          }
          customerId = newCustomer.id;
          results.customers_created++;
        }

        // Process each account
        for (const a of c.accounts) {
          try {
            // Check for duplicate invoice
            const { data: existingAcct } = await supabase
              .from("layaway_accounts")
              .select("id")
              .eq("invoice_number", a.invoice_number)
              .eq("customer_id", customerId)
              .maybeSingle();

            if (existingAcct) {
              results.errors.push(`Skipped duplicate: Inv#${a.invoice_number} for "${c.full_name}"`);
              continue;
            }

            // Calculate totals from schedule
            const paidInstallments = a.schedule.filter(s => s.is_paid);
            const totalPaidFromSchedule = paidInstallments.reduce((sum, s) => sum + s.amount, 0);
            const totalPaidWithDownpayment = (a.downpayment || 0) + totalPaidFromSchedule;
            const remainingBalance = a.total_amount - totalPaidWithDownpayment;

            // Determine end date from last schedule item
            const lastScheduleDate = a.schedule[a.schedule.length - 1]?.due_date;

            // Determine status
            const allPaid = a.schedule.every(s => s.is_paid) && remainingBalance <= 0;
            const status = allPaid ? "completed" : "active";

            // Create account
            const { data: account, error: acctErr } = await supabase
              .from("layaway_accounts")
              .insert({
                customer_id: customerId,
                invoice_number: a.invoice_number,
                currency: a.currency,
                total_amount: a.total_amount,
                payment_plan_months: a.payment_plan_months,
                order_date: a.order_date,
                end_date: lastScheduleDate || null,
                total_paid: totalPaidWithDownpayment,
                remaining_balance: Math.max(0, remainingBalance),
                notes: a.notes || null,
                status,
                created_by_user_id: user.id,
              })
              .select("id")
              .single();

            if (acctErr) {
              results.errors.push(`Acct Inv#${a.invoice_number}: ${acctErr.message}`);
              continue;
            }

            results.accounts_created++;

            // Create schedule rows
            const scheduleRows = a.schedule.map(s => ({
              account_id: account.id,
              installment_number: s.installment_number,
              due_date: s.due_date,
              base_installment_amount: s.amount,
              penalty_amount: 0,
              total_due_amount: s.amount,
              paid_amount: s.is_paid ? s.amount : 0,
              currency: a.currency,
              status: s.is_paid ? "paid" : "pending",
            }));

            const { data: insertedSchedule, error: schedErr } = await supabase
              .from("layaway_schedule")
              .insert(scheduleRows)
              .select("id, installment_number");

            if (schedErr) {
              results.errors.push(`Schedule for Inv#${a.invoice_number}: ${schedErr.message}`);
              continue;
            }

            results.schedule_rows_created += scheduleRows.length;

            // Record downpayment as a payment if > 0
            if (a.downpayment > 0) {
              const { error: dpErr } = await supabase
                .from("payments")
                .insert({
                  account_id: account.id,
                  amount_paid: a.downpayment,
                  currency: a.currency,
                  date_paid: a.order_date,
                  payment_method: "cash",
                  remarks: "Downpayment (bulk import)",
                  entered_by_user_id: user.id,
                });

              if (!dpErr) results.payments_recorded++;
            }

            // Record paid installments as payments
            const scheduleMap = new Map(
              (insertedSchedule || []).map(s => [s.installment_number, s.id])
            );

            for (const s of paidInstallments) {
              const datePaid = s.date_paid || s.due_date;

              const { data: payment, error: payErr } = await supabase
                .from("payments")
                .insert({
                  account_id: account.id,
                  amount_paid: s.amount,
                  currency: a.currency,
                  date_paid: datePaid,
                  payment_method: "cash",
                  remarks: `Installment ${s.installment_number} (bulk import)`,
                  entered_by_user_id: user.id,
                })
                .select("id")
                .single();

              if (!payErr && payment) {
                results.payments_recorded++;

                // Create payment allocation
                const scheduleId = scheduleMap.get(s.installment_number);
                if (scheduleId) {
                  await supabase.from("payment_allocations").insert({
                    payment_id: payment.id,
                    schedule_id: scheduleId,
                    allocation_type: "installment",
                    allocated_amount: s.amount,
                  });
                }
              }
            }

            // Audit log
            await supabase.from("audit_logs").insert({
              entity_type: "layaway_account",
              entity_id: account.id,
              action: "bulk_import",
              new_value_json: { invoice_number: a.invoice_number, customer: c.full_name },
              performed_by_user_id: user.id,
            });

          } catch (acctError) {
            results.errors.push(`Acct Inv#${a.invoice_number}: ${(acctError as Error).message}`);
          }
        }
      } catch (custError) {
        results.errors.push(`Customer "${c.full_name}": ${(custError as Error).message}`);
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
