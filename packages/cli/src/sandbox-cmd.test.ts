import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeSnapshot } from "@wolfpack/engine";
import { installDevExtensions } from "./bundle.js";
import { localSnapshotSource, mixedSnapshotSource, protectedRoots, resolveExtensionKeys, sandboxCmd, syncthingFolderPaths } from "./commands/sandbox.js";

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

describe("mixed sources (production-like dev sandbox)", () => {
  const put = (f: string, body: string) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };

  it("syncthingFolderPaths reads only <folder path=...> and protectedRoots adds the live KB, lanes, local and host mirrors", () => {
    const xml = '<configuration><folder id="a" label="x" path="/Users/u/wolves/knowledge/base/domains/wolfpack" type="sendreceive"><device id="SECRET-DEVICE-ID"/></folder><folder id="b" path="~/wolves/librarian/inbox/1uk4"></folder><folder id="default" label="Default Folder" path=""></folder><device id="D" name="n"><address>dynamic</address></device></configuration>';
    expect(syncthingFolderPaths(xml)).toEqual(["/Users/u/wolves/knowledge/base/domains/wolfpack", path.join(os.homedir(), "wolves/librarian/inbox/1uk4")]);
    const cfg = path.join(tmp, "config.xml");
    fs.writeFileSync(cfg, xml);
    const roots = protectedRoots({ wolvesRoot: "/w" }, cfg);
    expect(roots).toEqual(expect.arrayContaining(["/w/knowledge", "/w/librarian", "/w/local", "/w/sfo-01", "/Users/u/wolves/knowledge/base/domains/wolfpack"]));
    expect(protectedRoots({ wolvesRoot: "/w" }, path.join(tmp, "missing.xml"))).toHaveLength(4);
  });

  it("mixedSnapshotSource: the ledger/items are the only remote part; den, KB and ops stay local", () => {
    const remote = mixedSnapshotSource({ den: "/d", kbBase: "/kb", workMdFrom: "/mirror", ledgerRemote: { at: "root@h", kbRoot: "/var/wolfpack/kb" } });
    expect(remote).toEqual({ workDir: "root@h:/var/wolfpack/kb/work", workBaseDir: "/mirror", denDir: "/d", kbBaseDir: "/kb" });
    const local = mixedSnapshotSource({ den: "/d", workFrom: "/w", ops: "/o", opsLane: "1uk4-dev, x" });
    expect(local).toEqual({ workDir: "/w", denDir: "/d", opsDir: "/o", opsLanes: ["1uk4-dev", "x"] });
  });

  it("sandbox snapshot --den --kb-base --work-from --shared builds a shared root; add-wolf adds the librarian's den; refresh keeps both", async () => {
    put(path.join(tmp, "stand-in/ledger/work-events.jsonl"), '{"id":"a"}\n');
    put(path.join(tmp, "stand-in/base/domains/wolfpack/work/work-wolfpack-a.md"), "# a\n");
    put(path.join(tmp, "den/memory/t.md"), "t\n");
    put(path.join(tmp, "kb/domains.yaml"), "domains: [wolfpack]\n");
    const dev = path.join(tmp, "dev");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await sandboxCmd(["snapshot", "1uk4-dev", "--dev-root", dev, "--den", path.join(tmp, "den"), "--kb-base", path.join(tmp, "kb"), "--work-from", path.join(tmp, "stand-in"), "--shared", "--extensions", "memory"]);
      const m = JSON.parse(fs.readFileSync(path.join(dev, "snapshot.json"), "utf8"));
      expect(m.den).toBe("dens/1uk4-dev");
      expect(m.counts).toMatchObject({ ledgerEvents: 1, workItems: 1, kbBaseFiles: 1 });
      expect(fs.existsSync(path.join(dev, "dens/1uk4-dev/memory/t.md"))).toBe(true);
      expect(fs.existsSync(path.join(dev, "dens/1uk4-dev/extensions/wolfpack-memory/index.js"))).toBe(true);
      expect(fs.existsSync(path.join(dev, "kb-base/domains.yaml"))).toBe(true);

      await sandboxCmd(["add-wolf", dev, "dewey-dev", "--extensions", "memory"]);
      expect(fs.existsSync(path.join(dev, "dens/dewey-dev/extensions/wolfpack-memory/index.js"))).toBe(true);

      put(path.join(tmp, "stand-in/ledger/work-events.jsonl"), '{"id":"a"}\n{"id":"b"}\n');
      await sandboxCmd(["snapshot", "1uk4-dev", "--dev-root", dev, "--work-from", path.join(tmp, "stand-in"), "--refresh-work", "--den", path.join(tmp, "den")]);
      expect(fs.readFileSync(path.join(dev, "ledger/work-events.jsonl"), "utf8")).toBe('{"id":"a"}\n{"id":"b"}\n');
      expect(fs.existsSync(path.join(dev, "dens/dewey-dev/extensions/wolfpack-memory/index.js"))).toBe(true);
      expect(fs.existsSync(path.join(dev, "kb-base/domains.yaml"))).toBe(true);
    } finally {
      [log, err].forEach((x) => x.mockRestore());
    }
  }, 90_000);
});

describe("add-wolf on a single-wolf root", () => {
  it("refuses with a clear message and changes nothing", async () => {
    const root = path.join(tmp, "single");
    fs.mkdirSync(path.join(root, "den"), { recursive: true });
    fs.writeFileSync(path.join(root, "snapshot.json"), "{}");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    try {
      await expect(sandboxCmd(["add-wolf", root, "dewey-dev"])).rejects.toThrow("exit");
      expect(err.mock.calls.flat().join("\n")).toMatch(/single-wolf sandbox .*--shared/);
      expect(fs.existsSync(path.join(root, "dens"))).toBe(false);
    } finally {
      [err, exit].forEach((m) => m.mockRestore());
    }
  });
});
