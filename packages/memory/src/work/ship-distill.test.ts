import { describe, it, expect } from "vitest";
import { distillTaskToFeature } from "./ship-distill.js";
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
    expect(body).toContain("### Decisions\n\n- 10:30 [hal\u00b7Decisions] Use a TTL map <!-- src:distilled:t,distilled:t:1 -->");
    expect(body).toContain("### Findings\n\n- 10:30 [hal\u00b7Findings] Eviction ran on every read <!-- src:distilled:t,distilled:t:2 -->");
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
