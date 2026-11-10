import { describe, it, expect } from "vitest";
import { distillTaskToFeature, sweepPendingDistills } from "./ship-distill.js";
import { InMemoryWorkRecordStore } from "../work-record.js";

const TASK_LOG = "## Record\n\n- 10:00 [hal\u00b7Changes] switched the cache to a TTL map <!-- src:o1 -->\n- 10:02 [hal\u00b7Findings] eviction ran on every read <!-- src:o2 -->";

function setup(over: { featureBody?: string; taskBody?: string; reply?: unknown | Error } = {}) {
  const store = new InMemoryWorkRecordStore({
    f: { id: "f", title: "Feature", kind: "feature", stage: "in_build", body: over.featureBody ?? "## Record\n\n### Changes\n\n- 09:00 [x\u00b7Changes] earlier <!-- src:a -->" },
    t: { id: "t", title: "Task", kind: "task", stage: "shipped", partOf: "f", body: over.taskBody ?? TASK_LOG },
  });
  const prompts: string[] = [];
  const engine = {
    call: async (_step: string, _schema: unknown, o: { prompt: string }) => {
      prompts.push(o.prompt);
      if (over.reply instanceof Error) throw over.reply;
      return over.reply ?? { lines: [{ group: "Decisions", text: "Use a TTL map" }, { group: "Findings", text: "Eviction ran on every read" }] };
    },
  } as never;
  const run = () => distillTaskToFeature({ store, engine, taskId: "t", src: "hal", now: () => new Date("2026-11-09T10:30:00Z") });
  return { store, prompts, run };
}

describe("distillTaskToFeature", () => {
  it("puts the model's lines under their ### groups of the feature Record", async () => {
    const { store, run } = setup();
    expect(await run()).toEqual({ ok: true, status: "distilled", lines: 2 });
    const body = (await store.get("f"))!.body;
    expect(body).toContain("### Decisions\n\n- 10:30 [hal\u00b7decision] Use a TTL map <!-- src:distilled:t,distilled:t:1 -->");
    expect(body).toContain("### Findings\n\n- 10:30 [hal\u00b7finding] Eviction ran on every read <!-- src:distilled:t,distilled:t:2 -->");
    expect(body).toContain("### Changes\n\n- 09:00 [x\u00b7Changes] earlier");
  });

  it("shipping twice makes one model call and one append", async () => {
    const { store, prompts, run } = setup();
    await run();
    const after = (await store.get("f"))!.body;
    expect(await run()).toEqual({ ok: true, status: "already", lines: 0 });
    expect(prompts).toHaveLength(1);
    expect((await store.get("f"))!.body).toBe(after);
  });

  it("an empty model answer writes one marker line, so the task is not retried", async () => {
    const { store, prompts, run } = setup({ reply: { lines: [] } });
    expect(await run()).toEqual({ ok: true, status: "marker-only", lines: 0 });
    expect((await store.get("f"))!.body).toContain("<!-- src:distilled:t -->");
    await run();
    expect(prompts).toHaveLength(1);
  });

  it("makes no model call for an empty task log or a task without a feature", async () => {
    const empty = setup({ taskBody: "## Plan\n\nonly a plan" });
    expect(await empty.run()).toEqual({ ok: true, status: "skipped", lines: 0 });
    expect(empty.prompts).toHaveLength(0);
    const orphan = setup();
    orphan.store.items.t!.partOf = null;
    expect(await orphan.run()).toEqual({ ok: true, status: "skipped", lines: 0 });
    expect(orphan.prompts).toHaveLength(0);
  });

  it("on a full feature Record compacts it, appends, and distilling again still makes no model call", async () => {
    const fill = Array.from({ length: 24 }, (_, i) => `- 09:00 [x·Changes] old ${i} ${"x".repeat(130)} <!-- src:${i === 0 ? "distilled:older,distilled:older:1" : `old${i}`} -->`).join("\n");
    const { store, prompts, run } = setup({ featureBody: `## Record\n\n### Changes\n\n${fill}` });
    const steps: string[] = [];
    const engine = {
      call: async (step: string, _s: unknown, o: { prompt: string }) => {
        steps.push(step);
        prompts.push(o.prompt);
        return step === "workCompact" ? { lines: [{ kind: "change", text: "old stuff", from: ["l2", "l3"] }] } : { lines: [{ group: "Decisions", text: "Use a TTL map" }] };
      },
    } as never;
    const res = await distillTaskToFeature({ store, engine, taskId: "t", src: "hal", now: () => new Date("2026-11-09T10:30:00Z") });
    expect(res).toEqual({ ok: true, status: "distilled", lines: 1 });
    expect(steps).toEqual(["workDistill", "workCompact"]);
    const body = (await store.get("f"))!.body;
    expect(body).toContain("Use a TTL map <!-- src:distilled:t,distilled:t:1 -->");
    expect(body).toContain("distilled:older,distilled:older:1");
    expect(await run()).toEqual({ ok: true, status: "already", lines: 0 });
    expect(steps).toHaveLength(2);
  });

  it("a model failure returns ok:false without throwing and writes nothing", async () => {
    const { store, run } = setup({ reply: new Error("model down") });
    const before = (await store.get("f"))!.body;
    expect(await run()).toEqual({ ok: false, reason: "model down" });
    expect((await store.get("f"))!.body).toBe(before);
  });

  it("never sends the whole feature Record to the model: headings and the last 6 bullets only", async () => {
    const bullets = Array.from({ length: 10 }, (_, i) => `- 09:0${i} [x\u00b7Changes] bullet ${i === 0 ? "SENTINEL-DEEP" : i} <!-- src:b${i} -->`).join("\n");
    const { prompts, run } = setup({ featureBody: `## Record\n\n### Changes\n\n${bullets}` });
    await run();
    expect(prompts[0]).not.toContain("SENTINEL-DEEP");
    expect(prompts[0]).toContain("bullet 9");
    expect(prompts[0]).toContain("- Changes");
    expect(prompts[0]).toContain("switched the cache to a TTL map");
    expect(prompts[0]).not.toContain("src:");
  });
});

describe("distilling on archive", () => {
  it("an unshipped task archived with a log distills once; archiving again adds nothing", async () => {
    const { store, prompts, run } = setup();
    store.items.t!.stage = "archived";
    expect(await run()).toMatchObject({ ok: true, status: "distilled" });
    expect(await run()).toMatchObject({ ok: true, status: "already" });
    expect(prompts).toHaveLength(1);
  });
});

describe("sweepPendingDistills", () => {
  const log = (n: string) => `## Record\n\n- 10:00 [hal\u00b7Changes] did ${n} <!-- src:o${n} -->`;
  function sweepSetup(
    tasks: Array<{ id: string; stage?: string; updated: string; body?: string }>,
    featureBody = "## Record\n\n### Changes\n\n- 09:00 [x\u00b7Changes] earlier <!-- src:a -->",
    reply: unknown = { lines: [{ group: "Changes", text: "folded" }] },
  ) {
    const items = {
      f: { id: "f", title: "Feature", kind: "feature", stage: "in_build", body: featureBody },
      ...Object.fromEntries(tasks.map((t) => [t.id, { id: t.id, title: t.id, kind: "task", stage: t.stage ?? "shipped", partOf: "f", body: t.body ?? log(t.id) }])),
    };
    const store = new InMemoryWorkRecordStore(items as never);
    const calls: string[] = [];
    const queries: unknown[] = [];
    const engine = {
      call: async (_s: string, _x: unknown, o: { prompt: string }) => {
        calls.push(o.prompt);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    } as never;
    const client = {
      query: async (q: { kind?: string; partOf?: string }) => {
        queries.push(q);
        if (q.partOf) return tasks.map((t) => ({ id: t.id, kind: "task", stage: t.stage ?? "shipped", partOf: "f", updated: t.updated }));
        return [{ id: "f", kind: "feature", stage: "in_build", partOf: null, updated: "2026-01-01" }];
      },
    };
    const run = (limit?: number) => sweepPendingDistills({ client, store, engine, src: "hal", limit, now: () => new Date("2026-11-09T10:30:00Z") });
    return { store, calls, queries, run };
  }

  it("distills only the shipped task whose feature lacks its marker: one model call", async () => {
    const s = sweepSetup(
      [{ id: "t1", updated: "2026-02-01" }, { id: "t2", updated: "2026-02-02" }],
      "## Record\n\n### Changes\n\n- 09:00 [hal\u00b7Changes] old <!-- src:distilled:t1,distilled:t1:1 -->",
    );
    const r = await s.run();
    expect(s.calls).toHaveLength(1);
    expect(r.distilled).toEqual(["t2"]);
    expect(s.queries).toHaveLength(2); // the feature list, then one query for that feature's children
  });

  it("goes oldest first and stops at the limit", async () => {
    const s = sweepSetup([{ id: "new", updated: "2026-03-01" }, { id: "old", updated: "2026-01-01" }, { id: "mid", updated: "2026-02-01" }]);
    expect((await s.run(2)).distilled).toEqual(["old", "mid"]);
    expect(s.calls).toHaveLength(2);
    expect((await s.run(2)).distilled).toEqual(["new"]);
  });

  it("skips a task with an empty Record without a model call and does not spend the limit on it", async () => {
    const s = sweepSetup([{ id: "empty", updated: "2026-01-01", body: "## Plan\n\nnothing" }, { id: "full", updated: "2026-02-01" }]);
    const r = await s.run(1);
    expect(r.distilled).toEqual(["full"]);
    expect(s.calls).toHaveLength(1);
  });

  it("a model failure does not throw and leaves the task for the next run", async () => {
    const s = sweepSetup([{ id: "t1", updated: "2026-01-01" }], undefined, new Error("model down"));
    expect(await s.run()).toEqual({ distilled: [], failed: ["t1"] });
    expect(s.store.items.f!.body).not.toContain("distilled:t1");
  });
});
