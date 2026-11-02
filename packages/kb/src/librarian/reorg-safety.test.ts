/**
 * Rebuild safety: the KB write lock and per-domain section saves.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KbRoots } from "../shared/index.js";
import { withKbLock, KbLockBusy, kbLockFile } from "./lock.js";
import { persistDomains } from "./reorg.js";
import { readSections, writeSections } from "./sections.js";
import { sweep } from "./sweep.js";

let base: string;
let roots: KbRoots;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "kb-safety-"));
  roots = { kbBase: join(base, "base"), opsRoot: join(base, "ops"), denLocal: join(base, "den") };
  mkdirSync(roots.denLocal, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const sec = (id: string, domain: string, parent: string | null, memberCount: number, centroid: number[], depth = 0): any => ({
  id, domain, parent, depth, label: id, title: id, centroid, memberCount,
  childIds: [], summary: "", summaryHash: "", dirty: false, memberCountAtLastLabel: 0,
  created: "2026-10-19", updated: "2026-10-19",
});

describe("withKbLock", () => {
  it("runs parallel callers in this process one after another", async () => {
    const order: string[] = [];
    const job = (name: string) =>
      withKbLock(roots, async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 50));
        order.push(`${name}:end`);
      }, { waitMs: 5000 });
    await Promise.all([job("a"), job("b")]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(existsSync(kbLockFile(roots))).toBe(false);
  });

  it("throws KbLockBusy when it may not wait", async () => {
    let busy: unknown;
    await withKbLock(roots, async () => {
      busy = await withKbLock(roots, async () => "ran").catch((e) => e);
    });
    expect(busy).toBeInstanceOf(KbLockBusy);
  });

  it("an outer holder in this process (the CLI) lets a nested call through and keeps the file", async () => {
    writeFileSync(kbLockFile(roots), JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(await withKbLock(roots, async () => "ran")).toBe("ran");
    expect(existsSync(kbLockFile(roots))).toBe(true);
  });

  it("treats a lock held by another user's live process as busy, not stale", async () => {
    // pid 1 is alive and owned by root, so signalling it gives EPERM.
    writeFileSync(kbLockFile(roots), JSON.stringify({ pid: 1, at: Date.now() }));
    await expect(withKbLock(roots, async () => "ran")).rejects.toBeInstanceOf(KbLockBusy);
    expect(JSON.parse(readFileSync(kbLockFile(roots), "utf8")).pid).toBe(1);
  });

  it("reclaims a lock whose owner is gone", async () => {
    writeFileSync(kbLockFile(roots), JSON.stringify({ pid: 999_999_99, at: Date.now() }));
    expect(await withKbLock(roots, async () => "ran")).toBe("ran");
  });

  it("a sweep that finds the KB busy skips this run", async () => {
    const notes: string[] = [];
    const r = await withKbLock(roots, () =>
      sweep({ engine: {} as any, roots, loadEntryVectors: async () => [], notify: (m: string) => notes.push(m) } as any)
    );
    expect(r.processed).toBe(0);
    expect(notes.join("\n")).toContain("skipped, the KB is busy");
  });
});

describe("persistDomains", () => {
  it("replaces only the domains it worked on", () => {
    mkdirSync(join(roots.kbBase, "domains", "x", "entries"), { recursive: true });
    writeSections(roots, [sec("sec-x-aaaaaa", "x", null, 1, [1, 0]), sec("sec-y-new111", "y", null, 2, [0, 1])]);
    // A rebuild of x that loaded y's tree before y was rebuilt.
    const inMemory = [sec("sec-x-bbbbbb", "x", null, 3, [1, 0]), sec("sec-y-old999", "y", null, 9, [0, 1])];
    persistDomains(roots, inMemory, ["x"]);
    expect(readSections(roots).map((s) => s.id).sort()).toEqual(["sec-x-bbbbbb", "sec-y-new111"]);
  });
});
