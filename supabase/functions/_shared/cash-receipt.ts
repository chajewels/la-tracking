import { getServiceAccountAccessToken } from "./google-auth.ts";

/**
 * Single cash receipt slot data — used by append-cash-receipt (1 slot at a
 * time), generate-invoice and review-payment-submission (bulk rebuild).
 */
export interface CashReceiptSlot {
  slot_index: number;       // 1-based; validated against the derived per-sheet map
  proof_url: string;        // public URL of receipt image
  invoice_number: string;
  payment_date: string;     // formatted display string (e.g., "May 2, 2026")
  amount: number;           // numeric amount in JPY
}

interface SlotCells {
  image: string;     // top-left merge anchor of image cell range
  metadata: string;  // top-left merge anchor of metadata cell range
}

export const TAB = "Cash Receipt";

// The Cash Receipt template's two merge shapes, by row-span height. Every slot
// is an image merge (28 rows, e.g. B5:F32) paired with a metadata merge (6 rows,
// e.g. B40:F45) directly below it in the same column.
const IMAGE_MERGE_HEIGHT = 28;
const METADATA_MERGE_HEIGHT = 6;

/**
 * 0-based column index → A1 column letters (1→B, 8→I, 15→P, 22→W, 29→AD).
 */
function colLetter(idx0: number): string {
  let n = idx0;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Derive the slot map from a sheet's OWN merged ranges at runtime.
 *
 * Three template generations exist in the wild (13-slot, 24-slot, 30-slot) —
 * a hard-coded map wrote to cells that do not exist on older sheets (Bug #251).
 * Reading each sheet's merges is the only safe source of truth.
 *
 * Classify merges by row-span height: 28 = image anchor, 6 = metadata anchor.
 * Pair each image with the nearest metadata merge below it in the same column,
 * then number slots COLUMN-MAJOR (columns ascending, bands ascending within a
 * column). Reproduces the known maps exactly:
 *   - 13-slot template → B5/B40 … W110/W145, W157/W191 (13 slots)
 *   - 30-slot template → B5/B40 … AD265/AD300 (30 slots)
 */
export async function deriveSlotMap(sheetId: string): Promise<Record<number, SlotCells>> {
  const accessToken = await getServiceAccountAccessToken();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets(properties(title),merges)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets API get merges failed (${res.status}): ${errText}`);
  }

  const body = await res.json();
  const sheets: any[] = Array.isArray(body?.sheets) ? body.sheets : [];
  const tab = sheets.find((s: any) => s?.properties?.title === TAB);
  if (!tab) {
    throw new Error(`Cash Receipt tab "${TAB}" not found in sheet ${sheetId}`);
  }
  const merges: any[] = Array.isArray(tab.merges) ? tab.merges : [];

  const imageAnchors: Array<{ col: number; row: number }> = [];
  const metaAnchors: Array<{ col: number; row: number }> = [];
  for (const m of merges) {
    const startRow = Number(m?.startRowIndex);
    const endRow = Number(m?.endRowIndex);
    const startCol = Number(m?.startColumnIndex);
    if (!Number.isInteger(startRow) || !Number.isInteger(endRow) || !Number.isInteger(startCol)) {
      continue;
    }
    const height = endRow - startRow;
    if (height === IMAGE_MERGE_HEIGHT) imageAnchors.push({ col: startCol, row: startRow });
    else if (height === METADATA_MERGE_HEIGHT) metaAnchors.push({ col: startCol, row: startRow });
  }

  // Pair each image anchor with the metadata merge in the SAME column whose
  // startRowIndex is the smallest one GREATER than the image's startRowIndex.
  const paired: Array<{ col: number; imageRow: number; metaRow: number }> = [];
  for (const img of imageAnchors) {
    let best: number | null = null;
    for (const meta of metaAnchors) {
      if (meta.col !== img.col) continue;
      if (meta.row <= img.row) continue;
      if (best === null || meta.row < best) best = meta.row;
    }
    if (best === null) continue; // image with no metadata below → skip
    paired.push({ col: img.col, imageRow: img.row, metaRow: best });
  }

  // Column-major: columns ascending, then bands ascending within each column.
  paired.sort((a, b) => a.col - b.col || a.imageRow - b.imageRow);

  const map: Record<number, SlotCells> = {};
  let idx = 1;
  for (const s of paired) {
    map[idx] = {
      image: `${TAB}!${colLetter(s.col)}${s.imageRow + 1}`,
      metadata: `${TAB}!${colLetter(s.col)}${s.metaRow + 1}`,
    };
    idx++;
  }

  if (Object.keys(map).length === 0) {
    throw new Error(`No cash-receipt slots derived from sheet ${sheetId} (unexpected layout)`);
  }
  return map;
}

/**
 * Build the 2 cell-update entries (image + metadata) for one slot against a
 * derived per-sheet map. Throws if the slot_index is not present in the map.
 * Pure function — no I/O.
 */
export function buildSlotUpdates(
  slot: CashReceiptSlot,
  map: Record<number, SlotCells>,
): Array<{ range: string; values: string[][] }> {
  const cells = map[slot.slot_index];
  if (!cells) {
    throw new Error(
      `Unknown slot_index ${slot.slot_index} for this sheet (derived capacity ${Object.keys(map).length})`,
    );
  }

  // Sanitize proof_url for use inside =IMAGE() formula
  const safeUrl = slot.proof_url.replace(/"/g, '""');
  const imageFormula = `=IMAGE("${safeUrl}", 1)`;

  // Format amount with thousands separator + JPY suffix (25488 → "25,488 JPY")
  const formattedAmount = `${slot.amount.toLocaleString("en-US")} JPY`;

  // Build the multi-line metadata text. Spaced format matches the
  // template's 6-row merged metadata cell layout.
  const metadataText =
    `INVOICE #: ${slot.invoice_number}\n\n` +
    `DATE: ${slot.payment_date}\n\n` +
    `AMOUNT: ${formattedAmount}`;

  return [
    { range: cells.image,    values: [[imageFormula]] },
    { range: cells.metadata, values: [[metadataText]] },
  ];
}

/**
 * Write one slot's data to a Sheet via Sheets API values:batchUpdate. Derives
 * the slot map from the sheet's own merges. Used by append-cash-receipt.
 */
export async function appendOneReceipt(
  sheetId: string,
  slot: CashReceiptSlot,
): Promise<{ cells_updated: number }> {
  const map = await deriveSlotMap(sheetId);
  const updates = buildSlotUpdates(slot, map);
  return await sendBatchUpdate(sheetId, updates);
}

/**
 * Write N slots' data to a Sheet via a single Sheets API call, rebuilding from
 * DB truth. Capacity and overflow are OWNED here: the slot map is derived from
 * the sheet, slots beyond capacity are logged loudly and skipped (never written
 * to non-existent cells). Returns { cells_updated, capacity, written, overflow }.
 */
export async function appendManyReceipts(
  sheetId: string,
  slots: CashReceiptSlot[],
): Promise<{ cells_updated: number; capacity: number; written: number; overflow: number }> {
  const map = await deriveSlotMap(sheetId);
  const capacity = Object.keys(map).length;

  if (slots.length === 0) {
    return { cells_updated: 0, capacity, written: 0, overflow: 0 };
  }

  const writable = slots.filter((s) => s.slot_index <= capacity);
  const overflow = slots.filter((s) => s.slot_index > capacity);

  if (overflow.length > 0) {
    console.error(
      `[cash-receipt] ${overflow.length} receipt(s) exceeded sheet ${sheetId} ` +
      `Cash Receipt capacity (${capacity}) and were NOT written`,
    );
  }

  if (writable.length === 0) {
    return { cells_updated: 0, capacity, written: 0, overflow: overflow.length };
  }

  const allUpdates: Array<{ range: string; values: string[][] }> = [];
  for (const slot of writable) {
    allUpdates.push(...buildSlotUpdates(slot, map));
  }

  const res = await sendBatchUpdate(sheetId, allUpdates);
  return {
    cells_updated: res.cells_updated,
    capacity,
    written: writable.length,
    overflow: overflow.length,
  };
}

/**
 * Internal helper — send one batchUpdate request to Sheets API.
 * Throws on non-2xx response.
 */
async function sendBatchUpdate(
  sheetId: string,
  data: Array<{ range: string; values: string[][] }>,
): Promise<{ cells_updated: number }> {
  const accessToken = await getServiceAccountAccessToken();

  const requestBody = {
    valueInputOption: "USER_ENTERED",
    data,
  };

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets API batchUpdate failed (${res.status}): ${errText}`);
  }

  const result = await res.json();
  return { cells_updated: result.totalUpdatedCells ?? 0 };
}
