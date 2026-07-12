import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";
import { appendManyReceipts, type CashReceiptSlot } from "../_shared/cash-receipt.ts";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────
const INVOICE_ROOT_FOLDER_ID = "1bMiQMq3-avl1sq5_EU3T9sIlmLOQmp7k";
const TAX_RATE = 0.1;
// The master template's physical item block is 13 rows (21-33). Orders with
// more items get extra rows inserted into the per-invoice COPY (never the
// master) on both tabs — see expandItemRows (Bug #247).
const TEMPLATE_ITEM_ROWS = 13;
const SAFETY_MAX_ITEMS = 100;

// Sheet name + cell positions inside the master template.
// CALIBRATE on first run if the master template uses different cells.
// Adjust here, redeploy. No DB or schema impact.
const SHEET_NAME = "Invoice-Use this";
// CALIBRATE: exact tab title of the customer-facing print tab. resolveTabIds
// fails loudly listing the actual tab titles if this ever stops matching.
const PRINT_SHEET_NAME = "InvoiceWithTax-Print this";
const CELLS = {
  invoice_number: `${SHEET_NAME}!F5`,
  invoice_date: `${SHEET_NAME}!H5`,
  order_type: `${SHEET_NAME}!F7`,
  terms: `${SHEET_NAME}!H7`,

  ship_to_name: `${SHEET_NAME}!F12`,
  ship_to_address_line1: `${SHEET_NAME}!F14`,
  ship_to_address_line2: `${SHEET_NAME}!F15`,
  ship_to_phone: `${SHEET_NAME}!F16`,

  bill_to_name: `${SHEET_NAME}!A12`,
  bill_to_address_line1: `${SHEET_NAME}!A14`,
  bill_to_address_line2: `${SHEET_NAME}!A15`,
  bill_to_phone: `${SHEET_NAME}!A16`,

  // Items occupy rows 21-33 (13 max)
  items_start_row: 21,
  items_end_row: 33,
  items_description_col: "A",
  items_qty_col: "F",
  items_unit_price_col: "G",
  items_amount_col: "H",

  // Discount (H35) + shipping (H36) value cells shift down by the number of
  // inserted item rows — written dynamically in cellWrites as
  // H${35 + extraRows} / H${36 + extraRows}. Subtotal (H34) and final TOTAL
  // (H37) are formulas in the Invoice-Use this template — don't write them.
};

const MONTH_NAMES = [
  "01. January", "02. February", "03. March", "04. April",
  "05. May", "06. June", "07. July", "08. August",
  "09. September", "10. October", "11. November", "12. December",
];

// ─────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────
interface Address {
  name: string;
  address_line1: string;
  city?: string;
  postal_code?: string;
  country?: string;
  phone?: string;
}

interface Item {
  description: string;
  qty: number;
  unit_price_jpy_inclusive: number;
}

interface ItemComputed {
  description: string;
  qty: number;
  unit_price_jpy_inclusive: number;
  unit_price_pretax: number;
  amount_inclusive: number;
  amount_pretax: number;
}

// ─────────────────────────────────────────────────
// DRIVE — find or create folder
// ─────────────────────────────────────────────────
async function findOrCreateFolder(
  accessToken: string,
  parentId: string,
  folderName: string,
): Promise<string> {
  const escaped = folderName.replace(/'/g, "\\'");
  const q = `'${parentId}' in parents and name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!searchRes.ok) {
    throw new Error(`Drive folder search failed (${searchRes.status}): ${await searchRes.text()}`);
  }
  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Drive folder create failed (${createRes.status}): ${await createRes.text()}`);
  }
  const created = await createRes.json();
  return created.id;
}

// ─────────────────────────────────────────────────
// DRIVE — copy template into folder, return id + url
// ─────────────────────────────────────────────────
async function createSheetFromTemplate(
  accessToken: string,
  templateId: string,
  targetFolderId: string,
  filename: string,
): Promise<{ sheetId: string; sheetUrl: string }> {
  const copyRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${templateId}/copy`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: filename, parents: [targetFolderId] }),
    },
  );
  if (!copyRes.ok) {
    throw new Error(`Drive file copy failed (${copyRes.status}): ${await copyRes.text()}`);
  }
  const copied = await copyRes.json();
  return {
    sheetId: copied.id,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${copied.id}/edit`,
  };
}

// ─────────────────────────────────────────────────
// SHEETS — populate cells in a single batchUpdate
// ─────────────────────────────────────────────────
async function populateSheet(
  accessToken: string,
  sheetId: string,
  values: Array<{ range: string; value: string | number }>,
): Promise<void> {
  // populateSheet never intentionally writes formulas (Subtotal/TOTAL are
  // template-owned), so blanket-sanitizing formula-trigger prefixes is safe
  // by construction — Bug #248. Under USER_ENTERED, strings starting with
  // =, +, or - parse as formulas (e.g. "+81 90-…" phone numbers → #ERROR!);
  // a leading apostrophe forces literal text and is not displayed by Sheets.
  const sanitize = (v: string | number): string | number =>
    typeof v === "string" && /^[=+\-']/.test(v) ? `'${v}` : v;
  const data = values.map((v) => ({ range: v.range, values: [[sanitize(v.value)]] }));
  const updateRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data,
      }),
    },
  );
  if (!updateRes.ok) {
    throw new Error(`Sheets batchUpdate failed (${updateRes.status}): ${await updateRes.text()}`);
  }
}

// ─────────────────────────────────────────────────
// SHEETS — dynamic item rows (Bug #247)
// ─────────────────────────────────────────────────

// Resolve the numeric sheetId (gid) of both invoice tabs by exact title.
// Fails loudly with the list of actual tab titles so a renamed print tab is
// diagnosed immediately instead of silently corrupting a structural insert.
async function resolveTabIds(
  accessToken: string,
  spreadsheetId: string,
): Promise<{ dataTabId: number; printTabId: number }> {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!metaRes.ok) {
    throw new Error(`Sheets metadata fetch failed (${metaRes.status}): ${await metaRes.text()}`);
  }
  const meta = await metaRes.json() as { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> };
  const props = (meta.sheets || []).map((s) => s.properties || {});
  const titles = props.map((p) => p.title ?? "").filter(Boolean);
  const dataTab = props.find((p) => p.title === SHEET_NAME);
  const printTab = props.find((p) => p.title === PRINT_SHEET_NAME);
  if (!dataTab || typeof dataTab.sheetId !== "number" || !printTab || typeof printTab.sheetId !== "number") {
    throw new Error(
      `Invoice tabs not found by exact title. Expected "${SHEET_NAME}" and "${PRINT_SHEET_NAME}"; actual tabs: ${JSON.stringify(titles)}`,
    );
  }
  return { dataTabId: dataTab.sheetId, printTabId: printTab.sheetId };
}

// Insert extraRows item rows into the per-invoice COPY on both tabs.
// 0-based index 32 = visible row 33 — inserting BEFORE the last item row so
// the template's =SUM(H21:H33) auto-expands and item-row formatting is
// inherited (inheritFromBefore). The print tab additionally needs its per-row
// formulas replicated: copyPaste of the full existing item row at visible row
// 32 into the newly inserted rows; the relative cross-sheet references
// (='Invoice-Use this'!F24 etc.) self-adjust so each new print row pulls its
// matching data row.
async function expandItemRows(
  accessToken: string,
  spreadsheetId: string,
  dataTabId: number,
  printTabId: number,
  extraRows: number,
): Promise<void> {
  const requests = [
    {
      insertDimension: {
        range: { sheetId: dataTabId, dimension: "ROWS", startIndex: 32, endIndex: 32 + extraRows },
        inheritFromBefore: true,
      },
    },
    {
      insertDimension: {
        range: { sheetId: printTabId, dimension: "ROWS", startIndex: 32, endIndex: 32 + extraRows },
        inheritFromBefore: true,
      },
    },
    {
      copyPaste: {
        source: { sheetId: printTabId, startRowIndex: 31, endRowIndex: 32 },
        destination: { sheetId: printTabId, startRowIndex: 32, endRowIndex: 32 + extraRows },
        pasteType: "PASTE_NORMAL",
        pasteOrientation: "NORMAL",
      },
    },
    // No copyPaste on the data tab — its item cells are written as literal
    // values by the existing cellWrites loop.
  ];
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    },
  );
  if (!res.ok) {
    throw new Error(`Item-row expansion failed (${res.status}): ${await res.text()}`);
  }
}

// ─────────────────────────────────────────────────
// MATH — D-1a (discount reduces taxable base)
// ─────────────────────────────────────────────────
function computeTotals(items: Item[], discount_jpy: number, shipping_fee_jpy: number): {
  itemsComputed: ItemComputed[];
  subtotal_pretax: number;
  tax: number;
  total: number;
} {
  const itemsComputed: ItemComputed[] = items.map((item) => {
    const unit_price_pretax = Math.round(item.unit_price_jpy_inclusive / (1 + TAX_RATE));
    const amount_pretax = unit_price_pretax * item.qty;
    const amount_inclusive = item.unit_price_jpy_inclusive * item.qty;
    return {
      description: item.description,
      qty: item.qty,
      unit_price_jpy_inclusive: item.unit_price_jpy_inclusive,
      unit_price_pretax,
      amount_inclusive,
      amount_pretax,
    };
  });
  const subtotal_pretax = itemsComputed.reduce((sum, i) => sum + i.amount_pretax, 0);
  const tax = Math.round(subtotal_pretax * TAX_RATE);
  const total = Math.max(0, subtotal_pretax + tax - discount_jpy + shipping_fee_jpy);
  return { itemsComputed, subtotal_pretax, tax, total };
}

// ─────────────────────────────────────────────────
// FILENAME — D-3b (suffix on regenerations)
// ─────────────────────────────────────────────────
async function buildFilename(
  supabase: any,
  invoiceNumber: string,
  parentField: "account_id" | "cash_order_id",
  parentId: string,
): Promise<string> {
  const { count, error } = await supabase
    .from("generated_invoices")
    .select("*", { count: "exact", head: true })
    .eq(parentField, parentId);
  if (error) {
    throw new Error(`Could not query existing invoice count: ${error.message}`);
  }
  const existingCount = count || 0;
  if (existingCount === 0) return invoiceNumber;
  return `${invoiceNumber}-v${existingCount + 1}`;
}

// ─────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let createdSheetId: string | null = null;
  let createdSheetUrl: string | null = null;

  try {
    const now = new Date();
    // --- Auth ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Permission gate (Bug #204 Batch E: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "generate_invoice");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "generate_invoice permission required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Body parse + validation ---
    const body = await req.json();
    const {
      account_id,
      cash_order_id,
      ship_to,
      bill_to,
      items,
      discount_jpy = 0,
      shipping_fee_jpy = 0,
      terms,
    } = body as {
      account_id?: string;
      cash_order_id?: string;
      ship_to: Address;
      bill_to: Address;
      items: Item[];
      discount_jpy?: number;
      shipping_fee_jpy?: number;
      terms?: string;
    };

    if ((account_id && cash_order_id) || (!account_id && !cash_order_id)) {
      return new Response(JSON.stringify({ error: "Provide exactly one of account_id or cash_order_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!ship_to || !ship_to.name || !ship_to.address_line1) {
      return new Response(JSON.stringify({ error: "ship_to.name and ship_to.address_line1 are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!bill_to || !bill_to.name || !bill_to.address_line1) {
      return new Response(JSON.stringify({ error: "bill_to.name and bill_to.address_line1 are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > SAFETY_MAX_ITEMS) {
      return new Response(JSON.stringify({ error: `items must be an array of 1 to ${SAFETY_MAX_ITEMS} entries` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    for (const item of items) {
      if (!item.description || typeof item.qty !== "number" || item.qty <= 0 ||
          typeof item.unit_price_jpy_inclusive !== "number" || item.unit_price_jpy_inclusive < 0) {
        return new Response(JSON.stringify({ error: "Each item needs description (string), qty (positive), unit_price_jpy_inclusive (non-negative)" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    if (discount_jpy < 0 || shipping_fee_jpy < 0) {
      return new Response(JSON.stringify({ error: "discount_jpy and shipping_fee_jpy must be non-negative" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Master template id ---
    const masterTemplateId = Deno.env.get("MASTER_INVOICE_TEMPLATE_ID");
    if (!masterTemplateId) {
      return new Response(JSON.stringify({ error: "MASTER_INVOICE_TEMPLATE_ID secret not set" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Fetch parent ---
    let parentInvoiceNumber: string;
    let parentOrderDate: string | null = null;
    let parentCurrency: string | null = null;
    let orderType: string;
    if (account_id) {
      const { data: account, error: acctErr } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, order_date, currency")
        .eq("id", account_id)
        .single();
      if (acctErr || !account) {
        return new Response(JSON.stringify({ error: "Account not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      parentInvoiceNumber = account.invoice_number;
      parentOrderDate = account.order_date;
      parentCurrency = account.currency;
      orderType = "LAY AWAY";
    } else {
      const { data: cashOrder, error: coErr } = await supabase
        .from("cash_orders")
        .select("invoice_number, order_date, currency")
        .eq("id", cash_order_id!)
        .single();
      if (coErr || !cashOrder) {
        return new Response(JSON.stringify({ error: "Cash order not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      parentInvoiceNumber = cashOrder.invoice_number;
      parentOrderDate = cashOrder.order_date;
      parentCurrency = cashOrder.currency;
      orderType = "CASH";
    }

    // --- Compute totals (D-1a) ---
    const { itemsComputed, subtotal_pretax, tax, total } = computeTotals(
      items,
      discount_jpy,
      shipping_fee_jpy,
    );

    // --- Google access token ---
    const accessToken = await getServiceAccountAccessToken();

    // --- Resolve folder chain Invoice/{YYYY}/{MM. Month}/ ---
    // Use parent.order_date so backdated invoices file under the
    // month of the order, not the month of generation. order_date is
    // a date column (no time, no tz) — parsing "YYYY-MM-DD" is safe
    // across timezones. Falls back to current date if order_date is
    // missing or malformed (NOT NULL in schema, so unexpected).
    let year: string;
    let monthName: string;
    if (parentOrderDate && /^\d{4}-\d{2}-\d{2}$/.test(parentOrderDate)) {
      const [yyyy, mm] = parentOrderDate.split("-");
      const monthIndex = parseInt(mm, 10) - 1;
      if (monthIndex >= 0 && monthIndex < 12) {
        year = yyyy;
        monthName = MONTH_NAMES[monthIndex];
      } else {
        console.warn(
          `[generate-invoice] invalid month from order_date "${parentOrderDate}", falling back to current date`,
        );
        const now = new Date();
        year = now.getFullYear().toString();
        monthName = MONTH_NAMES[now.getMonth()];
      }
    } else {
      console.warn(
        `[generate-invoice] order_date missing or malformed ("${parentOrderDate}"), falling back to current date`,
      );
      const now = new Date();
      year = now.getFullYear().toString();
      monthName = MONTH_NAMES[now.getMonth()];
    }
    const yearFolderId = await findOrCreateFolder(accessToken, INVOICE_ROOT_FOLDER_ID, year);
    const monthFolderId = await findOrCreateFolder(accessToken, yearFolderId, monthName);

    // --- Filename (D-3b) ---
    const parentField = account_id ? "account_id" : "cash_order_id";
    const parentIdValue = (account_id || cash_order_id)!;
    const filename = await buildFilename(supabase, parentInvoiceNumber, parentField, parentIdValue);

    // --- Copy template (orphan risk starts here) ---
    const sheetCreated = await createSheetFromTemplate(accessToken, masterTemplateId, monthFolderId, filename);
    createdSheetId = sheetCreated.sheetId;
    createdSheetUrl = sheetCreated.sheetUrl;

    // Bug #247: orders beyond the template's 13-row item block get extra rows
    // inserted into this per-invoice copy (both tabs). ≤13 items → zero
    // structural calls, exact pre-fix path.
    const extraRows = Math.max(0, itemsComputed.length - TEMPLATE_ITEM_ROWS);
    if (extraRows > 0) {
      const { dataTabId, printTabId } = await resolveTabIds(accessToken, createdSheetId);
      await expandItemRows(accessToken, createdSheetId, dataTabId, printTabId, extraRows);
    }

    // Address layout per template: Line 1 = postal + city + country (header line);
    // Line 2 = street/building (address_line1).
    const buildAddrLine1 = (a: Address) => {
      const parts: string[] = [];
      const head = [a.postal_code, a.city].filter(Boolean).join(" ");
      if (head) parts.push(head);
      if (a.country) parts.push(a.country);
      return parts.join(", ");
    };
    const buildAddrLine2 = (a: Address) => a.address_line1 || "";

    const cellWrites: Array<{ range: string; value: string | number }> = [
      // Invoice meta (top right of template)
      { range: CELLS.invoice_number, value: parentInvoiceNumber },
      { range: CELLS.invoice_date, value: now.toISOString().split("T")[0] },
      { range: CELLS.order_type, value: orderType },
      { range: CELLS.terms, value: terms || "" },
      // Ship To (column F, rows 12-16)
      { range: CELLS.ship_to_name, value: ship_to.name },
      { range: CELLS.ship_to_address_line1, value: buildAddrLine1(ship_to) },
      { range: CELLS.ship_to_address_line2, value: buildAddrLine2(ship_to) },
      { range: CELLS.ship_to_phone, value: ship_to.phone || "" },
      // Bill To (column A, rows 12-16)
      { range: CELLS.bill_to_name, value: bill_to.name },
      { range: CELLS.bill_to_address_line1, value: buildAddrLine1(bill_to) },
      { range: CELLS.bill_to_address_line2, value: buildAddrLine2(bill_to) },
      { range: CELLS.bill_to_phone, value: bill_to.phone || "" },
      // Discount + shipping value cells, shifted down by any inserted item rows
      // (subtotal and final total are template formulas — not written)
      { range: `${SHEET_NAME}!H${35 + extraRows}`, value: discount_jpy },
      { range: `${SHEET_NAME}!H${36 + extraRows}`, value: shipping_fee_jpy },
    ];

    // Item rows: write tax-INCLUSIVE prices. Invoice-Use this is the data sheet;
    // InvoiceWithTax-Print this has formulas that pull from here and compute the
    // pretax breakdown for the customer-facing printable invoice.
    for (let i = 0; i < itemsComputed.length; i++) {
      const row = CELLS.items_start_row + i;
      const item = itemsComputed[i];
      cellWrites.push(
        { range: `${SHEET_NAME}!${CELLS.items_description_col}${row}`, value: item.description },
        { range: `${SHEET_NAME}!${CELLS.items_qty_col}${row}`, value: item.qty },
        { range: `${SHEET_NAME}!${CELLS.items_unit_price_col}${row}`, value: item.unit_price_jpy_inclusive },
        { range: `${SHEET_NAME}!${CELLS.items_amount_col}${row}`, value: item.amount_inclusive },
      );
    }

    // Clear unused item rows beyond the user's items so any leftover sample
    // data in the master template doesn't bleed through. The amount column has
    // a formula in the template — don't clear that one.
    const totalItemRows = CELLS.items_end_row - CELLS.items_start_row + 1;
    for (let i = itemsComputed.length; i < totalItemRows; i++) {
      const row = CELLS.items_start_row + i;
      cellWrites.push(
        { range: `${SHEET_NAME}!${CELLS.items_description_col}${row}`, value: "" },
        { range: `${SHEET_NAME}!${CELLS.items_qty_col}${row}`, value: "" },
        { range: `${SHEET_NAME}!${CELLS.items_unit_price_col}${row}`, value: "" },
      );
    }

    await populateSheet(accessToken, createdSheetId, cellWrites);

    // --- Embed existing confirmed receipts into Cash Receipt tab ---
    let embeddedReceiptCount = 0;
    try {
      // Fetch PHP→JPY conversion rate from system settings.
      // Per CLAUDE.md CURRENCY CONVERSION STANDARD: JPY = PHP ÷ rate.
      // Receipts' submitted_amount values are in PHP (customer transfer
      // currency); we display in JPY (invoice currency).
      let phpJpyRate = 1.0; // safe fallback — no conversion if fetch fails
      const { data: rateRow, error: rateErr } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "php_jpy_rate")
        .single();
      if (rateErr || !rateRow) {
        console.warn(
          "[generate-invoice] failed to fetch php_jpy_rate (using 1.0 fallback):",
          rateErr,
        );
      } else {
        // system_settings.value is jsonb — extract scalar via String() then parseFloat
        const parsed = parseFloat(String(rateRow.value));
        if (!isNaN(parsed) && parsed > 0) {
          phpJpyRate = parsed;
        } else {
          console.warn(
            "[generate-invoice] php_jpy_rate parsed invalid value, using 1.0 fallback:",
            rateRow.value,
          );
        }
      }

      const submissionsQuery = supabase
        .from("payment_submissions")
        .select("id, proof_url, payment_date, submitted_amount")
        .eq("status", "confirmed")
        .not("proof_url", "is", null)
        .order("payment_date", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(30);

      if (account_id) {
        submissionsQuery.eq("account_id", account_id);
      } else {
        submissionsQuery.eq("cash_order_id", cash_order_id!);
      }

      const { data: receipts, error: receiptsErr } = await submissionsQuery;

      if (receiptsErr) {
        console.warn("[generate-invoice] failed to fetch receipts (non-blocking):", receiptsErr);
      } else if (receipts && receipts.length > 0) {
        // Capacity + overflow are owned by appendManyReceipts (derived per sheet).
        const slots: CashReceiptSlot[] = receipts.map((r, idx) => ({
          slot_index: idx + 1,
          proof_url: r.proof_url as string,
          invoice_number: parentInvoiceNumber,
          payment_date: r.payment_date,
          // Conditional PHP→JPY conversion: JPY accounts skip
          // conversion (submitted_amount already in JPY).
          // PHP accounts (and any non-JPY) divide by rate per
          // CLAUDE.md CURRENCY CONVERSION STANDARD.
          amount: parentCurrency === "JPY"
            ? r.submitted_amount
            : Math.round(r.submitted_amount / phpJpyRate),
        }));

        const receiptResult = await appendManyReceipts(createdSheetId, slots);
        embeddedReceiptCount = receiptResult.written;
        console.log(
          `[generate-invoice] embedded ${embeddedReceiptCount} receipts into sheet ${createdSheetId} ` +
          `(rate=${phpJpyRate}): ${receiptResult.cells_updated} cells updated, ` +
          `capacity=${receiptResult.capacity}, overflow=${receiptResult.overflow}`,
        );
      }
    } catch (receiptErr) {
      console.warn("[generate-invoice] cash-receipt embedding failed (non-blocking):", receiptErr);
    }

    // --- Persist generated_invoices row ---
    const driveFolderPath = `Invoice/${year}/${monthName}`;
    const insertPayload: Record<string, unknown> = {
      parent_invoice_number: parentInvoiceNumber,
      sheet_id: createdSheetId,
      sheet_url: createdSheetUrl,
      drive_folder_path: driveFolderPath,
      generated_by_user_id: user.id,
      generated_by_name: user.email || null,
      ship_to,
      bill_to,
      items: itemsComputed,
      discount_jpy,
      shipping_fee_jpy,
      subtotal_pretax_jpy: subtotal_pretax,
      tax_jpy: tax,
      total_jpy: total,
    };
    if (account_id) insertPayload.account_id = account_id;
    if (cash_order_id) insertPayload.cash_order_id = cash_order_id;

    const { data: invoice, error: insErr } = await supabase
      .from("generated_invoices")
      .insert(insertPayload)
      .select("id, generated_at")
      .single();
    if (insErr || !invoice) {
      throw new Error(`Persistence failed: ${insErr?.message || "no row returned"}`);
    }

    // --- Persist cash_receipt_sheet_id on parent record ---
    try {
      if (account_id) {
        const { error: parentUpdErr } = await supabase
          .from("layaway_accounts")
          .update({ cash_receipt_sheet_id: createdSheetId })
          .eq("id", account_id);
        if (parentUpdErr) {
          console.warn(
            "[generate-invoice] failed to update layaway_accounts.cash_receipt_sheet_id (non-blocking):",
            parentUpdErr,
          );
        }
      } else {
        const { error: parentUpdErr } = await supabase
          .from("cash_orders")
          .update({ cash_receipt_sheet_id: createdSheetId })
          .eq("id", cash_order_id!);
        if (parentUpdErr) {
          console.warn(
            "[generate-invoice] failed to update cash_orders.cash_receipt_sheet_id (non-blocking):",
            parentUpdErr,
          );
        }
      }
    } catch (parentUpdErr) {
      console.warn(
        "[generate-invoice] cash_receipt_sheet_id persist failed (non-blocking):",
        parentUpdErr,
      );
    }

    // --- Audit log (fire-and-forget) ---
    await supabase.from("audit_logs").insert({
      entity_type: "generated_invoice",
      entity_id: invoice.id,
      action: "generate",
      new_value_json: {
        account_id: account_id || null,
        cash_order_id: cash_order_id || null,
        sheet_id: createdSheetId,
        sheet_url: createdSheetUrl,
        total_jpy: total,
      },
      performed_by_user_id: user.id,
    });

    // --- Success ---
    return new Response(JSON.stringify({
      success: true,
      invoice: {
        id: invoice.id,
        sheet_id: createdSheetId,
        sheet_url: createdSheetUrl,
        drive_folder_path: driveFolderPath,
        parent_invoice_number: parentInvoiceNumber,
        subtotal_pretax_jpy: subtotal_pretax,
        tax_jpy: tax,
        discount_jpy,
        shipping_fee_jpy,
        total_jpy: total,
        generated_at: invoice.generated_at,
        embedded_receipt_count: embeddedReceiptCount,
      },
    }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const msg = (error as Error).message || "Unknown error";
    const isGoogleApi = msg.includes("Drive") || msg.includes("Sheets") || msg.includes("Token exchange");
    const status = isGoogleApi ? 502 : 500;
    const responseBody: Record<string, unknown> = { error: msg };
    if (createdSheetId) {
      responseBody.orphan_sheet_id = createdSheetId;
      responseBody.orphan_sheet_url = createdSheetUrl;
      responseBody.note = "A sheet was created in Drive but the operation failed before completion. Manual cleanup may be needed.";
    }
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
