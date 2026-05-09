import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as jose from "https://esm.sh/jose@5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────
const INVOICE_ROOT_FOLDER_ID = "1bMiQMq3-avl1sq5_EU3T9sIlmLOQmp7k";
const TAX_RATE = 0.1;
const MAX_ITEMS = 13;

// Sheet name + cell positions inside the master template.
// CALIBRATE on first run if the master template uses different cells.
// Adjust here, redeploy. No DB or schema impact.
const SHEET_NAME = "Invoice-Use this";
const CELLS = {
  invoice_number: `${SHEET_NAME}!B8`,
  invoice_date: `${SHEET_NAME}!B9`,
  order_type: `${SHEET_NAME}!B10`,
  terms: `${SHEET_NAME}!B11`,
  ship_to_name: `${SHEET_NAME}!B13`,
  ship_to_address: `${SHEET_NAME}!B14`,
  ship_to_phone: `${SHEET_NAME}!B15`,
  // Items occupy rows 17-29
  items_start_row: 17,
  items_end_row: 29,
  items_description_col: "B",
  items_qty_col: "D",
  items_unit_price_col: "E",
  items_amount_col: "F",
  // Totals block rows 31-35
  subtotal_pretax: `${SHEET_NAME}!F31`,
  discount: `${SHEET_NAME}!F32`,
  tax: `${SHEET_NAME}!F33`,
  shipping: `${SHEET_NAME}!F34`,
  total: `${SHEET_NAME}!F35`,
  // Bill To rows 36-38
  bill_to_name: `${SHEET_NAME}!B36`,
  bill_to_address: `${SHEET_NAME}!B37`,
  bill_to_phone: `${SHEET_NAME}!B38`,
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
  unit_price_pretax: number;
  amount_pretax: number;
}

// ─────────────────────────────────────────────────
// GOOGLE SERVICE ACCOUNT JWT → ACCESS TOKEN
// ─────────────────────────────────────────────────
async function getServiceAccountAccessToken(): Promise<string> {
  const json = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!json) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret not set");
  }
  const adminEmail = Deno.env.get("GOOGLE_ADMIN_EMAIL");
  if (!adminEmail) {
    throw new Error("GOOGLE_ADMIN_EMAIL secret not set");
  }
  let creds: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    creds = JSON.parse(json);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: " + (e as Error).message);
  }
  const { client_email, private_key, token_uri } = creds;
  if (!client_email || !private_key || !token_uri) {
    throw new Error("Service account JSON missing required fields (client_email, private_key, token_uri)");
  }
  // Defensive: handle JSON-escaped newlines in private_key
  const normalizedKey = private_key.replace(/\\n/g, "\n");
  const keyObj = await jose.importPKCS8(normalizedKey, "RS256");
  const now = Math.floor(Date.now() / 1000);
  // Domain-Wide Delegation: sub = impersonated workspace user, iss = service account.
  const jwt = await new jose.SignJWT({
    scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(client_email)
    .setSubject(adminEmail)
    .setAudience(token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(keyObj);
  const tokenRes = await fetch(token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
  }
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error("Token exchange returned no access_token");
  }
  return tokenData.access_token;
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
  const data = values.map((v) => ({ range: v.range, values: [[v.value]] }));
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
    return {
      description: item.description,
      qty: item.qty,
      unit_price_pretax,
      amount_pretax,
    };
  });
  const subtotal_pretax = itemsComputed.reduce((sum, i) => sum + i.amount_pretax, 0);
  const taxable_base = Math.max(0, subtotal_pretax - discount_jpy);
  const tax = Math.round(taxable_base * TAX_RATE);
  const total = taxable_base + tax + shipping_fee_jpy;
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

    // --- Role gate (admin / finance / staff) ---
    const [{ data: isAdmin }, { data: isFinance }, { data: isStaff }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: user.id, _role: "finance" }),
      supabase.rpc("has_role", { _user_id: user.id, _role: "staff" }),
    ]);
    if (!isAdmin && !isFinance && !isStaff) {
      return new Response(JSON.stringify({ error: "Forbidden: admin/finance/staff role required" }), {
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
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) {
      return new Response(JSON.stringify({ error: `items must be an array of 1 to ${MAX_ITEMS} entries` }), {
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
    let orderType: string;
    if (account_id) {
      const { data: account, error: acctErr } = await supabase
        .from("layaway_accounts")
        .select("invoice_number")
        .eq("id", account_id)
        .single();
      if (acctErr || !account) {
        return new Response(JSON.stringify({ error: "Account not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      parentInvoiceNumber = account.invoice_number;
      orderType = "LAY AWAY";
    } else {
      const { data: cashOrder, error: coErr } = await supabase
        .from("cash_orders")
        .select("invoice_number")
        .eq("id", cash_order_id!)
        .single();
      if (coErr || !cashOrder) {
        return new Response(JSON.stringify({ error: "Cash order not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      parentInvoiceNumber = cashOrder.invoice_number;
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
    const now = new Date();
    const year = now.getUTCFullYear().toString();
    const monthName = MONTH_NAMES[now.getUTCMonth()];
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

    // --- Build cell writes ---
    const concatAddress = (a: Address) =>
      [a.address_line1, a.city, a.postal_code, a.country].filter(Boolean).join(", ");
    const cellWrites: Array<{ range: string; value: string | number }> = [
      { range: CELLS.invoice_number, value: parentInvoiceNumber },
      { range: CELLS.invoice_date, value: now.toISOString().split("T")[0] },
      { range: CELLS.order_type, value: orderType },
      { range: CELLS.terms, value: terms || "" },
      { range: CELLS.ship_to_name, value: ship_to.name },
      { range: CELLS.ship_to_address, value: concatAddress(ship_to) },
      { range: CELLS.ship_to_phone, value: ship_to.phone || "" },
      { range: CELLS.bill_to_name, value: bill_to.name },
      { range: CELLS.bill_to_address, value: concatAddress(bill_to) },
      { range: CELLS.bill_to_phone, value: bill_to.phone || "" },
      { range: CELLS.subtotal_pretax, value: subtotal_pretax },
      { range: CELLS.discount, value: discount_jpy },
      { range: CELLS.tax, value: tax },
      { range: CELLS.shipping, value: shipping_fee_jpy },
      { range: CELLS.total, value: total },
    ];
    for (let i = 0; i < itemsComputed.length; i++) {
      const row = CELLS.items_start_row + i;
      const item = itemsComputed[i];
      cellWrites.push(
        { range: `${SHEET_NAME}!${CELLS.items_description_col}${row}`, value: item.description },
        { range: `${SHEET_NAME}!${CELLS.items_qty_col}${row}`, value: item.qty },
        { range: `${SHEET_NAME}!${CELLS.items_unit_price_col}${row}`, value: item.unit_price_pretax },
        { range: `${SHEET_NAME}!${CELLS.items_amount_col}${row}`, value: item.amount_pretax },
      );
    }

    // --- Populate sheet ---
    await populateSheet(accessToken, createdSheetId, cellWrites);

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
