import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDurableExtension, skipReasons } from "./bundle.js";

const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "bx-bundle-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("browser extension bundling", () => {
  it("builds the real bundle (proves playwright-core/package.json resolves)", async () => {
    const out = tmp();
    expect(await buildDurableExtension("browser", out)).toBe(true);
    const dir = path.join(out, "wolfpack-browser");
    expect(fs.existsSync(path.join(dir, "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "browsers.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("playwright-core");
    expect(fs.readdirSync(out).filter((n) => n.startsWith("."))).toEqual([]); // no staging dir left behind
  }, 120000);

  it("skips (false + visible reason) when playwright-core is unavailable, leaving an existing install alone", async () => {
    const out = tmp();
    const dir = path.join(out, "wolfpack-browser");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), "// working install");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ok = await buildDurableExtension("browser", out, undefined, { resolvePackage: () => { throw new Error("Cannot find module 'playwright-core'"); } });
    expect(ok).toBe(false);
    expect(skipReasons.get("browser")).toMatch(/playwright-core unavailable/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/browser: skipped/));
    expect(fs.readFileSync(path.join(dir, "index.js"), "utf8")).toBe("// working install");
  });

  it("sweeps staging dirs a crashed build left behind and replaces an old install wholesale", async () => {
    const out = tmp();
    fs.mkdirSync(path.join(out, ".wolfpack-browser-build-dead"), { recursive: true });
    fs.mkdirSync(path.join(out, "wolfpack-browser"), { recursive: true });
    fs.writeFileSync(path.join(out, "wolfpack-browser", "stale.txt"), "old");
    expect(await buildDurableExtension("browser", out)).toBe(true);
    expect(fs.readdirSync(out).filter((n) => n.startsWith("."))).toEqual([]);
    expect(fs.existsSync(path.join(out, "wolfpack-browser", "stale.txt"))).toBe(false);
    expect(fs.existsSync(path.join(out, "wolfpack-browser", "index.js"))).toBe(true);
  }, 120000);
});
