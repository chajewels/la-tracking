import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Website → Settings: typing must not lose focus after each keystroke.
 *
 * The bug (docs/FIXED-BUGS.md, "Website Settings fields accept one keystroke
 * at a time"): SettingsCard defined BilingualField, SocialList and SectionSave
 * inside its own render and used them as JSX elements. Every keystroke calls
 * setDraft, SettingsCard re-renders, each render made a NEW component type, and
 * React unmounted the field being typed in — focus fell to <body> and only one
 * character landed per click.
 *
 * Each field below gets several characters in a row. After every one, the SAME
 * DOM node must still be the field, still be focused, and hold the full text.
 * Contact email is a plain inline <Input> and was never affected: it is the
 * control that proves the harness itself does not drop focus.
 */

vi.mock("@/integrations/supabase/client", () => {
  const rows = [
    { key: "contact.email", value: "a@b.c", kind: "text", public: true, updated_at: null },
    { key: "footer.tagline", value: { en: "Old", ja: "旧" }, kind: "bilingual", public: true, updated_at: null },
    { key: "announcement.text", value: { en: "Sale", ja: "セール" }, kind: "bilingual", public: true, updated_at: null },
    { key: "social.follow", value: [{ key: "instagram", href: "https://ig" }], kind: "json", public: true, updated_at: null },
    { key: "social.loyalty_groups", value: [{ key: "facebook", href: "https://fb" }], kind: "json", public: true, updated_at: null },
  ];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.order = () => Promise.resolve({ data: rows, error: null });
  return { supabase: { from: () => chain, functions: { invoke: vi.fn() } } };
});
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u" }, roles: ["admin"] }) }));
vi.mock("@/contexts/PermissionsContext", () => ({ usePermissions: () => ({ can: () => true }) }));

import { SettingsCard } from "@/components/website/SettingsCard";

async function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><SettingsCard /></QueryClientProvider>);
  await waitFor(() =>
    expect((document.getElementById("footer.tagline-en") as HTMLTextAreaElement | null)?.value).toBe("Old"),
  );
}

const byId = (id: string) => () => document.getElementById(id) as HTMLInputElement;
const byLabel = (label: string) => () => screen.getByLabelText(label) as HTMLInputElement;

/** Type `text` one character at a time into the field `get` returns. */
function typeInto(get: () => HTMLInputElement, text: string) {
  const field = get();
  field.focus();
  const start = field.value;
  let typed = "";
  for (const ch of text) {
    typed += ch;
    fireEvent.change(field, { target: { value: start + typed } });
    // The field on screen is still the node we started typing in…
    expect(get()).toBe(field);
    expect(document.contains(field)).toBe(true);
    // …it still has focus, so the next keystroke lands in it…
    expect(document.activeElement).toBe(field);
    // …and it holds everything typed so far.
    expect(field.value).toBe(start + typed);
  }
}

describe("Website Settings — typing keeps focus", () => {
  it.each([
    ["Tagline (English)", byId("footer.tagline-en")],
    ["Tagline (Japanese)", byId("footer.tagline-ja")],
    ["Announcement (English)", byId("announcement.text-en")],
    ["Follow us link", byLabel("Follow us row 1 link")],
    ["Loyalty groups link", byLabel("Loyalty groups row 1 link")],
    ["Contact email (control)", byId("contact-email")],
  ])("%s holds a whole word typed in one go", async (_name, get) => {
    await setup();
    typeInto(get, "jewels");
  });
});
