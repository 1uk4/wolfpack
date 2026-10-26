import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDevExtensions } from "./bundle.js";
import { localSnapshotSource } from "./commands/sandbox.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-sandbox-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("localSnapshotSource (--from layouts)", () => {
  it("reads item .md files from <from>/base when present", () => {
    fs.mkdirSync(path.join(tmp, "base"));
    fs.mkdirSync(path.join(tmp, "work/base"), { recursive: true });
    expect(localSnapshotSource(tmp).workBaseDir).toBe(path.join(tmp, "base"));
  });

  it("falls back to the work server's layout <from>/work/base", () => {
    fs.mkdirSync(path.join(tmp, "work/base/domains/wolfpack/work"), { recursive: true });
    const s = localSnapshotSource(tmp);
    expect(s.workBaseDir).toBe(path.join(tmp, "work/base"));
    expect(s.workDir).toBe(path.join(tmp, "work"));
    expect(s.denDir).toBe(path.join(tmp, "den"));
  });
});

describe("installDevExtensions", () => {
  it("builds the CURRENT memory bundle into <dev>/den/extensions, replacing a stale one and leaving others", async () => {
    const ext = path.join(tmp, "den/extensions");
    fs.mkdirSync(path.join(ext, "wolfpack-memory"), { recursive: true });
    fs.writeFileSync(path.join(ext, "wolfpack-memory/index.js"), "// stale\n");
    fs.mkdirSync(path.join(ext, "other"));
    fs.writeFileSync(path.join(ext, "other/index.js"), "// keep\n");

    const r = await installDevExtensions(tmp, ["memory"]);
    expect(r).toEqual({ included: ["memory"], missing: [] });
    const built = fs.readFileSync(path.join(ext, "wolfpack-memory/index.js"), "utf8");
    expect(built).not.toContain("// stale");
    expect(built).toContain("task_bind");
    expect(fs.readFileSync(path.join(ext, "other/index.js"), "utf8")).toBe("// keep\n");
  }, 60_000);

  it("reports keys it cannot build and writes nothing for them", async () => {
    const r = await installDevExtensions(tmp, ["no-such-extension"]);
    expect(r).toEqual({ included: [], missing: ["no-such-extension"] });
    expect(fs.existsSync(path.join(tmp, "den/extensions"))).toBe(false);
  });
});
