import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMemoryTree, readMemoryNode, resetWorkLookupCache } from "./memory-read.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const work = { endpoint: "http://x", token: "t" };
const ITEMS: Record<string, object> = {
  "work-d-FEAT": { id: "work-d-FEAT", title: "Feature", kind: "feature", stage: "build" },
  "work-d-TASK": { id: "work-d-TASK", title: "Task", kind: "task", stage: "plan", partOf: "work-d-FEAT" },
  "work-d-KID": { id: "work-d-KID", title: "Kid", kind: "task", stage: "plan", partOf: "work-d-FEAT" },
};
let den: string;
const jl = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
const obs = (content: string, tags: object = {}) => ({ timestamp: "t", recordedAt: "2026-11-09T10:00:00Z", content, ...tags });
const arch = (content: string, at: string, tags: object = {}) => ({ id: content, timestamp: "t", recordedAt: at, content, outcome: "written", target: "work-d-TASK", at, ...tags });

beforeEach(() => {
  resetWorkLookupCache();
  den = mkdtempSync(join(tmpdir(), "tree-"));
  mkdirSync(join(den, ".memory", "pool"), { recursive: true });
  vi.stubGlobal("fetch", async (url: string) => {
    const id = decodeURIComponent(String(url).split("/work/")[1]!);
    const item = ITEMS[id];
    return item ? { ok: true, status: 200, json: async () => ({ item, body: "" }) } : { ok: false, status: 404 };
  });
});
afterEach(() => vi.unstubAllGlobals());
const pool = (xs: object[]) => writeFileSync(join(den, ".memory", "pool", "observations.jsonl"), jl(xs));
const archive = (xs: object[], file = "archive.jsonl") => writeFileSync(join(den, ".memory", "pool", file), jl(xs));

describe("readMemoryTree", () => {
  it("nests tasks under features, counts feature-only as own, untagged as den, unknown items as other", async () => {
    pool([
      obs("a", { work: "work-d-TASK", feature: "work-d-FEAT" }),
      obs("b", { work: "work-d-KID" }),
      obs("c", { feature: "work-d-FEAT" }),
      obs("d", { work: "work-d-FEAT", feature: "work-d-FEAT" }),
      obs("e"),
      obs("f", { work: "work-d-GONE" }),
    ]);
    const t = await readMemoryTree(den, work, NOW);
    expect(t.den).toEqual({ pending: 1 });
    expect(t.other).toEqual([{ id: "work-d-GONE", pending: 1, archived: 0 }]);
    expect(t.features).toEqual([{
      id: "work-d-FEAT", title: "Feature", stage: "build", own: { pending: 2, archived: 0 },
      tasks: [
        { id: "work-d-TASK", title: "Task", stage: "plan", pending: 1, archived: 0 },
        { id: "work-d-KID", title: "Kid", stage: "plan", pending: 1, archived: 0 },
      ],
    }]);
  });

  it("counts archived lines inside the 7-day window only, across rotated files", async () => {
    pool([obs("a", { work: "work-d-TASK", feature: "work-d-FEAT" })]);
    archive([arch("old", "2026-11-01T00:00:00Z", { work: "work-d-TASK", feature: "work-d-FEAT" })]);
    archive([arch("in1", "2026-11-05T00:00:00Z", { work: "work-d-TASK", feature: "work-d-FEAT" })], "archive-1.jsonl");
    const t = await readMemoryTree(den, work, NOW);
    expect(t.features[0]!.tasks[0]).toMatchObject({ pending: 1, archived: 1 });
  });
});

describe("readMemoryNode", () => {
  it("returns a feature's own observations only, archived newest first, truncated at limit", async () => {
    pool([obs("own", { feature: "work-d-FEAT" }), obs("task", { work: "work-d-TASK", feature: "work-d-FEAT" })]);
    archive([
      arch("a1", "2026-11-06T00:00:00Z", { feature: "work-d-FEAT" }),
      arch("a2", "2026-11-08T00:00:00Z", { feature: "work-d-FEAT" }),
      arch("a3", "2026-11-07T00:00:00Z", { feature: "work-d-FEAT" }),
      arch("x", "2026-11-07T00:00:00Z", { work: "work-d-TASK", feature: "work-d-FEAT" }),
    ]);
    const n = await readMemoryNode(den, "work-d-FEAT", work, 2, NOW);
    expect(n.pending.map((p) => p.content)).toEqual(["own"]);
    expect(n.archived.map((a) => a.content)).toEqual(["a2", "a3"]);
    expect(n.archived[0]).toMatchObject({ outcome: "written", target: "work-d-TASK", at: "2026-11-08T00:00:00Z" });
    expect(n.truncated).toBe(true);
  });
});
