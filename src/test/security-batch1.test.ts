import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeMessengerLink, safeMessengerHref, customerProfileMessengerLink, MESSENGER_LINK_MAX } from "../../supabase/functions/_shared/profile-messenger-link.ts";
import { proofObjectPath, signProofUrls } from "../../supabase/functions/_shared/proof-signing.ts";
import { messengerHref, staffMessengerLink } from "../lib/messenger-href";

// Security batch 1 (owner-requested audit, 2026-10-31): H-07 Messenger links,
// H-01 signed proof links. Run in CI ("Website and template tests").

const SRC = join(__dirname, "..");
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "test" || name === "dev" ? [] : tsxFiles(p);
    return /\.tsx$/.test(name) ? [p] : [];
  });
}
const read = (p: string) => readFileSync(p, "utf8");

describe("H-07: a Messenger link is an http(s) web address or nothing", () => {
  it("keeps ordinary links and adds https:// to a link typed without a scheme", () => {
    expect(normalizeMessengerLink("m.me/ana.cruz")).toEqual({ ok: true, value: "https://m.me/ana.cruz" });
    expect(normalizeMessengerLink(" https://m.me/ana ")).toEqual({ ok: true, value: "https://m.me/ana" });
    expect(normalizeMessengerLink("www.facebook.com/profile.php?id=1")).toEqual({ ok: true, value: "https://www.facebook.com/profile.php?id=1" });
    expect(normalizeMessengerLink("")).toEqual({ ok: true, value: null });
    expect(normalizeMessengerLink(null)).toEqual({ ok: true, value: null });
  });

  it("refuses script, data and other schemes, credentials and junk", () => {
    for (const bad of [
      "javascript:alert(1)", "JavaScript:alert(document.cookie)", "jav\tascript:x", "data:text/html,<b>x</b>",
      "vbscript:x", "fb-messenger://user-thread/1", "https://u:p@m.me/x", "Ana Cruz", "localhost",
      "m.me\\x",
    ]) {
      expect(normalizeMessengerLink(bad), JSON.stringify(bad)).toEqual({ ok: false });
      expect(messengerHref(bad), JSON.stringify(bad)).toBeNull();
      expect(staffMessengerLink(bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });

  it("saves the canonical form; display keeps long links staff saved (safety only, no length cap)", () => {
    expect(normalizeMessengerLink("https:m.me/x")).toEqual({ ok: true, value: "https://m.me/x" });
    const long = "https://www.facebook.com/profile.php?id=1&mibextid=" + "a".repeat(MESSENGER_LINK_MAX);
    expect(normalizeMessengerLink(long)).toEqual({ ok: false });
    expect(messengerHref(long)).toBe(long);
    expect(staffMessengerLink(long)).toEqual({ ok: true, value: long });
    expect(messengerHref("m.me/ana cruz")).toBe("https://m.me/ana%20cruz");
    expect(safeMessengerHref("Ana Cruz")).toBeNull();
    expect(staffMessengerLink("  ")).toEqual({ ok: true, value: null });
    // A customer re-saving her profile is never blocked by a link she did not change.
    expect(customerProfileMessengerLink(long, long)).toEqual({ ok: true, value: long });
    expect(customerProfileMessengerLink(long, null)).toEqual({ ok: false });
    expect(customerProfileMessengerLink("javascript:alert(1)", "javascript:alert(1)")).toEqual({ ok: false });
    // The stored (canonical) form is what is measured.
    expect(normalizeMessengerLink("m.me/" + "\u00e9".repeat(80))).toEqual({ ok: false });
  });

  it("Messenger buttons only appear for a usable link, and fallbacks still work", () => {
    for (const f of ["components/monitoring/PenaltyFollowUpSection.tsx", "pages/Monitoring.tsx"]) {
      const s = read(join(SRC, f));
      expect(s, f).toMatch(/\{messengerHref\(messengerDialog\?\.alert\.messengerLink\) && \(/);
      expect(s, f).not.toMatch(/\{messengerDialog\?\.alert\.messengerLink && \(/);
    }
    expect(read(join(SRC, "components/customers/PortalActivationModal.tsx"))).toMatch(/const href = messengerHref\(messengerLink\);/);
    expect(read(join(SRC, "components/payments/MultiInvoicePaymentDialog.tsx"))).toMatch(/if \(!openMessenger\(messengerLink\)\) toast\.info/);
  });

  it("staff save paths store only a safe link", () => {
    for (const f of ["components/customers/EditCustomerDialog.tsx", "components/customers/NewCustomerDialog.tsx", "pages/CustomerDetail.tsx", "components/customers/ImportCustomersDialog.tsx", "components/ai/AICommandModal.tsx"]) {
      expect(read(join(SRC, f)), f).toMatch(/staffMessengerLink\(/);
    }
    expect(read(join(SRC, "../supabase/functions/bulk-import/index.ts"))).toMatch(/messenger_link: safeMessengerHref\(c\.messenger_link\)/);
  });

  it("is the same rule as the storefront copy (cha-jewels-web lib/profile-messenger-link.ts)", () => {
    const src = read(join(SRC, "../supabase/functions/_shared/profile-messenger-link.ts"));
    expect(src).toMatch(/const HAS_SCHEME = \/\^\[a-z\]\[a-z0-9\+\.-\]\*:\/i;/);
    expect(src).toMatch(/MESSENGER_LINK_MAX = 200/);
  });

  it("no Hub screen puts a stored Messenger link in an href or window.open unchecked", () => {
    const offenders: string[] = [];
    for (const f of tsxFiles(SRC)) {
      const s = read(f);
      if (/href=\{[\w?.!]*messenger_link\}/.test(s)) offenders.push(`${f}: raw messenger_link href`);
      if (/window\.open\([\w?.!]*[mM]essenger(?:_link|Link)\b/.test(s)) offenders.push(`${f}: raw messenger window.open`);
      if (/href:\s*[\w?.!]*messenger_link\b/.test(s)) offenders.push(`${f}: raw messenger_link href prop`);
    }
    expect(offenders).toEqual([]);
  });

  it("every customer save path checks the link", () => {
    const fn = (name: string) => read(join(SRC, `../supabase/functions/${name}/index.ts`));
    expect(fn("website")).toMatch(/normalizeMessengerLink\(messengerLink\)/);
    expect(fn("website")).toMatch(/error: "messenger_link_invalid"/);
    expect(fn("website")).toMatch(/messenger_link: messengerCheck\.value/);
    expect(fn("customer-portal")).toMatch(/customerProfileMessengerLink\(profile\.messenger_link, storedCustomer\?\.messenger_link \?\? null\)/);
    expect(fn("customer-portal")).toMatch(/messenger_link: messengerCheck\.value/);
    expect(fn("setup-customer-account")).toMatch(/normalizeMessengerLink\(metaStr\(metadata\.messenger_link\)\)/);
    expect(read(join(SRC, "pages/PortalSetup.tsx"))).toMatch(/messenger_link: messengerCheck\.value/);
    expect(read(join(SRC, "pages/CustomerPortal.tsx"))).toMatch(/messenger_link: messengerCheck\.value/);
  });

  it("promo and announcement links are http(s)-only", () => {
    for (const f of ["components/customers/PromoBanner.tsx", "pages/Promotions.tsx", "pages/CustomerPortal.tsx"]) {
      expect(read(join(SRC, f)), f).not.toMatch(/href=\{[\w.]*link_url\}/);
    }
  });
});

describe("H-22: a portal customer cannot set an email she has not proved", () => {
  const portal = () => read(join(SRC, "../supabase/functions/customer-portal/index.ts"));
  it("update_profile only allows her own confirmed sign-in email, otherwise refuses", () => {
    const s = portal();
    expect(s).toMatch(/if \(submittedEmail !== storedEmail\) \{/);
    expect(s).toMatch(/if \(who\?\.user\?\.email_confirmed_at\) verifiedLoginEmail = norm\(who\.user\.email\);/);
    expect(s).toMatch(/code: "email_change_not_allowed"/);
    expect(s).toMatch(/email: emailToStore,/);
    expect(s).not.toMatch(/email: profile\.email \|\| null/);
  });
  it("the portal form explains it, and staff see that Notes are customer-visible", () => {
    expect(read(join(SRC, "pages/CustomerPortal.tsx"))).toMatch(/json\.code === 'email_change_not_allowed' \? pt\('profile\.errEmailChange'\)/);
    expect(read(join(SRC, "i18n/portal.ts"))).toMatch(/errEmailChange: 'To change your email address, please message Cha Jewels/);
    expect(read(join(SRC, "components/customers/EditCustomerDialog.tsx"))).toMatch(/The customer can see and edit these in her portal/);
  });
});

describe("Messenger buttons are one control (no <Button> inside <a>)", () => {
  it("every Messenger link button uses Button asChild", () => {
    const offenders: string[] = [];
    for (const f of tsxFiles(SRC)) {
      const s = read(f);
      if (/<a href=\{messengerHref\([^}]*\) \?\? undefined\}[^>]*>\s*<Button/.test(s)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("H-01: proofs are opened through signed links", () => {
  const HOST = "https://abcdefghijklmnop.supabase.co";
  it("reads the object path from a stored proof link", () => {
    expect(proofObjectPath(`${HOST}/storage/v1/object/public/payment-proofs/0b1c2d3e-0000-4000-8000-123456789abc/slip.jpg`))
      .toBe("0b1c2d3e-0000-4000-8000-123456789abc/slip.jpg");
    expect(proofObjectPath(`${HOST}/storage/v1/object/sign/payment-proofs/a/b%20c.png?token=x`)).toBe("a/b c.png");
    expect(proofObjectPath(`${HOST}/storage/v1/object/public/payment-proofs/root-file.jpg`)).toBe("root-file.jpg");
    for (const bad of [null, "", "https://evil.example/x.jpg", `${HOST}/storage/v1/object/public/other-bucket/a.jpg`,
      `${HOST}/storage/v1/object/public/payment-proofs/a/../b.jpg`, `${HOST}/storage/v1/object/public/payment-proofs/a//b.jpg`,
      `${HOST}/storage/v1/object/public/payment-proofs/%E0%A4%A.jpg`]) {
      expect(proofObjectPath(bad), String(bad)).toBeNull();
    }
  });

  it("signs a batch once per object and maps every stored link to its signed link", async () => {
    const calls: string[][] = [];
    const fake = {
      storage: {
        from: (bucket: string) => {
          expect(bucket).toBe("payment-proofs");
          return {
            createSignedUrls: async (paths: string[], ttl: number) => {
              calls.push(paths);
              expect(ttl).toBe(3600);
              return { data: paths.map((p) => (p === "missing.jpg" ? { path: p, signedUrl: null, error: "Object not found" } : { path: p, signedUrl: `${HOST}/storage/v1/object/sign/payment-proofs/${p}?token=t`, error: null })), error: null };
            },
          };
        },
      },
    };
    const a = `${HOST}/storage/v1/object/public/payment-proofs/acc/1.jpg`;
    const missing = `${HOST}/storage/v1/object/public/payment-proofs/missing.jpg`;
    const map = await signProofUrls(fake, [a, a, missing, null, "https://evil.example/x.jpg"]);
    expect(calls).toEqual([["acc/1.jpg", "missing.jpg"]]);
    expect(map.get(a)).toMatch(/\/object\/sign\/payment-proofs\/acc\/1\.jpg\?token=t$/);
    expect(map.has(missing)).toBe(false);
    expect(map.size).toBe(1);
  });

  it("customer-facing signing only signs files under the customer's own ids", async () => {
    const fake = { storage: { from: () => ({ createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `${HOST}/s/${p}`, error: null })), error: null }) }) } };
    const mine = `${HOST}/storage/v1/object/public/payment-proofs/acc-1/a.jpg`;
    const other = `${HOST}/storage/v1/object/public/payment-proofs/acc-2/b.jpg`;
    const map = await signProofUrls(fake, [mine, other], 3600, new Set(["acc-1"]));
    expect([...map.keys()]).toEqual([mine]);
    expect(read(join(SRC, "../supabase/functions/customer-portal/index.ts"))).toMatch(/signProofUrls\(supabase, submissions\.map\(\(s: any\) => s\.proof_url\), undefined, ownProofPrefixes\)/);
  });

  it("a storage failure yields no links, never a throw", async () => {
    const failing = { storage: { from: () => ({ createSignedUrls: async () => ({ data: null, error: { message: "down" } }) }) } };
    expect((await signProofUrls(failing, [`${HOST}/storage/v1/object/public/payment-proofs/a.jpg`])).size).toBe(0);
    const throwing = { storage: { from: () => ({ createSignedUrls: async () => { throw new Error("boom"); } }) } };
    expect((await signProofUrls(throwing, [`${HOST}/storage/v1/object/public/payment-proofs/a.jpg`])).size).toBe(0);
  });

  it("staff and portal screens never link the stored public proof URL directly", () => {
    const ps = read(join(SRC, "pages/PaymentSubmissions.tsx"));
    const co = read(join(SRC, "pages/CashOrderDetail.tsx"));
    for (const [name, s] of [["PaymentSubmissions", ps], ["CashOrderDetail", co]] as const) {
      expect(s, name).not.toMatch(/safeHttpUrl\(|openSafeUrl\(/);
      expect(s, name).toMatch(/openProof\(/);
      expect(s, name).not.toMatch(/href="#"/);
    }
    for (const f of ["pages/AccountDetail.tsx", "pages/PaymentProofs.tsx"]) {
      const s = read(join(SRC, f));
      expect(s, f).not.toMatch(/getProofSignedUrl\([^)]*\)\.then\(/);
      expect(s, f).not.toMatch(/\|\| sub\.proof_url/);
      expect(s, f).toMatch(/openProof\(/);
    }
    expect(read(join(SRC, "lib/proof-url.ts"))).toMatch(/toast\.error\('Could not open this proof/);
    const portal = read(join(SRC, "pages/CustomerPortal.tsx"));
    expect(portal).not.toMatch(/href=\{safeHttpUrl\((?:sub\.proof_url|editProofCurrent)\)/);
    expect(portal).toMatch(/proof_view_url/);
    expect(read(join(SRC, "../supabase/functions/customer-portal/index.ts"))).toMatch(/proof_view_url: \(sub\.proof_url && proofViewUrls\.get\(sub\.proof_url\)\) \|\| null/);
  });
});
