import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDenExtension, findDenExtension } from "./den-extensions.js";

describe("den extensions", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-den-ext-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const put = (name: string, file: string, body: string) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, file), body);
  };

  it("prefers index.ts over index.js, and finds nothing for unknown or unsafe names", () => {
    put("a", "index.ts", "export default {}");
    put("a", "index.js", "module.exports = {}");
    put("b", "index.js", "module.exports = {}");
    expect(findDenExtension(root, "a")?.kind).toBe("ts");
    expect(findDenExtension(root, "b")?.kind).toBe("js");
    expect(findDenExtension(root, "nope")).toBeUndefined();
    expect(findDenExtension(root, "../x")).toBeUndefined();
  });

  it("builds index.ts into a loadable CJS file, bundling @wolfpack imports", async () => {
    put("p", "index.ts", `
      import { defineExtension } from "@wolfpack/harness/extension";
      export default () => defineExtension({ name: "p", lifecycle: { start() {} } });
    `);
    const out = path.join(root, "out", "p", "index.js");
    await buildDenExtension(findDenExtension(root, "p")!, out);
    const mod = createRequire(import.meta.url)(out);
    const factory = mod.default ?? mod;
    expect(factory().name).toBe("p");
    expect(typeof factory().lifecycle.start).toBe("function");
  });

  it("ships a prebuilt index.js unchanged", async () => {
    put("j", "index.js", "module.exports = { marker: 1 };");
    const out = path.join(root, "out", "j", "index.js");
    await buildDenExtension(findDenExtension(root, "j")!, out);
    expect(fs.readFileSync(out, "utf-8")).toBe("module.exports = { marker: 1 };");
  });
});
