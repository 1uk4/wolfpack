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
  "work-d-KIDS": { id: "work-d-KIDS", title: "Kid", kind: "task", stage: "plan", partOf: "work-d-FEAT" },
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
    const d = new URL(String(url)).searchParams.get("domain");
    const items = Object.values(ITEMS).filter((i) => (i as { id: string }).id.startsWith(`work-${d}-`));
    return { ok: true, status: 200, json: async () => ({ items }) };
  });
});
afterEach(() => vi.unstubAllGlobals());
const pool = (xs: object[]) => writeFileSync(join(den, ".memory", "pool", "observations.jsonl"), jl(xs));
const archive = (xs: object[], file = "archive.jsonl") => writeFileSync(join(den, ".memory", "pool", file), jl(xs));

describe("readMemoryTree", () => {
  it("nests tasks under features, counts feature-only as own, untagged as den, unknown items as other", async () => {
    pool([
      obs("a", { work: "work-d-TASK", feature: "work-d-FEAT" }),
      obs("b", { work: "work-d-KIDS" }),
      obs("c", { feature: "work-d-FEAT" }),
      obs("d", { work: "work-d-FEAT", feature: "work-d-FEAT" }),
      obs("e"),
      obs("f", { work: "work-d-GONE" }),
    ]);
    const t = await readMemoryTree(den, work, NOW);
    expect(t.den).toEqual({ pending: 1, archived: 0 });
    expect(t.other).toEqual([{ id: "work-d-GONE", pending: 1, archived: 0 }]);
    expect(t.features).toEqual([{
      id: "work-d-FEAT", title: "Feature", stage: "build", own: { pending: 2, archived: 0 },
      tasks: [
        { id: "work-d-TASK", title: "Task", stage: "plan", pending: 1, archived: 0 },
        { id: "work-d-KIDS", title: "Kid", stage: "plan", pending: 1, archived: 0 },
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

  it("counts the den as live pool entries only and reports promoted untagged ones as archived", async () => {
    pool([obs("a")]);
    archive([arch("p1", "2026-11-08T00:00:00Z", { target: "den" }), arch("p2", "2026-11-08T01:00:00Z"), arch("p3", "2026-11-09T00:00:00Z")]);
    const t = await readMemoryTree(den, work, NOW);
    expect(t.den).toEqual({ pending: 1, archived: 3 });
  });

  it("reads at most the three newest archive files", async () => {
    pool([]);
    const tag = { work: "work-d-TASK", feature: "work-d-FEAT" };
    archive([arch("live", "2026-11-08T00:00:00Z", tag)]);
    for (const n of [1, 2, 3, 4]) archive([arch(`r${n}`, "2026-11-07T00:00:00Z", tag)], `archive-${n}.jsonl`);
    const t = await readMemoryTree(den, work, NOW);
    // archive.jsonl + archive-4 + archive-3; archive-1 and -2 are not read
    expect(t.features[0]!.tasks[0]).toMatchObject({ archived: 3 });
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

describe("work lookups cost at most one Work API request per domain (work-wolfpack-b6Vllz7)", () => {
  /** A hub that serves `GET /work?domain=<d>` lists only; records every request URL. */
  const tid = (d: string, i: number) => `work-${d}-T${String(i).padStart(3, "0")}`;
  const idsOf = (url: string) => new URL(url).searchParams.get("ids")?.split(",") ?? [];
  /** `oldHub`: ignores the `ids` filter and returns the whole domain, as a hub before work-wolfpack-4NCfshp does. */
  const hub = (opts: { fail?: boolean; delayMs?: number; oldHub?: boolean } = {}) => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) return { ok: false, status: 503 };
      const d = new URL(String(url)).searchParams.get("domain");
      if (!d) return { ok: false, status: 404 };
      const want = opts.oldHub ? undefined : new URL(String(url)).searchParams.get("ids")?.split(",");
      const items = [
        { id: `work-${d}-FEAT`, title: `Feature ${d}`, kind: "feature", stage: "build" },
        ...Array.from({ length: 20 }, (_, i) => ({ id: tid(d, i), title: `Task ${d}${i}`, kind: "task", stage: "plan", partOf: `work-${d}-FEAT` })),
      ].filter((i) => !want || want.includes(i.id));
      return { ok: true, status: 200, json: async () => ({ items }) };
    });
    return urls;
  };

  it("resolves a pool of 40 ids across 2 domains in two waves of one request per domain, asking for exactly the ids needed, then none while cached", async () => {
    const urls = hub();
    pool(["a", "b"].flatMap((d) => Array.from({ length: 20 }, (_, i) => obs(`o${d}${i}`, { work: tid(d, i) }))));
    const t = await readMemoryTree(den, work, NOW);
    const q = urls.map((u) => new URL(u).searchParams);
    expect(q.map((p) => p.get("domain"))).toEqual(["a", "b", "a", "b"]);
    expect(q.map((p) => p.get("fields"))).toEqual(["summary", "summary", "summary", "summary"]); // titles and stages only: no log or criteria
    expect(idsOf(urls[0]!)).toEqual(Array.from({ length: 20 }, (_, i) => tid("a", i)));
    expect(idsOf(urls[2]!)).toEqual(["work-a-FEAT"]);
    expect(idsOf(urls[3]!)).toEqual(["work-b-FEAT"]);
    expect(t.features.map((f) => [f.id, f.title, f.tasks.length]).sort()).toEqual([["work-a-FEAT", "Feature a", 20], ["work-b-FEAT", "Feature b", 20]]);
    expect(t.features.find((f) => f.id === "work-a-FEAT")!.tasks[3]).toEqual({ id: "work-a-T003", title: "Task a3", stage: "plan", pending: 1, archived: 0 });
    await readMemoryTree(den, work, NOW + 1000); // everything cached: no request
    expect(urls.length).toBe(4);
  });

  it("an old hub that ignores ids returns the whole domain once; the parent-feature wave hits the cache", async () => {
    const urls = hub({ oldHub: true });
    pool([obs("a", { work: tid("a", 3) })]);
    const t = await readMemoryTree(den, work, NOW);
    expect(urls.length).toBe(1);
    expect(t.features).toEqual([{ id: "work-a-FEAT", title: "Feature a", stage: "build", own: { pending: 0, archived: 0 }, tasks: [{ id: "work-a-T003", title: "Task a3", stage: "plan", pending: 1, archived: 0 }] }]);
  });

  it("splits more than 100 ids of a domain into requests of at most 100, and sends no id the hub would reject", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ items: idsOf(String(url)).map((id) => ({ id, title: id, kind: "task", stage: "plan" })) }) };
    });
    pool([...Array.from({ length: 150 }, (_, i) => obs(`o${i}`, { work: tid("a", i) })), obs("x", { work: "work-a-ab" }), obs("y", { work: "nonsense" })]);
    await readMemoryTree(den, work, NOW);
    expect(urls.map((u) => idsOf(u).length)).toEqual([100, 50]);
    expect(urls.flatMap(idsOf)).not.toContain("work-a-ab");
    expect(urls.flatMap(idsOf)).not.toContain("nonsense");
  });

  describe("cache lifetime", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
    afterEach(() => vi.useRealTimers());
    /** Read the tree `ms` after NOW (the cache stamps entries with the real clock, faked here). */
    const readAt = (ms: number) => { vi.setSystemTime(NOW + ms); return readMemoryTree(den, work, Date.now()); };

    it("asks a failing hub once for reads up to 15 s apart, shows the ids unresolved, and asks again after 16 s", async () => {
      const urls = hub({ fail: true });
      pool([obs("a", { work: "work-d-TASK" })]);
      const t1 = await readAt(0);
      await readAt(14_000);
      expect(urls.length).toBe(1);
      expect(t1.other).toEqual([{ id: "work-d-TASK", pending: 1, archived: 0 }]);
      await readAt(16_000);
      expect(urls.length).toBe(2);
    });

    it("keeps a resolved id for 30 s and asks again after 31 s", async () => {
      const urls = hub();
      pool([obs("a", { work: tid("a", 1) })]);
      await readAt(0);
      expect(urls.length).toBe(2); // the task, then its parent feature
      await readAt(29_000);
      expect(urls.length).toBe(2);
      await readAt(31_000);
      expect(urls.length).toBe(4);
    });
  });

  it("shares one in-flight request per domain between concurrent reads", async () => {
    const urls = hub({ delayMs: 30 });
    pool([obs("a", { work: tid("a", 1) }), obs("b", { work: tid("b", 1) })]);
    await Promise.all([readMemoryTree(den, work, NOW), readMemoryNode(den, tid("a", 1), work, 10, NOW)]);
    // two waves (tasks, then their parent features), one request per domain each, none repeated by the second reader
    expect(urls.length).toBe(4);
    expect(new Set(urls).size).toBe(4);
  });

  it("concurrent reads with partly overlapping ids ask only for what is neither cached nor in flight", async () => {
    const urls = hub({ delayMs: 30 });
    pool([obs("a", { work: tid("a", 0) }), obs("b", { work: tid("a", 1) })]);
    const den2 = mkdtempSync(join(tmpdir(), "tree2-"));
    mkdirSync(join(den2, ".memory", "pool"), { recursive: true });
    writeFileSync(join(den2, ".memory", "pool", "observations.jsonl"), jl([obs("c", { work: tid("a", 1) }), obs("d", { work: tid("a", 2) })]));
    await Promise.all([readMemoryTree(den, work, NOW), readMemoryTree(den2, work, NOW)]);
    const asked = urls.flatMap(idsOf);
    expect([...asked].sort()).toEqual(["work-a-FEAT", tid("a", 0), tid("a", 1), tid("a", 2)]);
  });
});
