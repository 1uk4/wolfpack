import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, fchownSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every mode ever passed to chmod/fchmod, so the tests can prove no setgid/setuid/sticky bit is ever requested. */
const chmodModes = vi.hoisted(() => [] as number[]);
const failChmod = vi.hoisted(() => ({ on: false }));
const eperm = () => Object.assign(new Error("EPERM: operation not permitted (simulated seccomp)"), { code: "EPERM" });
vi.mock("node:fs", async (orig) => {
  const m = await orig<typeof import("node:fs")>();
  return {
    ...m,
    chmodSync: (p: string, mode: number) => (chmodModes.push(Number(mode)), failChmod.on ? (() => { throw eperm(); })() : m.chmodSync(p, mode)),
    fchmodSync: (fd: number, mode: number) => (chmodModes.push(Number(mode)), failChmod.on ? (() => { throw eperm(); })() : m.fchmodSync(fd, mode)),
  };
});

import { KbSync } from "./kb-sync.js";
import { envKbMirror, groupReadConflict } from "./run.js";

const hashOf = (t: string) => "sha256:" + createHash("sha256").update(t, "utf-8").digest("hex");
const FILES = ["entries/kb-p-aaaaaaa.md", "versions/kb-p-aaaaaaa/2026-01-01.md", "_registry.md", "_digest.json", "INDEX.md"];
const dirs: string[] = [];
let oldUmask = 0;
beforeEach(() => {
  oldUmask = process.umask(0o077);
  chmodModes.length = 0;
  failChmod.on = false;
});
afterEach(() => {
  process.umask(oldUmask);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "kbmodes-"));
  dirs.push(d);
  return d;
};
const mode = (p: string) => statSync(p).mode & 0o7777;
const gidOf = (p: string) => statSync(p).gid;
/** A group the test user belongs to other than its primary one, if any. */
const otherGroup = (): number | undefined => (process.getgroups?.() ?? []).find((g) => g !== process.getegid?.());

/** A fake hub: every manifest-diff returns the whole file set, nothing pending. */
const fakeFetch = (async () =>
  new Response(JSON.stringify({ domain: "personal", epoch: "e1", revision: 1, files: FILES.map((path) => ({ path, contentHash: hashOf(path), encoding: "utf8", content: path })), deletes: [], pending: [] }), { status: 200 })) as unknown as typeof fetch;

const mk = (mirrorDir: string, groupRead?: boolean, log?: (m: string) => void) =>
  new KbSync({ hubUrl: "http://hub.invalid", token: "t", mirrorDir, layout: "base", groupRead, fetchImpl: fakeFetch, pollMs: 0, baseMs: 10, capMs: 20, log });
async function syncInto(mirrorDir: string, groupRead?: boolean, log?: (m: string) => void): Promise<void> {
  const s = mk(mirrorDir, groupRead, log);
  s.start();
  s.setGranted(["personal"]);
  await s.idle();
  for (let i = 0; i < 100 && !s.status().personal?.rev; i++) await new Promise((r) => setTimeout(r, 20));
  s.stop();
}
const everyDirAndFile = (dom: string): string[] => [dom, join(dom, "entries"), join(dom, "versions"), join(dom, "versions", "kb-p-aaaaaaa"), ...FILES.map((f) => join(dom, f))];

describe("kb mirror modes under umask 077", () => {
  it("groupRead on: files 0640, dirs 0750, root's gid, no special bit ever requested; .sync and root untouched; nothing in configDir", async () => {
    const root = join(tmp(), "mirror");
    const cfg = tmp();
    mkdirSync(root, { mode: 0o700 });
    const g = otherGroup();
    if (g !== undefined) { const fd = openSync(root, "r"); fchownSync(fd, -1, g); }
    const dom = join(root, "domains", "personal");
    await syncInto(root, true);
    for (const f of FILES) expect(mode(join(dom, f))).toBe(0o640);
    for (const d of [join(root, "domains"), dom, join(dom, "entries"), join(dom, "versions"), join(dom, "versions", "kb-p-aaaaaaa")]) expect(mode(d)).toBe(0o750);
    for (const p of [join(root, "domains"), ...everyDirAndFile(dom)]) expect(gidOf(p)).toBe(gidOf(root));
    expect(chmodModes.length).toBeGreaterThan(0);
    for (const m of chmodModes) expect(m & 0o7000).toBe(0);
    expect(mode(join(root, ".sync", "personal.json"))).toBe(0o600);
    expect(mode(join(root, ".sync"))).toBe(0o700);
    expect(mode(root)).toBe(0o700);
    expect(readdirSync(cfg)).toEqual([]);
  });

  it("groupRead off: modes are the umask's, as before, and nothing is chmodded", async () => {
    const root = join(tmp(), "mirror");
    const dom = join(root, "domains", "personal");
    await syncInto(root);
    for (const f of FILES) expect(mode(join(dom, f))).toBe(0o600);
    expect(mode(join(dom, "entries"))).toBe(0o700);
    expect(mode(join(root, ".sync", "personal.json"))).toBe(0o600);
    expect(chmodModes).toEqual([]);
  });

  it("recreated dirs after the domain folder vanished (reset/diff path) get 0750 + the root's gid", async () => {
    const root = join(tmp(), "mirror");
    mkdirSync(root, { mode: 0o700 });
    await syncInto(root, true);
    const dom = join(root, "domains", "personal");
    rmSync(dom, { recursive: true });
    await syncInto(root, true);
    for (const d of [dom, join(dom, "entries"), join(dom, "versions", "kb-p-aaaaaaa")]) {
      expect(mode(d)).toBe(0o750);
      expect(gidOf(d)).toBe(gidOf(root));
    }
    expect(mode(join(dom, "INDEX.md"))).toBe(0o640);
  });

  it("start fixes existing domain content at every start; skips .sync, stray root entries and symlinks (targets untouched)", () => {
    const base = tmp();
    const root = join(base, "mirror");
    const outside = join(base, "outside");
    const dom = join(root, "domains", "personal");
    mkdirSync(join(dom, "entries"), { recursive: true });
    mkdirSync(join(root, ".sync"), { recursive: true });
    mkdirSync(join(root, "stray"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "s", { mode: 0o600 });
    writeFileSync(join(dom, "entries", "kb-p-aaaaaaa.md"), "x", { mode: 0o600 });
    writeFileSync(join(dom, "INDEX.md"), "x", { mode: 0o600 });
    writeFileSync(join(root, ".sync", "personal.json"), "{}", { mode: 0o600 });
    writeFileSync(join(root, "hub.json"), "{}", { mode: 0o600 });
    writeFileSync(join(root, "stray", "f.md"), "x", { mode: 0o600 });
    symlinkSync(outside, join(dom, "versions")); // a symlinked dir in place of versions/
    symlinkSync(join(outside, "secret.md"), join(dom, "entries", "kb-link.md")); // a symlinked file
    chmodSync(outside, 0o700);
    chmodSync(join(root, ".sync"), 0o700);
    chmodSync(join(root, "stray"), 0o700);
    const log: string[] = [];
    const s = mk(root, true, (m) => log.push(m));
    s.start();
    s.stop();
    expect(mode(join(dom, "entries", "kb-p-aaaaaaa.md"))).toBe(0o640);
    expect(mode(join(dom, "INDEX.md"))).toBe(0o640);
    expect(mode(join(dom, "entries"))).toBe(0o750);
    expect(mode(join(dom, ".."))).toBe(0o750);
    expect(mode(join(root, ".sync", "personal.json"))).toBe(0o600);
    expect(mode(join(root, ".sync"))).toBe(0o700);
    expect(mode(join(root, "hub.json"))).toBe(0o600);
    expect(mode(join(root, "stray"))).toBe(0o700);
    expect(mode(join(root, "stray", "f.md"))).toBe(0o600);
    expect(mode(outside)).toBe(0o700);
    expect(mode(join(outside, "secret.md"))).toBe(0o600);
    expect(log.filter((l) => l.includes("WARNING")).length).toBeLessThanOrEqual(1);
    // a second start (restart) fixes files that drifted since
    writeFileSync(join(dom, "INDEX.md"), "y", { mode: 0o600 });
    chmodSync(join(dom, "INDEX.md"), 0o600);
    const s2 = mk(root, true);
    s2.start();
    s2.stop();
    expect(mode(join(dom, "INDEX.md"))).toBe(0o640);
    for (const m of chmodModes) expect(m & 0o7000).toBe(0);
  });

  it("a chmod failure (e.g. seccomp EPERM) is logged once and fails the write: never silently left unreadable", async () => {
    const root = join(tmp(), "mirror");
    mkdirSync(root, { mode: 0o700 });
    const log: string[] = [];
    failChmod.on = true;
    const s = mk(root, true, (m) => log.push(m));
    s.start();
    s.setGranted(["personal"]);
    await new Promise((r) => setTimeout(r, 300));
    s.stop();
    expect(s.status().personal?.lastError).toMatch(/group-read|EPERM/);
    expect(s.status().personal?.rev).toBe(0);
    const warns = log.filter((l) => l.includes("WARNING group-read"));
    expect(warns.length).toBeGreaterThan(0);
    expect(new Set(warns).size).toBe(warns.length); // each distinct message once
  });
});

describe("run.ts env + guard", () => {
  it("envKbMirror: dir trimmed/empty=unset; group-read only for exactly 1", () => {
    expect(envKbMirror({})).toEqual({ dir: undefined, groupRead: false });
    expect(envKbMirror({ WORKERD_KB_MIRROR_DIR: " /var/lib/workerd-kb ", WORKERD_KB_MIRROR_GROUP_READ: "1" })).toEqual({ dir: "/var/lib/workerd-kb", groupRead: true });
    expect(envKbMirror({ WORKERD_KB_MIRROR_DIR: "  " }).dir).toBeUndefined();
    for (const v of ["true", "yes", "on", "0", "", "2"]) expect(envKbMirror({ WORKERD_KB_MIRROR_GROUP_READ: v }).groupRead).toBe(false);
  });

  it("groupReadConflict: refuses equal/inside/containing config dir or outbox, and hub.json/outbox inside the mirror; allows a sibling", () => {
    const b = tmp();
    const cfg = join(b, "workerd");
    mkdirSync(cfg);
    const ob = join(cfg, "outbox");
    expect(groupReadConflict(cfg, cfg, ob)).toBeTruthy();
    expect(groupReadConflict(join(cfg, "kb-mirror"), cfg, ob)).toBeTruthy();
    expect(groupReadConflict(b, cfg, ob)).toBeTruthy();
    expect(groupReadConflict(ob, cfg, ob)).toBeTruthy();
    const sib = join(b, "workerd-kb");
    mkdirSync(sib);
    expect(groupReadConflict(sib, cfg, ob)).toBeUndefined();
    writeFileSync(join(sib, "hub.json"), "{}");
    expect(groupReadConflict(sib, cfg, ob)).toMatch(/hub\.json/);
    rmSync(join(sib, "hub.json"));
    mkdirSync(join(sib, "outbox"));
    expect(groupReadConflict(sib, cfg, ob)).toMatch(/outbox/);
  });
});
