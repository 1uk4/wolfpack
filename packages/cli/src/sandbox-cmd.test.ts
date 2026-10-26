import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeSnapshot } from "@wolfpack/engine";
import { installDevExtensions } from "./bundle.js";
import { localSnapshotSource, resolveExtensionKeys, sandboxCmd } from "./commands/sandbox.js";

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
    fs.writeFileSync(path.join(tmp, "work/base/domains/wolfpack/work/work-wolfpack-a.md"), "# a\n");
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

describe("snapshot --from end to end", () => {
  const put = (f: string, body: string) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };

  it("copies the item .md files from the work server layout (work/base)", () => {
    put(path.join(tmp, "src/work/ledger/work-events.jsonl"), '{"id":"a"}\n');
    put(path.join(tmp, "src/work/base/domains/wolfpack/work/work-wolfpack-a.md"), "# a\n");
    put(path.join(tmp, "src/work/base/domains/wolfpack/entries/kb.md"), "not work\n");
    fs.mkdirSync(path.join(tmp, "src/ops"));
    fs.mkdirSync(path.join(tmp, "src/den"));
    const dev = path.join(tmp, "dev");
    const m = takeSnapshot({ source: localSnapshotSource(path.join(tmp, "src")), devRoot: dev });
    expect(m.counts.workItems).toBe(1);
    expect(fs.readFileSync(path.join(dev, "base/domains/wolfpack/work/work-wolfpack-a.md"), "utf8")).toBe("# a\n");
    expect(fs.existsSync(path.join(dev, "base/domains/wolfpack/entries"))).toBe(false);
  });

  it("an empty <from>/base does not shadow a populated <from>/work/base", () => {
    put(path.join(tmp, "src/work/ledger/work-events.jsonl"), '{"id":"a"}\n');
    fs.mkdirSync(path.join(tmp, "src/base/domains/wolfpack/work"), { recursive: true });
    put(path.join(tmp, "src/work/base/domains/wolfpack/work/work-wolfpack-a.md"), "# a\n");
    fs.mkdirSync(path.join(tmp, "src/ops"));
    fs.mkdirSync(path.join(tmp, "src/den"));
    expect(localSnapshotSource(path.join(tmp, "src")).workBaseDir).toBe(path.join(tmp, "src/work/base"));
    expect(takeSnapshot({ source: localSnapshotSource(path.join(tmp, "src")), devRoot: path.join(tmp, "dev") }).counts.workItems).toBe(1);
  });

  it("an empty or missing base yields zero items without failing", () => {
    put(path.join(tmp, "src/work/ledger/work-events.jsonl"), '{"id":"a"}\n');
    fs.mkdirSync(path.join(tmp, "src/work/base"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "src/ops"));
    fs.mkdirSync(path.join(tmp, "src/den"));
    expect(takeSnapshot({ source: localSnapshotSource(path.join(tmp, "src")), devRoot: path.join(tmp, "dev") }).counts.workItems).toBe(0);
  });
});

describe("resolveExtensionKeys", () => {
  it("explicit > source wolf.yaml extensions > memory", () => {
    const y = path.join(tmp, "wolf.yaml");
    fs.writeFileSync(y, "name: w\nextensions: [memory, telegram]\n");
    expect(resolveExtensionKeys("ask", y)).toEqual({ keys: ["ask"], from: "--extensions" });
    expect(resolveExtensionKeys(undefined, y).keys).toEqual(["memory", "telegram"]);
    expect(resolveExtensionKeys(undefined, path.join(tmp, "nope.yaml")).keys).toEqual(["memory"]);
  });
});

describe("sandboxCmd wiring", () => {
  it("--no-install-extensions snapshots without installing; default installs; install failure is not 'Snapshot failed'", async () => {
    const src = path.join(tmp, "src");
    for (const d of ["work/ledger", "ops", "den/extensions/stale"]) fs.mkdirSync(path.join(src, d), { recursive: true });
    fs.writeFileSync(path.join(src, "work/ledger/work-events.jsonl"), "");
    fs.writeFileSync(path.join(src, "den/extensions/stale/index.js"), "//");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    try {
      await sandboxCmd(["snapshot", "w", "--dev-root", path.join(tmp, "dev1"), "--from", src, "--no-install-extensions"]);
      expect(fs.existsSync(path.join(tmp, "dev1/den/extensions"))).toBe(false);

      await sandboxCmd(["snapshot", "w", "--dev-root", path.join(tmp, "dev2"), "--from", src]);
      expect(fs.existsSync(path.join(tmp, "dev2/den/extensions/wolfpack-memory/index.js"))).toBe(true);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/stale/);
      fs.writeFileSync(path.join(src, "work/ledger/work-events.jsonl"), '{"id":"a"}\n');
      await sandboxCmd(["snapshot", "w", "--dev-root", path.join(tmp, "dev4"), "--from", src, "--no-install-extensions"]);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/ledger has events but 0 work item/);

      await expect(sandboxCmd(["snapshot", "w", "--dev-root", path.join(tmp, "dev3"), "--from", src, "--extensions", "no-such"])).rejects.toThrow("exit");
      const msg = err.mock.calls.flat().join("\n");
      expect(msg).toMatch(/snapshot OK; extension install failed/);
      expect(msg).toMatch(/install-extensions/);
      expect(msg).not.toMatch(/Snapshot failed/);
      expect(fs.existsSync(path.join(tmp, "dev3/snapshot.json"))).toBe(true);
    } finally {
      [log, warn, err, exit].forEach((m) => m.mockRestore());
    }
  }, 60_000);
});
