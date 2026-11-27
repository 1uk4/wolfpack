import { describe, it, expect } from "vitest";
import { finalFeaturePass } from "./final-pass.js";
import { InMemoryWorkRecordStore } from "../work-record.js";

const REC = [
  "## Record",
  "",
  "### Decisions",
  "",
  "- 09:00 [hal·Decisions] Use a map <!-- src:distilled:t1,distilled:t1:1 -->",
  "- 09:10 [hal·decision] Use a TTL map instead <!-- src:distilled:t2,distilled:t2:1 -->",
  "",
  "### Changes",
  "",
  "- 09:20 [hal·Changes] Added the cache layer with a long explanation that makes the original clearly longer <!-- src:distilled:t3 -->",
  "- 09:30 [hal·Changes] Wired the cache into reads <!-- src:o7 -->",
].join("\n");

function setup(over: { body?: string; kind?: string; reply?: unknown | Error; mutate?: (s: InMemoryWorkRecordStore) => void } = {}) {
  const store = new InMemoryWorkRecordStore({ f: { id: "f", title: "Feat", kind: over.kind ?? "feature", stage: "shipped", body: over.body ?? REC } });
  const prompts: string[] = [];
  const engine = {
    call: async (_s: string, _schema: unknown, o: { prompt: string }) => {
      prompts.push(o.prompt);
      over.mutate?.(store);
      if (over.reply instanceof Error) throw over.reply;
      return over.reply ?? { lines: [
        { group: "Decisions", text: "Use a TTL map", from: ["l2"] },
        { group: "Changes", text: "Cache wired into reads", from: ["l3", "l4"] },
      ] };
    },
  } as never;
  const run = () => finalFeaturePass({ store, engine, featureId: "f", src: "hal", now: () => new Date("2026-11-09T11:00:00Z") });
  return { store, prompts, run };
}

describe("finalFeaturePass", () => {
  it("rewrites the Record under the same groups, keeping distilled markers and adding the pass marker once", async () => {
    const { store, run } = setup();
    expect((await run()).ok).toBe(true);
    const body = (await store.get("f"))!.body;
    expect(body).toContain("### Decisions\n\n- 11:00 [hal·decision] Use a TTL map <!-- src:distilled:t2,distilled:t2:1,final-pass:f,distilled:t1,distilled:t1:1 -->");
    expect(body).toContain("### Changes\n\n- 11:00 [hal·change] Cache wired into reads <!-- src:distilled:t3,o7 -->");
    expect(body.match(/final-pass:f/g)).toHaveLength(1);
    expect(body).not.toContain("Use a map");
  });

  it("a repeat makes no model call and changes nothing", async () => {
    const { store, prompts, run } = setup();
    await run();
    const after = (await store.get("f"))!.body;
    expect(await run()).toMatchObject({ ok: true, status: "already" });
    expect(prompts).toHaveLength(1);
    expect((await store.get("f"))!.body).toBe(after);
  });

  it("aborts without writing when the Record changed while the model ran", async () => {
    const { store, run } = setup({
      mutate: (s) => { s.items.f!.body += "\n- 09:40 [hal·Changes] late line <!-- src:o9 -->"; },
    });
    expect(await run()).toEqual({ ok: false, reason: "changed" });
    const body = (await store.get("f"))!.body;
    expect(body).toContain("late line");
    expect(body).not.toContain("final-pass:");
  });

  it("a line appended between the re-read and the write makes the write 409; the pass retries once on the fresh Record and keeps the line", async () => {
    // The model sees the fresh Record on the retry, so its answer cites the late line (l5).
    const { store, run } = setup({ reply: { lines: [
      { group: "Decisions", text: "Use a TTL map", from: ["l2"] },
      { group: "Changes", text: "Cache wired into reads", from: ["l3", "l4"] },
      { group: "Changes", text: "late line", from: ["l5"] },
    ] } });
    const realSet = store.setRecord.bind(store);
    let writes = 0;
    store.setRecord = async (id, text, opts) => {
      if (++writes === 1) store.items.f!.body += "\n- 09:40 [hal·Changes] late line <!-- src:o9 -->"; // lands after the pass's re-read
      return realSet(id, text, opts);
    };
    expect((await run()).ok).toBe(true);
    expect(writes).toBe(2);
    const body = (await store.get("f"))!.body;
    expect(body).toContain("late line <!-- src:o9 -->");
    expect(body.match(/final-pass:f/g)).toHaveLength(1);
  });

  it("a second conflict returns {ok:false, reason:'conflict'} without throwing", async () => {
    const { store, run } = setup();
    const realSet = store.setRecord.bind(store);
    let n = 0;
    store.setRecord = async (id, text, opts) => {
      store.items.f!.body += `\n- 09:4${++n} [hal·Changes] racer ${n} <!-- src:r${n} -->`;
      return realSet(id, text, opts);
    };
    expect(await run()).toEqual({ ok: false, reason: "conflict" });
    expect((await store.get("f"))!.body).toContain("racer 2");
  });

  it("reports the hub's message when the marker append fails", async () => {
    const { store, run } = setup({ reply: new Error("down") });
    store.appendRecord = async () => ({ ok: false, code: "error", message: "the body has more than one ## Record heading" });
    expect(await run()).toEqual({ ok: false, reason: "append failed: error: the body has more than one ## Record heading" });
  });

  it("writes only the marker when the model fails or its answer is not shorter", async () => {
    for (const reply of [new Error("down"), { lines: [{ group: "Changes", text: "y".repeat(230), from: ["l1"] }, { group: "Changes", text: "z".repeat(230), from: ["l2"] }, { group: "Changes", text: "w".repeat(230), from: ["l3"] }] }]) {
      const { store, run } = setup({ reply });
      expect(await run()).toMatchObject({ ok: true, status: "marker-only" });
      const body = (await store.get("f"))!.body;
      expect(body).toContain("Use a map");
      expect(body).toContain("Use a TTL map instead");
      expect(body.match(/final-pass:f/g)).toHaveLength(1);
    }
  });

  it("makes no model call for a non-feature or an empty Record", async () => {
    for (const o of [{ kind: "task" }, { body: "## Record\n" }]) {
      const { prompts, run } = setup(o);
      expect(await run()).toMatchObject({ ok: true, status: "skipped" });
      expect(prompts).toHaveLength(0);
    }
  });
});
