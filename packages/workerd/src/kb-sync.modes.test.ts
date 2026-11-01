import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KbSync } from "./kb-sync.js";
import { saveHubConfig } from "./hub-config.js";

const hashOf = (t: string) => "sha256:" + createHash("sha256").update(t, "utf-8").digest("hex");
const FILES = ["entries/kb-p-aaaaaaa.md", "versions/kb-p-aaaaaaa/2026-01-01.md", "_registry.md", "_digest.json", "INDEX.md"];
const dirs: string[] = [];
let oldUmask = 0;
beforeEach(() => {
  oldUmask = process.umask(0o077);
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
const mode = (p: string) => statSync(p).mode & 0o777;

/** A fake hub: every manifest-diff returns the whole file set, nothing pending. */
const fakeFetch = (async () =>
  new Response(JSON.stringify({ domain: "personal", epoch: "e1", revision: 1, files: FILES.map((path) => ({ path, contentHash: hashOf(path), encoding: "utf8", content: path })), deletes: [], pending: [] }), { status: 200 })) as unknown as typeof fetch;

async function syncInto(mirrorDir: string, groupRead?: boolean): Promise<void> {
  const s = new KbSync({ hubUrl: "http://hub.invalid", token: "t", mirrorDir, layout: "base", groupRead, fetchImpl: fakeFetch, pollMs: 0, baseMs: 10, capMs: 20 });
  s.start();
  s.setGranted(["personal"]);
  await s.idle();
  for (let i = 0; i < 100 && !s.status().personal?.rev; i++) await new Promise((r) => setTimeout(r, 20));
  s.stop();
}

describe("kb mirror modes under umask 077", () => {
  it("groupRead on: files 0640, content dirs 0750, state and root untouched, hub.json 0600", async () => {
    const root = join(tmp(), "mirror");
    mkdirSync(root, { mode: 0o700 });
    const dom = join(root, "domains", "personal");
    await syncInto(root, true);
    for (const f of FILES) expect(mode(join(dom, f))).toBe(0o640);
    for (const d of [join(root, "domains"), dom, join(dom, "entries"), join(dom, "versions"), join(dom, "versions", "kb-p-aaaaaaa")]) expect(mode(d)).toBe(0o750);
    expect(mode(join(root, ".sync", "personal.json"))).toBe(0o600);
    expect(mode(join(root, ".sync"))).toBe(0o700);
    expect(mode(root)).toBe(0o700);
    const cfg = tmp();
    saveHubConfig({ hubUrl: "http://h", token: "secret", hostId: "x" } as never, cfg);
    expect(mode(join(cfg, "hub.json"))).toBe(0o600);
  });

  it("groupRead off: modes are the umask's, as before", async () => {
    const root = join(tmp(), "mirror");
    const dom = join(root, "domains", "personal");
    await syncInto(root);
    for (const f of FILES) expect(mode(join(dom, f))).toBe(0o600);
    expect(mode(join(dom, "entries"))).toBe(0o700);
    expect(mode(join(root, ".sync", "personal.json"))).toBe(0o600);
  });

  it("start fixes the modes of existing mirror files once, but not .sync", () => {
    const root = join(tmp(), "mirror");
    const dom = join(root, "domains", "personal");
    mkdirSync(join(dom, "entries"), { recursive: true });
    mkdirSync(join(root, ".sync"), { recursive: true });
    writeFileSync(join(dom, "entries", "kb-p-aaaaaaa.md"), "x", { mode: 0o600 });
    writeFileSync(join(root, ".sync", "personal.json"), "{}", { mode: 0o600 });
    chmodSync(join(root, ".sync"), 0o700);
    const s = new KbSync({ hubUrl: "http://hub.invalid", token: "t", mirrorDir: root, layout: "base", groupRead: true, fetchImpl: fakeFetch, pollMs: 0 });
    s.start();
    s.stop();
    expect(mode(join(dom, "entries", "kb-p-aaaaaaa.md"))).toBe(0o640);
    expect(mode(join(dom, "entries"))).toBe(0o750);
    expect(mode(join(root, ".sync", "personal.json"))).toBe(0o600);
    expect(mode(join(root, ".sync"))).toBe(0o700);
  });
});
