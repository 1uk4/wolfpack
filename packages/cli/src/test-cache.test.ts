import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey, openCache } from "./test-cache.js";

let repo: string;
let store: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
const base = { args: ["run", "a.test.ts"], vitestVersion: "3.2.7", nodeVersion: "v22.1.0", env: {} as NodeJS.ProcessEnv };
let cfg: string;
const key = (o: Partial<Parameters<typeof cacheKey>[0]> = {}) => cacheKey({ root: repo, configDir: cfg, ...base, ...o });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "test-cache-repo-"));
  store = mkdtempSync(join(tmpdir(), "test-cache-store-"));
  cfg = mkdtempSync(join(tmpdir(), "test-cache-home-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
});

describe("test cache key", () => {
  it("is the same for the same state and changes with each input that matters", () => {
    const k = key();
    expect(key()).toBe(k);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    // args, node version, vitest version, allow-listed env
    expect(key({ args: ["run", "b.test.ts"] })).not.toBe(k);
    expect(key({ nodeVersion: "v24.0.0" })).not.toBe(k);
    expect(key({ vitestVersion: "3.2.8" })).not.toBe(k);
    expect(key({ env: { TZ: "Asia/Tokyo" } })).not.toBe(k);
    // not allow-listed: ignored
    expect(key({ env: { SOME_TOKEN: "x", PATH: "/bin" } })).toBe(k);
    // who runs it (owner or agent) must not matter: they share passes
    expect(key({ env: { WOLFPACK_AGENT_RUN: "1", WOLFPACK_TEST_BYPASS: "1", PI_SUBAGENT_AGENT: "worker" } })).toBe(k);
  });

  it("changes when a tracked, dirty or untracked file changes, but not for an ignored file", () => {
    const k = key();
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    const dirty = key();
    expect(dirty).not.toBe(k);
    writeFileSync(join(repo, "new.ts"), "x\n");
    const untracked = key();
    expect(untracked).not.toBe(dirty);
    writeFileSync(join(repo, "new.ts"), "y\n");
    expect(key()).not.toBe(untracked);
    writeFileSync(join(repo, "ignored.txt"), "z\n");
    expect(key()).toBe(key());
    const before = key();
    writeFileSync(join(repo, "ignored.txt"), "zz\n");
    expect(key()).toBe(before);
    // committing the same content as a new state is a different tree
    git("add", ".");
    git("commit", "-q", "-m", "more");
    expect(key()).not.toBe(before);
  });

  it("changes with the lockfile, and a related run does not depend on the order of its files", () => {
    const k = key({ args: ["related", "a.ts", "b.ts"] });
    expect(key({ args: ["related", "b.ts", "a.ts"] })).toBe(k);
    writeFileSync(join(repo, "package-lock.json"), '{"x":1}\n');
    expect(key({ args: ["related", "a.ts", "b.ts"] })).not.toBe(k);
  });
});

describe("test cache key and built output", () => {
  // Tests import @wolfpack/* through node_modules -> package main -> dist/ (no vitest alias), and dist/ is gitignored:
  // the built output is an input of the result and part of the key.
  it("changes when a package's built output changes, not when something under its node_modules does", () => {
    mkdirSync(join(repo, "packages", "p", "dist"), { recursive: true });
    mkdirSync(join(repo, "packages", "p", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\ndist/\nnode_modules/\n");
    writeFileSync(join(repo, "packages", "p", "dist", "index.js"), "export const v = 1;\n");
    const k = key();
    writeFileSync(join(repo, "packages", "p", "node_modules", "dep", "x.js"), "1\n");
    expect(key()).toBe(k);
    writeFileSync(join(repo, "packages", "p", "dist", "index.js"), "export const v = 2;\n");
    expect(key()).not.toBe(k);
  });
});

describe("test cache key and the home config", () => {
  // Blind spot, kept on purpose: only the config files named in HOME_CONFIG_FILES are in the key. A test that reads some
  // other file under the home directory is not covered by it (such tests belong in HOME_CONFIG_TESTS).
  it("changes when a config file under the home config dir changes, not for run state or logs", () => {
    writeFileSync(join(cfg, "config.yaml"), "models: {}\n");
    const k = key();
    writeFileSync(join(cfg, "config.yaml"), "models: { main: x }\n");
    const edited = key();
    expect(edited).not.toBe(k);
    writeFileSync(join(cfg, "domains.yaml"), "a: 1\n");
    expect(key()).not.toBe(edited);
    const withDomains = key();
    mkdirSync(join(cfg, "run"), { recursive: true });
    writeFileSync(join(cfg, "run", "x.sock"), "1");
    writeFileSync(join(cfg, "workerd.log"), "line\n");
    expect(key()).toBe(withDomains);
  });
});

describe("test cache key and installed code outside git", () => {
  const ignore = () => writeFileSync(join(repo, ".gitignore"), "ignored.txt\ndist/\nnode_modules/\n");

  it("covers every built file except type declarations and source maps", () => {
    ignore();
    mkdirSync(join(repo, "packages", "p", "dist"), { recursive: true });
    const d = (f: string, c: string) => writeFileSync(join(repo, "packages", "p", "dist", f), c);
    d("index.js", "1");
    const k = key();
    d("index.d.ts", "types");
    d("index.js.map", "map");
    expect(key()).toBe(k);
    d("data.node", "binary-ish");
    const withNode = key();
    expect(withNode).not.toBe(k);
    d("styles.css", "a{}");
    expect(key()).not.toBe(withNode);
  });

  it("follows symlinks in dist (hashing the target), and survives a symlink cycle", () => {
    ignore();
    const dist = join(repo, "packages", "p", "dist");
    mkdirSync(dist, { recursive: true });
    const target = join(store, "elsewhere.js"); // outside the repo: git cannot see it
    writeFileSync(target, "one");
    symlinkSync(target, join(dist, "linked.js"));
    symlinkSync(dist, join(dist, "loop"));
    const k = key();
    writeFileSync(target, "two");
    expect(key()).not.toBe(k);
  });

  it("changes when the Mac-only pi-claude-bridge-stateless install changes, even though the lockfile did not", () => {
    ignore();
    const pkg = join(repo, "node_modules", "pi-claude-bridge-stateless");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"pi-claude-bridge","version":"0.9.3"}');
    writeFileSync(join(pkg, "dist", "index.js"), "a");
    const k = key();
    writeFileSync(join(pkg, "dist", "index.js"), "b");
    const edited = key();
    expect(edited).not.toBe(k);
    writeFileSync(join(pkg, "package.json"), '{"name":"pi-claude-bridge","version":"0.9.4"}');
    expect(key()).not.toBe(edited);
  });
});

describe("test cache store", () => {
  const T0 = 1_700_000_000_000;
  const open = (now = T0, extra: { maxEntries?: number } = {}) => openCache({ dir: store, now: () => now, ...extra });

  it("remembers a pass with its time and forgets nothing it was not given", () => {
    const c = open();
    expect(c.lookup("k1")).toBeUndefined();
    expect(c.store("k1", { status: "pass", files: ["packages/cli/src/x.test.ts"], args: ["run"] })).toBe(true);
    expect(c.lookup("k1")).toEqual({ at: T0 });
    expect(readdirSync(store)).toEqual(["k1.json"]); // written whole (temp file + rename): no leftovers
    expect(c.lookup("k2")).toBeUndefined();
  });

  it("refuses to store a failure", () => {
    const c = open();
    expect(c.store("k1", { status: "fail", files: ["x.test.ts"], args: ["run"] })).toBe(false);
    expect(c.lookup("k1")).toBeUndefined();
    expect(readdirSync(store)).toEqual([]);
  });

  it("never stores a run that includes a test that reads the home config", () => {
    const c = open();
    expect(c.store("k1", { status: "pass", files: ["packages/cli/src/x.test.ts", "extensions/wolfpack-memory/unbind-on-complete.test.ts"], args: ["run"] })).toBe(false);
    expect(c.lookup("k1")).toBeUndefined();
  });

  it("drops entries older than 14 days and keeps no more than the newest 200", () => {
    const old = open(T0);
    old.store("old", { status: "pass", files: ["a.test.ts"], args: [] });
    const later = open(T0 + 15 * 86_400_000);
    expect(later.lookup("old")).toBeUndefined();

    for (let i = 0; i < 5; i++) open(T0 + i * 1000, { maxEntries: 3 }).store(`e${i}`, { status: "pass", files: ["a.test.ts"], args: [] });
    expect(readdirSync(store).sort()).toEqual(["e2.json", "e3.json", "e4.json"]);
  });
});
