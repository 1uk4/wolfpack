import { defineConfig } from "vitest/config";

/**
 * Only ever collect TypeScript test SOURCES under each package's src/.
 * This prevents vitest from double-running compiled `.js` test artifacts that
 * ad-hoc `tsc` runs can leave in src/ or emit into dist/.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Tests run from inside a wolf's shell; never let them log usage (or
    // anything else keyed off the den) into that wolf's real den.
    env: { WOLF_DEN: "", WOLF_NAME: "" },
  },
});
