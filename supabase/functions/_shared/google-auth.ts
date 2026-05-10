import * as jose from "https://esm.sh/jose@5";

/**
 * Get a Google API access token using the service account JWT pattern.
 * Uses domain-wide delegation: sub = impersonated workspace user
 * (GOOGLE_ADMIN_EMAIL), iss = service account.
 *
 * Required Supabase secrets:
 *   - GOOGLE_SERVICE_ACCOUNT_JSON: full service account JSON key
 *   - GOOGLE_ADMIN_EMAIL: workspace user email to impersonate
 *
 * Returns: short-lived (1 hour) access token with Drive + Sheets scopes.
 */
export async function getServiceAccountAccessToken(): Promise<string> {
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
