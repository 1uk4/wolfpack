import { describe, expect, it } from "vitest";
import { LlmInfraError, type Engine } from "@wolfpack/engine";
import { appendWorkLog } from "./work-log.js";
import { InMemoryWorkRecordStore, type AppendRecordResult, type WorkRecordItem } from "./work-record.js";

const item = (over: Partial<WorkRecordItem>): WorkRecordItem => ({ id: "x", title: "T", kind: "task", stage: "in_build", body: "", ...over });
const o = (id: string, work: string, content: string, feature?: string) => ({ id, work, content, ...(feature ? { feature } : {}) });
const NOW = new Date("2026-11-09T14:35:00Z");

function engineOf(answers: Array<unknown | Error>, prompts: string[] = []) {
  return {
    call: async (_step: string, _schema: unknown, p: { prompt: string }) => {
      prompts.push(p.prompt);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? { lines: [] };
    },
  } as unknown as Engine;
}
const line = (text: string, from: string[], kind = "change") => ({ kind, text, from });

describe("appendWorkLog", () => {
  it("makes one call and one append per task, each to its own task and not the feature", async () => {
    const store = new InMemoryWorkRecordStore({ a: item({ id: "a" }), b: item({ id: "b" }), f: item({ id: "f", kind: "feature" }) });
    const prompts: string[] = [];
    const engine = engineOf([{ lines: [line("A did x", ["o1"])] }, { lines: [line("B did y", ["o1"])] }], prompts);
    const out = await appendWorkLog({ engine, store, src: "wolf", now: () => NOW, observations: [o("1", "a", "obs a", "f"), o("2", "b", "obs b", "f")] });
    expect(prompts).toHaveLength(2);
    expect(out.map((x) => `${x.target}:${x.status}`)).toEqual(["a:written", "b:written"]);
    expect((await store.get("a"))!.body).toContain("- 14:35 [wolf·change] A did x <!-- src:1 -->");
    expect((await store.get("b"))!.body).toContain("B did y");
    expect((await store.get("f"))!.body).toBe("");
  });

  it("appends a feature-only observation to the feature", async () => {
    const store = new InMemoryWorkRecordStore({ f: item({ id: "f", kind: "feature" }) });
    const out = await appendWorkLog({ engine: engineOf([{ lines: [line("F fact", ["o1"], "finding")] }]), store, src: "w", now: () => NOW, observations: [{ id: "9", content: "c", work: "f", feature: "f" }, { id: "8", content: "d", work: "", feature: "f" }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ target: "f", status: "written", ids: ["9", "8"] });
    expect((await store.get("f"))!.body).toContain("[w·finding] F fact <!-- src:9 -->");
  });

  it("consumes the batch and appends nothing when the model returns no lines", async () => {
    const store = new InMemoryWorkRecordStore({ a: item({ id: "a" }) });
    const out = await appendWorkLog({ engine: engineOf([{ lines: [] }]), store, src: "w", observations: [o("1", "a", "noise")] });
    expect(out[0]).toMatchObject({ status: "written", ids: ["1"] });
    expect((await store.get("a"))!.body).toBe("");
  });

  it("leaves observations pending on an infra error", async () => {
    const store = new InMemoryWorkRecordStore({ a: item({ id: "a" }) });
    const out = await appendWorkLog({ engine: engineOf([new LlmInfraError("down")]), store, src: "w", observations: [o("1", "a", "x")] });
    expect(out[0]).toMatchObject({ status: "pending", ids: ["1"], target: "a" });
  });

  it("discards observations of a deleted item", async () => {
    const out = await appendWorkLog({ engine: engineOf([]), store: new InMemoryWorkRecordStore({}), src: "w", observations: [o("1", "gone", "x")] });
    expect(out[0]).toMatchObject({ status: "discarded", reason: "deleted" });
  });

  it("discards observations of an archived item", async () => {
    const store = new InMemoryWorkRecordStore({ a: item({ id: "a", stage: "archived" }) });
    const out = await appendWorkLog({ engine: engineOf([]), store, src: "w", observations: [o("1", "a", "x")] });
    expect(out[0]).toMatchObject({ status: "discarded", reason: "archived" });
  });

  it("keeps observations pending with reason log_full when the log is full", async () => {
    const store = new InMemoryWorkRecordStore({ a: item({ id: "a" }) });
    store.appendRecord = async (): Promise<AppendRecordResult> => ({ ok: false, code: "log_full" });
    const out = await appendWorkLog({ engine: engineOf([{ lines: [line("t", ["o1"])] }]), store, src: "w", observations: [o("1", "a", "x")] });
    expect(out[0]).toMatchObject({ status: "pending", reason: "log_full" });
  });

  it("keeps observations pending as forbidden when the hub refuses", async () => {
    const store = new InMemoryWorkRecordStore({ a: item({ id: "a" }) });
    store.appendRecord = async (): Promise<AppendRecordResult> => ({ ok: false, code: "forbidden", message: "not yours" });
    const out = await appendWorkLog({ engine: engineOf([{ lines: [line("t", ["o1"])] }]), store, src: "w", observations: [o("1", "a", "x")] });
    expect(out[0]).toMatchObject({ status: "pending", cause: "forbidden", reason: "not yours" });
  });

  it("sends the recent log lines and the observation text, and maps from to observation ids", async () => {
    const body = "## Record\n\n- 10:00 [w·change] earlier line <!-- src:0 -->";
    const store = new InMemoryWorkRecordStore({ a: item({ id: "a", title: "Fix cache", body }) });
    const prompts: string[] = [];
    const engine = engineOf([{ lines: [line("uses TTL", ["o2", "o1"], "decision")] }], prompts);
    await appendWorkLog({ engine, store, src: "w", now: () => NOW, observations: [o("p", "a", "first obs"), o("q", "a", "second obs")] });
    expect(prompts[0]).toContain("earlier line");
    expect(prompts[0]).not.toContain("src:0");
    expect(prompts[0]).toContain("[o2] second obs");
    expect((await store.get("a"))!.body).toContain("[w·decision] uses TTL <!-- src:q,p -->");
  });
});
