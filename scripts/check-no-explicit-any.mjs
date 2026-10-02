// CI guard: no `any` in src/ (S4 #36, closed 2026-10-03 — 754 removed, types
// only). Runs ESLint with ONLY @typescript-eslint/no-explicit-any as an error,
// so the repo's other lint findings do not fail this step. A deliberate escape
// is `// eslint-disable-next-line @typescript-eslint/no-explicit-any` with a
// reason on the line above.
import { ESLint } from "eslint";

const eslint = new ESLint({
  overrideConfig: { rules: { "@typescript-eslint/no-explicit-any": "error" } },
});
const results = await eslint.lintFiles(["src/**/*.{ts,tsx}"]);
const hits = [];
for (const r of results) {
  for (const m of r.messages) {
    if (m.ruleId === "@typescript-eslint/no-explicit-any") {
      hits.push(`${r.filePath.replace(process.cwd() + "/", "")}:${m.line}:${m.column}`);
    }
  }
}
if (hits.length) {
  console.error(`no-explicit-any: ${hits.length} \`any\` in src/ — type them (see scripts/check-no-explicit-any.mjs):`);
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log("no-explicit-any: 0 in src/");
