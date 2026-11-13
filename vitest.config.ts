import { defineConfig } from "vitest/config";

/**
 * Only ever collect TypeScript test SOURCES under each package's src/.
 * This prevents vitest from double-running compiled `.js` test artifacts that
 * ad-hoc `tsc` runs can leave in src/ or emit into dist/.
 *
 * Three projects, one mechanism for the slow tests (docs/testing.md):
 *  - default: everything except `*.live.test.*` and `*.eval.test.*`. `wolfpack test` and `pnpm test` select it.
 *  - eval:    only `*.eval.test.*`  (`pnpm test:eval`; release PR only).
 *  - live:    only `*.live.test.*`  (`pnpm test:live`; this Mac only, before the release PR).
 */
const include = ["packages/*/src/**/*.test.ts", "extensions/wolfpack-subagents/*.test.ts", "extensions/wolfpack-memory/*.test.ts", "extensions/wolfpack-browser/*.test.ts", "scripts/*.test.ts", "apps/desktop/electron/*.test.ts"];
const base = ["**/node_modules/**", "**/dist/**"];
const shared = {
  // Tests run from inside a wolf's shell; never let them log usage (or
  // anything else keyed off the den) into that wolf's real den.
  env: { WOLF_DEN: "", WOLF_NAME: "" },
  // Everything else ambient is deleted (not blanked) here.
  setupFiles: ["./vitest.setup.ts"],
};

export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: "default", include, exclude: [...base, "**/*.live.test.*", "**/*.eval.test.*"] } },
      { test: { ...shared, name: "eval", include: include.map((g) => g.replace(".test.ts", ".eval.test.ts")), exclude: base } },
      { test: { ...shared, name: "live", include: include.map((g) => g.replace(".test.ts", ".live.test.ts")), exclude: base } },
    ],
  },
});
