import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { handleEnhance } from "../_shared/gemini-enhance-handler.ts";

/**
 * Staff-only server-to-server connection to the Google Gemini API.
 * Hub -> this function -> generativelanguage.googleapis.com -> structured reply.
 *
 * Read-only: it writes nothing (no database, no storage) and returns suggested
 * text only. A caller must show it next to the original and require explicit
 * acceptance before anything is saved — this function never saves.
 *
 * Body (strict — unknown fields are rejected, never forwarded):
 *   { "connectivity_test": true }   the ONLY fields a test may carry; sends a built-in fictional product
 *   { product: { name, weight_g?, length_cm?, description_en }, images?: [{ mime_type, data_base64 }] }
 * Auth: staff JWT + manage_website_catalog (verify_jwt = true at the gateway).
 * Secret: GEMINI_API_KEY (edge secret) — read only after the request validates,
 * sent only in the x-goog-api-key header, never logged or returned.
 * Pipeline and its order: _shared/gemini-enhance-handler.ts.
 * Separate from translate-product-description (Lovable AI gateway).
 */
Deno.serve((req) => handleEnhance(req, {
  requireAuth,
  requirePermission,
  getApiKey: () => Deno.env.get("GEMINI_API_KEY"),
}));
