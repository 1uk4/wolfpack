import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KbRoots } from "../shared/index.js";
import { readSweepCurrent } from "./activity.js";
import { readCurrent, writeCurrent } from "./progress.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "progress-"));
  dirs.push(d);
  return { d, roots: { kbBase: d, opsRoot: d, denLocal: d } as KbRoots };
};

describe("writeCurrent", () => {
  it("writes atomically (temp + rename) and leaves no temp file", () => {
    const { d, roots } = mk();
    writeCurrent(roots, { from: "w", denTopicId: "t", startedAt: 1 });
    writeCurrent(roots, { from: "w", denTopicId: "t", startedAt: 1, route: "merge into kb-x" });
    expect(readCurrent(roots)).toEqual({ from: "w", denTopicId: "t", startedAt: 1, route: "merge into kb-x" });
    expect(readdirSync(d)).toEqual(["sweep-current.json"]);
  });
});

describe("readSweepCurrent keys", () => {
  it("returns from / denTopicId untouched (they are matching keys), drops odd ones", () => {
    const { d } = mk();
    const long = "t".repeat(200);
    writeFileSync(join(d, "sweep-current.json"), JSON.stringify({ from: "w  x", denTopicId: long, startedAt: 1, route: "r".repeat(500) }));
    const c = readSweepCurrent(d)!;
    expect(c.from).toBe("w  x");
    expect(c.denTopicId).toBe(long);
    expect(c.route!.length).toBeLessThanOrEqual(200);
    writeFileSync(join(d, "sweep-current.json"), JSON.stringify({ from: "w", denTopicId: "a\nb", startedAt: 1 }));
    expect(readSweepCurrent(d)).toBeUndefined();
    writeFileSync(join(d, "sweep-current.json"), JSON.stringify({ from: "w", denTopicId: "t".repeat(300), startedAt: 1 }));
    expect(readSweepCurrent(d)).toBeUndefined();
  });
});

describe("writeCurrent failure", () => {
  it("is swallowed (logged), so a progress-file problem never fails an item", () => {
    const { d } = mk();
    writeFileSync(join(d, "blocker"), "x");
    // denLocal is a path under a regular file: mkdir fails
    expect(() => writeCurrent({ kbBase: d, opsRoot: d, denLocal: join(d, "blocker", "den") } as KbRoots, { from: "w", denTopicId: "t", startedAt: 1 })).not.toThrow();
  });
});
