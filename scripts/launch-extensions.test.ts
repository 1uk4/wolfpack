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

/** A release dir. stamp = "<version> <content hash>" or null for a release that predates bundled extensions. */
function release(root: string, name: string, memory: string, stamp: string | null) {
  const rel = join(root, name);
  put(join(rel, "launch.sh"), readFileSync(join(repo, "infra/release/launch.sh"), "utf8"), 0o755);
  put(join(rel, "packages/harness/dist/bin/wolfd.js"), "// stub wolfd\n");
  if (stamp !== null) {
    put(join(rel, "extensions/wolfpack-memory/index.js"), memory);
    put(join(rel, "extensions/wolfpack-telegram/index.js"), `telegram ${memory}`);
    put(join(rel, "extensions/KEYS"), "memory wolfpack-memory\ntg wolfpack-telegram\n");
    put(join(rel, "extensions/STAMP"), stamp + "\n");
  }
  return rel;
}

function wolfHome(root: string, yaml = "identity:\n  name: hal\nextensions: [ memory ]  # trailing comment\n") {
  const home = join(root, "home");
  put(join(home, "wolf.yaml"), yaml);
  put(join(home, "den/extensions/wolfpack-memory/index.js"), "old memory");
  put(join(home, "den/extensions/owner-ext/index.js"), "owner");
  return home;
}

const launch = (rel: string, home: string, cwd?: string) =>
  spawnSync("bash", [join(rel, "launch.sh")], { env: { PATH: process.env.PATH!, WOLF_HOME: home, HOME: home }, cwd, encoding: "utf8" });
const read = (p: string) => readFileSync(p, "utf8");
const backups = (home: string) => readdirSync(join(home, "den")).filter((n) => n.startsWith("extensions.bak-") && n !== "extensions.bak-old");
const tmp = () => { const root = mkdtempSync(join(tmpdir(), "launch-ext-")); tmps.push(root); return root; };

describe("launch.sh installs the release's extension bundles into the den", () => {
  it("replaces the extensions the den already has, keeps the old dir as a backup and leaves owner extensions alone", () => {
    const root = tmp();
    const home = wolfHome(root);
    const r = launch(release(root, "relB", "memory B", "1.1 hashB"), home);
    expect(r.status, r.stderr).toBe(0);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory B");
    expect(read(join(home, "den/extensions/owner-ext/index.js"))).toBe("owner");
    expect(existsSync(join(home, "den/extensions/wolfpack-telegram"))).toBe(false); // not in this wolf's den: not added
    const [bak] = backups(home);
    expect(backups(home)).toHaveLength(1);
    expect(read(join(home, "den", bak, "wolfpack-memory/index.js"))).toBe("old memory");
  });

  it("does nothing when the den already carries this content, even from a newer release version", () => {
    const root = tmp();
    const home = wolfHome(root);
    launch(release(root, "relB", "memory B", "1.1 hashB"), home);
    const stampBefore = read(join(home, "den/extensions/.release-stamp"));
    for (const rel of [join(root, "relB"), release(root, "relB2", "memory B2", "1.2 hashB")]) {
      const r = launch(rel, home);
      expect(r.status, r.stderr).toBe(0);
    }
    expect(backups(home)).toHaveLength(1);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory B");
    expect(read(join(home, "den/extensions/.release-stamp"))).toBe(stampBefore);
  });

  it("installs a wolf.yaml key the den lacks, mapped through the release's KEYS file", () => {
    const root = tmp();
    const home = wolfHome(root, 'extensions: [memory, "tg"]   # x\n');
    const r = launch(release(root, "relB", "memory B", "1.1 hashB"), home);
    expect(r.status, r.stderr).toBe(0);
    expect(read(join(home, "den/extensions/wolfpack-telegram/index.js"))).toBe("telegram memory B");
  });

  it("reads a block-style extensions list and does not glob-expand when the den has no extension dirs", () => {
    const root = tmp();
    const home = wolfHome(root, "extensions:\n  - tg  # x\n  - memory\nother: 1\n");
    rmSync(join(home, "den/extensions"), { recursive: true });
    put(join(home, "den/extensions/.keep"), "");
    put(join(home, "wolfpack-decoy/index.js"), "decoy"); // a cwd entry a literal `*` would pick up
    const rel = release(root, "relB", "memory B", "1.1 hashB");
    const r = launch(rel, home, home);
    expect(r.status, r.stderr).toBe(0);
    expect(read(join(home, "den/extensions/wolfpack-telegram/index.js"))).toBe("telegram memory B");
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory B");
    expect(readdirSync(join(home, "den/extensions")).sort()).toEqual([".keep", ".release-stamp", "wolfpack-memory", "wolfpack-telegram"]);
  });

  it("restores the newest backup after a crash left den/extensions missing, and keeps only the newest 3 backups in den/", () => {
    const root = tmp();
    const home = wolfHome(root);
    for (let i = 1; i <= 5; i++) launch(release(root, "rel" + i, "memory " + i, `1.${i} hash${i}`), home);
    expect(backups(home)).toHaveLength(3);
    expect(readdirSync(join(home, "den/extensions.bak-old"))).toHaveLength(2);
    rmSync(join(home, "den/extensions"), { recursive: true }); // crash between the two moves
    const r = launch(release(root, "rel6", "memory 6", "1.6 hash4"), home); // hash4 = the newest backup's content
    expect(r.status, r.stderr).toBe(0);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory 4"); // the newest backup came back; its hash is current, so no refresh
  });

  it("a rollback (the previous release's launch.sh) restores that release's extensions", () => {
    const root = tmp();
    const home = wolfHome(root);
    launch(release(root, "relA", "memory A", "1.0 hashA"), home);
    launch(release(root, "relB", "memory B", "1.1 hashB"), home);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory B");
    launch(join(root, "relA"), home);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("memory A");
  });

  it.skipIf(process.getuid?.() === 0)("still starts wolfd on the old extensions when the install fails", () => {
    const root = tmp();
    const home = wolfHome(root);
    const rel = release(root, "relB", "memory B", "1.1 hashB");
    chmodSync(join(home, "den"), 0o555); // wolf cannot write in its den (root ignores this, hence the skip)
    try {
      const r = launch(rel, home);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("launch.sh: extensions NOT refreshed");
      expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("old memory");
    } finally { chmodSync(join(home, "den"), 0o755); }
  });

  it("a release without bundled extensions leaves the den untouched", () => {
    const root = tmp();
    const home = wolfHome(root);
    const r = launch(release(root, "relOld", "", null), home);
    expect(r.status, r.stderr).toBe(0);
    expect(backups(home)).toHaveLength(0);
    expect(read(join(home, "den/extensions/wolfpack-memory/index.js"))).toBe("old memory");
  });
});
