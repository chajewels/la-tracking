import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPANY_NAME, CUSTOMER_FOOTER } from "../../supabase/functions/_shared/transactional-email-templates/brand.ts";

// Owner acceptance run 2026-09-24, finding 3: customer mail signs with the
// REGISTERED name, full-width, as the storefront's COMPANY_NAME prints it.
const REGISTERED = "Ｃｈａ　Ｊｅｗｅｌｓ株式会社";

describe("customer email company name", () => {
  it("is the registered full-width name, in both footers", () => {
    expect(COMPANY_NAME).toBe(REGISTERED);
    expect(CUSTOMER_FOOTER).toBe(`${REGISTERED} · Tateishi, Katsushika, Tokyo`);
  });

  it("no storefront template still signs as 'Cha Jewels Co., Ltd.'", () => {
    for (const f of [
      "supabase/functions/_shared/email-templates/order-shared.tsx",
      "supabase/functions/_shared/email-templates/storefront-magic-link.tsx",
      "supabase/functions/_shared/transactional-email-templates/brand.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/Cha Jewels Co\., Ltd\./);
    }
  });
});
