import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { highestRole, roleLabel } from "@/lib/role-label";

// Header and sidebar footer showed different roles for the same user
// (2026-09-24: "Staff" in the header, a hardcoded "Admin" in the footer).
describe("role label: one source, highest role wins", () => {
  it("labels a single role", () => {
    expect(roleLabel(["staff"])).toBe("Staff");
    expect(roleLabel(["admin"])).toBe("Admin");
    expect(roleLabel(["csr"])).toBe("CSR");
    expect(roleLabel(["live_agent"])).toBe("Live Agent");
  });

  it("shows the highest of several roles, whatever order the rows come in", () => {
    expect(roleLabel(["staff", "admin"])).toBe("Admin");
    expect(roleLabel(["admin", "staff"])).toBe("Admin");
    expect(roleLabel(["csr", "finance", "staff"])).toBe("Finance");
    expect(highestRole(["csr", "staff"])).toBe("staff");
  });

  it("falls back to 'User' with no roles", () => {
    expect(roleLabel([])).toBe("User");
    expect(roleLabel(null)).toBe("User");
  });

  it("header and sidebar footer both read it; neither hardcodes a role", () => {
    const layout = readFileSync("src/components/layout/AppLayout.tsx", "utf8");
    const sidebar = readFileSync("src/components/layout/AppSidebar.tsx", "utf8");
    expect(layout).toMatch(/roleLabelFor\(roles\)/);
    expect(layout).not.toMatch(/roles\[0\]/);
    expect(sidebar).toMatch(/\{roleLabel\(roles\)\}/);
    expect(sidebar).not.toMatch(/text-primary">Admin</);
  });
});
