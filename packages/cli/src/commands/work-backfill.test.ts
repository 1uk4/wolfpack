import { describe, expect, it, vi } from "vitest";
import { planBackfill, workBackfillFeatureStages } from "./work-backfill.js";
import type { WorkItemLite } from "./work-doctor.js";

let n = 0;
const item = (o: Partial<WorkItemLite>): WorkItemLite => ({
  id: `work-wolfpack-b${++n}`, kind: "task", domain: "wolfpack", title: `t${n}`, stage: "plan", partOf: null, graduated: null, ...o,
});

const done = item({ kind: "feature", stage: "in_build", title: "done" });
const open = item({ kind: "feature", stage: "in_build" });
const empty = item({ kind: "feature", stage: "in_build" });
const std = item({ kind: "feature", stage: "in_build", standing: true });
const already = item({ kind: "feature", stage: "shipped" });
const items = [
  done, item({ stage: "shipped", partOf: done.id }), item({ stage: "archived", partOf: done.id }),
  open, item({ stage: "shipped", partOf: open.id }), item({ stage: "in_build", partOf: open.id }),
  empty, std, item({ stage: "shipped", partOf: std.id }),
  already, item({ stage: "shipped", partOf: already.id }),
];

function fakeFetch() {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    return init?.method === "PATCH" ? new Response("{}") : new Response(JSON.stringify({ items }));
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("backfill-feature-stages", () => {
  it("plans only features whose tasks are all done", () => {
    expect(planBackfill(items).map((i) => i.id)).toEqual([done.id]);
  });

  it("dry-run lists without writing; the real run PATCHes stage then note", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dry = fakeFetch();
    const r1 = await workBackfillFeatureStages({ dryRun: true, endpoint: "http://local", token: "k", fetchImpl: dry.f });
    expect(r1.moved).toEqual([]);
    expect(dry.calls.every((c) => c.method === "GET")).toBe(true);
    const real = fakeFetch();
    const r2 = await workBackfillFeatureStages({ endpoint: "http://local", token: "k", fetchImpl: real.f });
    expect(r2.moved).toEqual([done.id]);
    const patches = real.calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => JSON.parse(c.body!))).toEqual([{ stage: "shipped" }, { note: "auto: all tasks shipped" }]);
    expect(patches[0]!.url).toBe(`http://local/work/${done.id}`);
  });
});
