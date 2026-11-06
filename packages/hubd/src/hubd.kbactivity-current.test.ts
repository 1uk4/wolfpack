/** sweep.current in GET /v1/kb/activity: read from <denLocal>/sweep-current.json, fail-soft, no symlinks. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KbActivityResponseSchema } from "@wolfpack/protocol";
import { hubRoots } from "./layout.js";
import { createKbActivity } from "./kb-activity.js";
import type { Curator } from "./curator.js";

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

function setup(running = true) {
  const dir = mkdtempSync(join(tmpdir(), "hubd-kbcurrent-"));
  tmp.push(dir);
  const roots = hubRoots(dir);
  mkdirSync(roots.denLocal, { recursive: true });
  const curator = { status: () => ({ enabled: true, running }) } as unknown as Curator;
  const act = createKbActivity({ roots, inboxRoot: join(roots.opsRoot, "contributions"), receiptsRoot: join(roots.opsRoot, "receipts"), curator });
  const file = join(roots.denLocal, "sweep-current.json");
  const sweep = () => KbActivityResponseSchema.parse(act.read({})).sweep;
  return { roots, file, sweep };
}

describe("sweep.current", () => {
  it("is present while an item is in progress", () => {
    const s = setup();
    writeFileSync(s.file, JSON.stringify({ from: "1uk4", denTopicId: "t1", startedAt: 1793922503645, route: "merge into kb-wolfpack-X (9391 chars)" }));
    expect(s.sweep()).toEqual({ running: true, current: { from: "1uk4", denTopicId: "t1", startedAt: 1793922503645, route: "merge into kb-wolfpack-X (9391 chars)" } });
  });
  it("route is optional", () => {
    const s = setup();
    writeFileSync(s.file, JSON.stringify({ from: "w", denTopicId: "t", startedAt: 5 }));
    expect(s.sweep()?.current).toEqual({ from: "w", denTopicId: "t", startedAt: 5 });
  });
  it("is absent without a file, when idle, or when malformed", () => {
    const s = setup();
    expect(s.sweep()).toEqual({ running: true });
    writeFileSync(s.file, "{not json");
    expect(s.sweep()).toEqual({ running: true });
    writeFileSync(s.file, JSON.stringify({ from: 1, denTopicId: "t", startedAt: "x" }));
    expect(s.sweep()).toEqual({ running: true });
    const idle = setup(false);
    writeFileSync(idle.file, JSON.stringify({ from: "w", denTopicId: "t", startedAt: 5 }));
    expect(idle.sweep()).toEqual({ running: false });
  });
  it("refuses a symlinked file", () => {
    const s = setup();
    const target = join(s.roots.denLocal, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ from: "w", denTopicId: "t", startedAt: 5 }));
    symlinkSync(target, s.file);
    expect(s.sweep()).toEqual({ running: true });
  });
});
