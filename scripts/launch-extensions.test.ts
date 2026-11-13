import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// work-wolfpack-K10dues: a wolfd release carries the extension bundles it was built with; launch.sh (which ships per release, so a
// rollback to release.prev runs the OLD one) installs them into the wolf's den before wolfd starts. Driven with temp dirs and a stub wolfd.
const repo = join(__dirname, "..");
const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

const put = (path: string, body: string, mode = 0o644) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); chmodSync(path, mode); };

function release(root: string, name: string, memory: string, stamp: string | null) {
  const rel = join(root, name);
  put(join(rel, "launch.sh"), readFileSync(join(repo, "infra/release/launch.sh"), "utf8"), 0o755);
  put(join(rel, "packages/harness/dist/bin/wolfd.js"), "// stub wolfd\n");
  if (stamp !== null) {
    put(join(rel, "extensions/wolfpack-memory/index.js"), memory);
    put(join(rel, "extensions/wolfpack-telegram/index.js"), `telegram ${memory}`);
    put(join(rel, "extensions/STAMP"), stamp + "\n");
  }
  return rel;
}

function wolfHome(root: string) {
  const home = join(root, "home");
  put(join(home, "wolf.yaml"), "identity:\n  name: hal\nextensions: [ memory ]\n");
  put(join(home, "den/extensions/wolfpack-memory/index.js"), "old memory");
  put(join(home, "den/extensions/owner-ext/index.js"), "owner");
  return home;
}

const launch = (rel: string, home: string) =>
  spawnSync("bash", [join(rel, "launch.sh")], { env: { PATH: process.env.PATH!, WOLF_HOME: home, HOME: home }, encoding: "utf8" });
const read = (p: string) => readFileSync(p, "utf8");
const backups = (home: string) => readdirSync(join(home, "den")).filter((n) => n.startsWith("extensions.bak-"));

describe("launch.sh installs the release's extension bundles into the den", () => {
  it("replaces the extensions the den already has, keeps the old dir as a backup and leaves owner extensions alone", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-ext-")); tmps.push(root);
    const home = wolfHome(root);
    const r = launch(release(root, "relB", "memory B", "B"), home);
    expect(r.status, r.stderr).toBe(0);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory B");
    expect(read(join(home, "den/extensions/owner-ext/index.js"))).toBe("owner");
    expect(existsSync(join(home, "den/extensions/wolfpack-telegram"))).toBe(false); // not in this wolf's den: not added
    const [bak] = backups(home);
    expect(backups(home)).toHaveLength(1);
    expect(read(join(home, "den", bak, "wolfpack-memory/index.js"))).toBe("old memory");
  });

  it("does nothing when the den already carries this release's stamp", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-ext-")); tmps.push(root);
    const home = wolfHome(root);
    const rel = release(root, "relB", "memory B", "B");
    launch(rel, home);
    const r = launch(rel, home);
    expect(r.status, r.stderr).toBe(0);
    expect(backups(home)).toHaveLength(1);
  });

  it("a rollback (the previous release's launch.sh) restores that release's extensions", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-ext-")); tmps.push(root);
    const home = wolfHome(root);
    launch(release(root, "relA", "memory A", "A"), home);
    launch(release(root, "relB", "memory B", "B"), home);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory B");
    launch(join(root, "relA"), home);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory A");
  });

  it("still starts wolfd on the old extensions when the install fails", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-ext-")); tmps.push(root);
    const home = wolfHome(root);
    const rel = release(root, "relB", "memory B", "B");
    chmodSync(join(home, "den"), 0o555); // wolf cannot write in its den
    try {
      const r = launch(rel, home);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("launch.sh: extensions NOT refreshed");
      expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("old memory");
    } finally { chmodSync(join(home, "den"), 0o755); }
  });

  it("a release without bundled extensions leaves the den untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "launch-ext-")); tmps.push(root);
    const home = wolfHome(root);
    const r = launch(release(root, "relOld", "", null), home);
    expect(r.status, r.stderr).toBe(0);
    expect(backups(home)).toHaveLength(0);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("old memory");
  });
});
