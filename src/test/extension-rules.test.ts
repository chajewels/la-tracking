import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  customerSettleByDate,
  daysSinceForfeiture,
  EXTENSION_WINDOW_CLOSED_MESSAGE,
  extensionEndFromForfeiture,
  extensionExpired,
  extensionWindowOpen,
  penaltyBlockedByExtensionEnd,
  phtDay,
} from "../../supabase/functions/_shared/extension-rules.ts";
import { canReactivate } from "@/lib/business-rules";

// Reactivation -> final forfeiture, owner rules 2026-10-20 (R1-R6).
// docs/PENALTY-AND-FORFEITURE.md "Extension end date and final forfeiture".
// The pure rules are tested directly; the three locked edge functions are
// guarded on their source ORDER (comments stripped), because the order is the
// rule: frozen skip first, then the extension end, then everything else.

const DAY = 86_400_000;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}
const code = (path: string) => stripComments(readFileSync(path, "utf8"));

describe("R1 — the extension ends one month after the FORFEITURE date", () => {
  it("18788: forfeited 2026-09-20 00:10 UTC -> ends 2026-10-20", () => {
    expect(extensionEndFromForfeiture("2026-09-20T00:10:03.194Z")).toBe(
      "2026-10-20",
    );
  });

  it("does not depend on when staff reactivate (0, 3, 7 days later)", () => {
    const forfeitedAt = "2026-10-01T00:10:00Z";
    const realNow = Date.now;
    try {
      for (const days of [0, 3, 7]) {
        Date.now = () =>
          new Date(forfeitedAt).getTime() + days * DAY + 5 * 3_600_000;
        expect(extensionEndFromForfeiture(forfeitedAt)).toBe("2026-11-01");
      }
    } finally {
      Date.now = realNow;
    }
  });

  it("uses the PHT calendar day of forfeited_at (UTC+8 boundary)", () => {
    expect(phtDay("2026-09-19T15:59:59Z")).toBe("2026-09-19");
    expect(phtDay("2026-09-19T16:00:00Z")).toBe("2026-09-20");
    expect(extensionEndFromForfeiture("2026-09-19T15:59:59Z")).toBe(
      "2026-10-19",
    );
    expect(extensionEndFromForfeiture("2026-09-19T16:00:00Z")).toBe(
      "2026-10-20",
    );
  });

  it("clamps to the last day of the target month", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29"); // leap year
    expect(addMonthsClamped("2026-03-31", 1)).toBe("2026-04-30");
    expect(addMonthsClamped("2026-08-31", 1)).toBe("2026-09-30");
    expect(addMonthsClamped("2026-10-30", 1)).toBe("2026-11-30");
    expect(addMonthsClamped("2026-12-31", 1)).toBe("2027-01-31"); // year rollover
    expect(addMonthsClamped("2026-02-28", 1)).toBe("2026-03-28");
  });

  it("an end-of-month forfeiture clamps (PHT day 2026-01-31 -> 2026-02-28)", () => {
    expect(extensionEndFromForfeiture("2026-01-31T00:10:00Z")).toBe(
      "2026-02-28",
    );
  });
});

describe("R2 — reactivation follows the 7-day extension-request window", () => {
  const forfeitedAt = "2026-10-01T00:10:00Z";
  const t0 = new Date(forfeitedAt).getTime();

  it("7 whole days elapsed is open; 8 is closed", () => {
    expect(daysSinceForfeiture(forfeitedAt, t0 + 7 * DAY)).toBe(7);
    expect(extensionWindowOpen(forfeitedAt, t0 + 7 * DAY)).toBe(true);
    expect(extensionWindowOpen(forfeitedAt, t0 + 8 * DAY - 1)).toBe(true);
    expect(daysSinceForfeiture(forfeitedAt, t0 + 8 * DAY)).toBe(8);
    expect(extensionWindowOpen(forfeitedAt, t0 + 8 * DAY)).toBe(false);
  });

  it("the customer's no-timestamp case stays open (portal behaviour)", () => {
    expect(extensionWindowOpen(null)).toBe(true);
    expect(extensionWindowOpen(undefined)).toBe(true);
  });

  it("canReactivate: forfeited, never reactivated, has forfeited_at, inside the window", () => {
    expect(canReactivate("forfeited", false, forfeitedAt, t0 + 7 * DAY)).toBe(
      true,
    );
    expect(canReactivate("forfeited", false, forfeitedAt, t0 + 8 * DAY)).toBe(
      false,
    );
    expect(canReactivate("forfeited", false, null, t0)).toBe(false);
    expect(canReactivate("forfeited", true, forfeitedAt, t0)).toBe(false);
    expect(canReactivate("final_forfeited", false, forfeitedAt, t0)).toBe(
      false,
    );
    expect(canReactivate("extension_active", false, forfeitedAt, t0)).toBe(
      false,
    );
  });

  it("the refusal is the customer's own message", () => {
    expect(EXTENSION_WINDOW_CLOSED_MESSAGE).toBe(
      "The extension request window has closed. Please contact us directly for assistance.",
    );
  });
});

describe("R3 — no penalty on or after the extension end date", () => {
  // The rule is the same for PHP and JPY accounts and for CLEAN and DIRTY
  // accounts: it gates the whole account before any cap (incl. the CLEAN +1000
  // / +2000 bump) is looked at.
  for (const currency of ["PHP", "JPY"]) {
    for (const kind of ["CLEAN", "DIRTY"]) {
      it(`${currency} ${kind}: end-1 accrues, end and end+1 do not`, () => {
        expect(
          penaltyBlockedByExtensionEnd(
            "extension_active",
            "2026-10-20",
            "2026-10-19",
          ),
        ).toBe(false);
        expect(
          penaltyBlockedByExtensionEnd(
            "extension_active",
            "2026-10-20",
            "2026-10-20",
          ),
        ).toBe(true);
        expect(
          penaltyBlockedByExtensionEnd(
            "extension_active",
            "2026-10-20",
            "2026-10-21",
          ),
        ).toBe(true);
      });
    }
  }

  it("only extension_active accounts are gated", () => {
    for (const status of ["active", "overdue"]) {
      expect(
        penaltyBlockedByExtensionEnd(status, "2026-10-20", "2026-10-25"),
      ).toBe(false);
    }
    expect(
      penaltyBlockedByExtensionEnd("extension_active", null, "2026-10-25"),
    ).toBe(false);
  });
});

describe("R4 — final forfeiture ON the end date", () => {
  it("end-1 false, end true, end+1 true", () => {
    expect(extensionExpired("2026-10-20", "2026-10-19")).toBe(false);
    expect(extensionExpired("2026-10-20", "2026-10-20")).toBe(true);
    expect(extensionExpired("2026-10-20", "2026-10-21")).toBe(true);
    expect(extensionExpired(null, "2026-10-21")).toBe(false);
  });
});

describe("R6 — the customer is told the day before the end date", () => {
  it("end - 1 day, across month and year boundaries", () => {
    expect(customerSettleByDate("2026-10-20")).toBe("2026-10-19");
    expect(customerSettleByDate("2026-03-01")).toBe("2026-02-28");
    expect(customerSettleByDate("2028-03-01")).toBe("2028-02-29");
    expect(customerSettleByDate("2027-01-01")).toBe("2026-12-31");
  });
});

describe("locked functions — source order (comments stripped)", () => {
  it("reactivate-account: R1 anchor + R2 window before the RPC; no reactivation-date maths", () => {
    const src = code("supabase/functions/reactivate-account/index.ts");
    expect(src).not.toMatch(/setUTCMonth/);
    expect(src).toMatch(/payment_plan_months, forfeited_at"\)/);
    const missing = src.indexOf('"forfeited_at_missing"');
    const window = src.indexOf("extensionWindowOpen(account.forfeited_at)");
    const end = src.indexOf("extensionEndFromForfeiture(account.forfeited_at)");
    const rpc = src.indexOf('rpc("reactivate_layaway_atomic"');
    for (const i of [missing, window, end, rpc]) expect(i).toBeGreaterThan(-1);
    expect(missing).toBeLessThan(window);
    expect(window).toBeLessThan(rpc);
    expect(end).toBeLessThan(rpc);
    expect(src).toMatch(
      /error: EXTENSION_WINDOW_CLOSED_MESSAGE, code: "window_closed"/,
    );
    // R6: customer copy carries the settle-by day, the RPC the real end date.
    expect(src).toMatch(/planOpenUntil: settleByDate,/);
    expect(src).toMatch(/p_extension_end_date: extensionEndDate,/);
  });

  it("auto-forfeit-settlement: frozen skip first, then R4; cap path retired", () => {
    const src = code("supabase/functions/auto-forfeit-settlement/index.ts");
    expect(src).not.toMatch(/T23:59:59Z/);
    expect(src).not.toMatch(/auto_forfeit_extension_penalty_cap/);
    expect(src).not.toMatch(/payment_plan_months \+ 1/);
    const frozen = src.indexOf(
      "if (frozenAccountIds.has(account.id)) continue;",
    );
    const expired = src.indexOf("extensionExpired(extEnd, todayPht)");
    expect(frozen).toBeGreaterThan(-1);
    expect(expired).toBeGreaterThan(frozen);
    expect(src).toMatch(
      /const todayPht = Intl\.DateTimeFormat\("en-CA", \{ timeZone: "Asia\/Manila" \}\)\.format\(now\)/,
    );
    // Independence rule: never calls the penalty engine.
    expect(src).not.toMatch(/penalty-engine/);
  });

  it("penalty-engine: frozen skip, then R3, before any trigger or cap", () => {
    const src = code("supabase/functions/penalty-engine/index.ts");
    expect(src).toMatch(/is_reactivated, extension_end_date\)"\)/);
    const frozen = src.indexOf(
      "if (frozenAccountIds.has(accountId)) continue;",
    );
    const blocked = src.indexOf("penaltyBlockedByExtensionEnd(");
    // R7 (2026-10-20) moved the cap (incl. the CLEAN bump) and the trigger
    // dates into _shared/penalty-schedule.ts; the engine calls them here.
    const bump = src.indexOf("penaltyCapFor(");
    const triggers = src.indexOf("buildTriggerDates(");
    for (const i of [frozen, blocked, bump, triggers])
      expect(i).toBeGreaterThan(-1);
    expect(frozen).toBeLessThan(blocked);
    expect(blocked).toBeLessThan(bump); // CLEAN bump only before the end date
    expect(blocked).toBeLessThan(triggers); // covers new AND waived-to-unpaid
    expect(code("supabase/functions/_shared/penalty-schedule.ts")).toContain(
      'cap += currency === "PHP" ? 1000 : 2000;',
    );
    // Independence rule: never calls auto-forfeit-settlement.
    expect(src).not.toMatch(/auto-forfeit-settlement/);
  });

  it("request-extension and the portal use the one shared window check", () => {
    for (const path of [
      "supabase/functions/request-extension/index.ts",
      "src/pages/CustomerPortal.tsx",
    ]) {
      const src = code(path);
      expect(src).toMatch(/extensionWindowOpen\(/);
      expect(src).not.toMatch(/forfeited_at\)\.getTime\(\)/); // no inline window maths left
    }
  });
});
