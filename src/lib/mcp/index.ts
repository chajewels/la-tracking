import { auth, defineMcp } from "@lovable.dev/mcp-js";
import echoTool from "./tools/echo";
import searchCustomersTool from "./tools/search-customers";
import getAccountByInvoiceTool from "./tools/get-account";

// Build the Supabase OAuth issuer from the project ref so the discovery
// document matches the direct supabase.co host (see CLAUDE.md, mcp-js rules).
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "cha-jewels-hub-mcp",
  title: "Cha Jewels Hub MCP",
  version: "0.1.0",
  instructions:
    "Tools for Cha Jewels Hub — the internal layaway management system. Use `echo` to verify connectivity, `search_customers` to look up customers by name/email/code/mobile, and `get_account_by_invoice` to fetch a layaway account with its payment schedule. All data access runs as the signed-in internal user under Supabase RLS.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [echoTool, searchCustomersTool, getAccountByInvoiceTool],
});
