import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";
import { getServiceAccountAccessToken } from "../_shared/google-auth.ts";

interface RequestBody {
  invoice_number: string;
}

interface Item {
  description: string;
  qty: number;
  unit_price_with_tax: number;
}

interface OrderResponse {
  found: boolean;
  address?: string;
  phone?: string;
  shipping_fee?: number;
  discount?: number;
  items?: Item[];
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const body: RequestBody = await req.json();
    if (!body.invoice_number) {
      return jsonResponse(400, { error: "invoice_number is required" });
    }

    const folderId = Deno.env.get("PAGE365_MIRROR_FOLDER_ID");
    if (!folderId) {
      return jsonResponse(500, { error: "PAGE365_MIRROR_FOLDER_ID secret not set" });
    }

    // Authenticate with Google
    const accessToken = await getServiceAccountAccessToken();

    // Find the most recent CSV in the folder
    const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
    listUrl.searchParams.set(
      "q",
      `'${folderId}' in parents and mimeType = 'text/csv' and trashed = false`,
    );
    listUrl.searchParams.set("orderBy", "modifiedTime desc");
    listUrl.searchParams.set("fields", "files(id, name, modifiedTime)");
    listUrl.searchParams.set("pageSize", "50");
    listUrl.searchParams.set("supportsAllDrives", "true");
    listUrl.searchParams.set("includeItemsFromAllDrives", "true");

    const listRes = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(`Drive list failed (${listRes.status}): ${errText}`);
    }

    const listData = await listRes.json();
    if (!listData.files || listData.files.length === 0) {
      return jsonResponse(404, { error: "No CSV files found in Page365 mirror folder" });
    }

    // Iterate CSVs from newest to oldest (listData.files is already
    // sorted by orderBy=modifiedTime desc). Stop on first CSV that
    // contains a matching invoice. Page365 exports may be partial
    // snapshots — checking all CSVs lets us find invoices that
    // exist in older exports but not the latest one.
    const target = String(body.invoice_number).trim();
    let matching: Record<string, string>[] = [];
    let matchedFileName = '';

    for (const file of listData.files) {
      console.log(`Reading file: ${file.name} (modified: ${file.modifiedTime})`);

      // Download the file as binary (Page365 exports are UTF-16 LE TSV)
      const downloadUrl =
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
      const downloadRes = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!downloadRes.ok) {
        const errText = await downloadRes.text();
        throw new Error(`Drive download failed (${downloadRes.status}): ${errText}`);
      }

      const buffer = await downloadRes.arrayBuffer();

      // Decode UTF-16 LE → UTF-8, strip BOM if present
      let content = new TextDecoder("utf-16le").decode(buffer);
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
      }

      // Parse as TSV (tab-separated values, with header row)
      const rows = parse(content, { separator: "\t", skipFirstRow: true }) as Record<string, string>[];

      // Filter rows where No. matches invoice_number
      matching = rows.filter((row) => String(row["No."] ?? "").trim() === target);

      if (matching.length > 0) {
        matchedFileName = file.name;
        console.log(`Found ${matching.length} matching row(s) in ${file.name}`);
        break;
      }
    }

    if (matching.length === 0) {
      console.log(`No match for invoice ${target} in ${listData.files.length} CSV(s)`);
    }

    if (matching.length === 0) {
      return jsonResponse(200, { found: false });
    }

    // Build response
    const first = matching[0];
    const items: Item[] = matching.map((row) => ({
      description: String(row["Item Name"] ?? "").trim(),
      qty: parseNumber(row["Item Qty"]),
      unit_price_with_tax: parseNumber(row["Item Price"]),
    }));

    // Discount: prefer "Discount", fallback to "Campaign Discount" (mutually exclusive)
    const discountVal = parseNumber(first["Discount"]);
    const campaignDiscount = parseNumber(first["Campaign Discount"]);
    const discount = discountVal !== 0 ? discountVal : campaignDiscount;

    const response: OrderResponse = {
      found: true,
      address: String(first["Customer Address"] ?? "").trim(),
      // Strip leading apostrophe Page365 prepends to phone numbers
      phone: String(first["Customer Phone"] ?? "").trim().replace(/^'/, ""),
      shipping_fee: parseNumber(first["Shipping Cost"]),
      discount,
      items,
    };

    return jsonResponse(200, response);
  } catch (err) {
    console.error("get-page365-order error:", err);
    return jsonResponse(500, { error: (err as Error).message });
  }
});

function parseNumber(val: unknown): number {
  if (val === null || val === undefined || val === "") return 0;
  const num = Number(val);
  return isNaN(num) ? 0 : num;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
