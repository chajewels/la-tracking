import { getServiceAccountAccessToken } from "./google-auth.ts";

/**
 * Single cash receipt slot data — used by both append-cash-receipt
 * (1 slot at a time) and generate-invoice (up to 13 slots in bulk).
 */
export interface CashReceiptSlot {
  slot_index: number;       // 1-13
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

/**
 * 13-slot cell map. Each slot has 2 merged cells:
 * - image: receives =IMAGE() formula
 * - metadata: receives multi-line "INVOICE #: ... DATE: ... AMOUNT: ..." text
 *
 * Layout: 4 columns (B, I, P, W) × 3 rows for B/I/P + 4 rows for W = 13 slots.
 */
export const SLOTS: Record<number, SlotCells> = {
  1:  { image: `${TAB}!B5`,   metadata: `${TAB}!B40`  },
  2:  { image: `${TAB}!B58`,  metadata: `${TAB}!B93`  },
  3:  { image: `${TAB}!B110`, metadata: `${TAB}!B145` },
  4:  { image: `${TAB}!I5`,   metadata: `${TAB}!I40`  },
  5:  { image: `${TAB}!I58`,  metadata: `${TAB}!I93`  },
  6:  { image: `${TAB}!I110`, metadata: `${TAB}!I145` },
  7:  { image: `${TAB}!P5`,   metadata: `${TAB}!P40`  },
  8:  { image: `${TAB}!P58`,  metadata: `${TAB}!P93`  },
  9:  { image: `${TAB}!P110`, metadata: `${TAB}!P145` },
  10: { image: `${TAB}!W5`,   metadata: `${TAB}!W40`  },
  11: { image: `${TAB}!W58`,  metadata: `${TAB}!W93`  },
  12: { image: `${TAB}!W110`, metadata: `${TAB}!W145` },
  13: { image: `${TAB}!W158`, metadata: `${TAB}!W191` },
};

/**
 * Build the 2 cell-update entries (image + metadata) for one slot.
 * Throws on invalid slot_index. Pure function — no I/O.
 *
 * Multiple slots can be combined into a single batchUpdate request
 * by concatenating the arrays.
 */
export function buildSlotUpdates(
  slot: CashReceiptSlot,
): Array<{ range: string; values: string[][] }> {
  if (!Number.isInteger(slot.slot_index) || slot.slot_index < 1 || slot.slot_index > 13) {
    throw new Error(`Invalid slot_index: ${slot.slot_index} (must be 1-13)`);
  }

  const cells = SLOTS[slot.slot_index];

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
 * Write one slot's data to a Sheet via Sheets API values:batchUpdate.
 * Used by append-cash-receipt edge function for incremental appends.
 */
export async function appendOneReceipt(
  sheetId: string,
  slot: CashReceiptSlot,
): Promise<{ cells_updated: number }> {
  const updates = buildSlotUpdates(slot);
  return await sendBatchUpdate(sheetId, updates);
}

/**
 * Write N slots' data to a Sheet via a single Sheets API call.
 * Used by generate-invoice for initial bulk fill of confirmed receipts.
 * Returns { cells_updated: 0 } for empty input — no API call made.
 */
export async function appendManyReceipts(
  sheetId: string,
  slots: CashReceiptSlot[],
): Promise<{ cells_updated: number }> {
  if (slots.length === 0) {
    return { cells_updated: 0 };
  }

  const allUpdates: Array<{ range: string; values: string[][] }> = [];
  for (const slot of slots) {
    allUpdates.push(...buildSlotUpdates(slot));
  }

  return await sendBatchUpdate(sheetId, allUpdates);
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
