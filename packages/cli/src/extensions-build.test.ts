import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AVAILABLE_EXTENSIONS, extensionsDir } from "./extensions.js";
import { findDenExtension, buildDenExtension } from "./den-extensions.js";
import { buildDurableExtension, skipReasons } from "./bundle.js";

/**
 * Every extensions/* in the repo must bundle from this checkout's node_modules layout (npm hoisted, or pnpm strict:
 * extensions are not workspaces, so whatever they import must be declared at the root).
 */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ext-build-"));
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

describe("every repo extension bundles", () => {
  for (const ext of AVAILABLE_EXTENSIONS) {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionsDir(), ext.dir, "package.json"), "utf8")) as { "pi-durable"?: { extensions?: string[] } };
    const src = findDenExtension(extensionsDir(), ext.dir);

    it.skipIf(!src)(`${ext.dir}: builds through the den-extension path (index.ts)`, async () => {
      const file = path.join(out, "den", ext.dir, "index.js");
      await buildDenExtension(src!, file);
      expect(fs.statSync(file).size).toBeGreaterThan(0);
    }, 120_000);

    it.skipIf(!pkg["pi-durable"]?.extensions?.length)(`${ext.dir}: builds its pi-durable bundle`, async () => {
      const ok = await buildDurableExtension(ext.key, path.join(out, "durable"), undefined);
      expect(ok, skipReasons.get(ext.key)).toBe(true);
      expect(fs.statSync(path.join(out, "durable", ext.dir, "index.js")).size).toBeGreaterThan(0);
    }, 120_000);
  }
});
