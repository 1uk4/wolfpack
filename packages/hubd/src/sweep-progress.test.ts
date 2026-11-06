import { mkdtempSync, readdirSync, renameSync, utimesSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanStaleCurrentTmp, watchSweepProgress } from "./sweep-progress.js";

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const until = async (f: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "sweepprog-"));
  dirs.push(d);
  // the sweep writes temp + rename (progress.ts writeCurrent); do the same here
  const writeCurrent = (_roots: unknown, item: object) => {
    writeFileSync(join(d, "c.tmp"), JSON.stringify(item));
    renameSync(join(d, "c.tmp"), join(d, "sweep-current.json"));
  };
  return { d, roots: {}, writeCurrent };
};

describe("watchSweepProgress", () => {
  it("reports an item starting and then its route, once each", async () => {
    const { d, roots, writeCurrent } = mk();
    const seen: Array<string | undefined> = [];
    stops.push(watchSweepProgress(d, (c) => seen.push(c.route ?? "-")));
    writeCurrent(roots, { from: "w", denTopicId: "t", startedAt: Date.now() });
    await until(() => seen.length === 1);
    writeCurrent(roots, { from: "w", denTopicId: "t", startedAt: Date.now(), route: "merge into kb-x" });
    await until(() => seen.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual(["-", "merge into kb-x"]);
  });
  it("ignores a stale file from before `since`, and a malformed one", async () => {
    const { d } = mk();
    const seen: string[] = [];
    writeFileSync(join(d, "sweep-current.json"), JSON.stringify({ from: "w", denTopicId: "old", startedAt: 1 }));
    stops.push(watchSweepProgress(d, (c) => seen.push(c.denTopicId), 1000));
    writeFileSync(join(d, "sweep-current.json"), "{oops");
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([]);
  });
  it("stops after close", async () => {
    const { d, roots, writeCurrent } = mk();
    const seen: string[] = [];
    const stop = watchSweepProgress(d, (c) => seen.push(c.denTopicId));
    stop();
    writeCurrent(roots, { from: "w", denTopicId: "t", startedAt: 5 });
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([]);
  });
  it("cleanStaleCurrentTmp removes an old dead-pid temp file; keeps young, live-pid and unrelated files", () => {
    const { d } = mk();
    const old = join(d, "sweep-current.json.999999999.tmp");
    const young = join(d, "sweep-current.json.999999998.tmp");
    const mine = join(d, `sweep-current.json.${process.pid}.tmp`);
    for (const f of [old, young, mine, join(d, "other.tmp")]) writeFileSync(f, "x");
    const past = new Date(Date.now() - 60_000);
    utimesSync(old, past, past);
    utimesSync(mine, past, past);
    cleanStaleCurrentTmp(d);
    expect(readdirSync(d).sort()).toEqual(["other.tmp", "sweep-current.json.999999998.tmp", `sweep-current.json.${process.pid}.tmp`].sort());
  });
});
