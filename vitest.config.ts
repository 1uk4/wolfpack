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
  },
});
