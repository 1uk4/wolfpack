import { describe, expect, it } from "vitest";
import { compactRecord } from "./compact.js";
import { InMemoryWorkRecordStore, extractRecord } from "../work-record.js";

const L = (n: number, kind: string, ids: string, text = `line ${n} ${"x".repeat(60)}`) => `- 10:0${n} [hal\u00b7${kind}] ${text} <!-- src:${ids} -->`;

function setup(body: string, kind: "task" | "feature", reply: unknown | Error) {
  const store = new InMemoryWorkRecordStore({ i: { id: "i", title: "Item", kind, stage: "in_build", body } });
  const calls: string[] = [];
  const engine = {
    call: async (step: string) => {
      calls.push(step);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as never;
  return { store, calls, run: (cap = 1000) => compactRecord({ store, engine, id: "i", cap, src: "hal" }) };
}
const rec = async (s: InMemoryWorkRecordStore) => extractRecord((await s.get("i"))!.body)!;

describe("compactRecord", () => {
  it("merges cited lines into one whose ids are the union of theirs, under the target size", async () => {
    const body = ["## Record", "", L(1, "change", "a,b"), L(2, "change", "c"), L(3, "finding", "d")].join("\n");
    const { store, run } = setup(body, "task", { lines: [{ kind: "change", text: "merged one and two", from: ["l1", "l2"] }, { kind: "finding", text: "three", from: ["l3"] }] });
    const r = await run(1000);
    expect(r).toMatchObject({ ok: true });
    const out = await rec(store);
    expect(out).toContain("[hal\u00b7change] merged one and two <!-- src:a,b,c -->");
    expect(out).toContain("[hal\u00b7finding] three <!-- src:d -->");
    expect(out.length).toBeLessThanOrEqual(500);
    expect(r.ok && r.after).toBe(out.length);
  });

  it("keeps a distilled marker whose line the model did not cite", async () => {
    const body = ["## Record", "", "### Changes", "", L(1, "Changes", "distilled:t1,distilled:t1:1"), L(2, "Changes", "x"), "", "### Findings", "", L(3, "Findings", "y")].join("\n");
    const { store, run } = setup(body, "feature", { lines: [{ kind: "change", text: "only x", from: ["l2"] }, { kind: "finding", text: "only y", from: ["l3"] }] });
    expect((await run()).ok).toBe(true);
    const out = await rec(store);
    expect(out).toMatch(/### Changes[\s\S]*only x <!-- src:x,distilled:t1,distilled:t1:1 -->[\s\S]*### Findings[\s\S]*only y <!-- src:y -->/);
  });

  it("keeps a marker-only line when its whole group is dropped, and keeps feature groups", async () => {
    const body = ["## Record", "", "### Decisions", "", L(1, "Decisions", "distilled:t2,distilled:t2:1"), "", "### Findings", "", L(2, "Findings", "y")].join("\n");
    const { store, run } = setup(body, "feature", { lines: [{ kind: "finding", text: "only y", from: ["l2"] }] });
    await run();
    const out = await rec(store);
    expect(out).toMatch(/### Decisions\n\n- \d\d:\d\d \[hal\u00b7Decisions\] earlier lines compacted <!-- src:distilled:t2,distilled:t2:1 -->/);
    expect(out).toMatch(/### Findings\n\n- .*only y <!-- src:y -->/);
  });

  it("aborts without writing when the Record changed during the model call", async () => {
    const body = ["## Record", "", L(1, "change", "a"), L(2, "change", "b")].join("\n");
    const { store } = setup(body, "task", null);
    const engine = {
      call: async () => {
        store.items.i!.body += "\n- 11:00 [hal\u00b7change] late arrival <!-- src:z -->";
        return { lines: [{ kind: "change", text: "m", from: ["l1", "l2"] }] };
      },
    } as never;
    const before = store.items.i!.body;
    const r = await compactRecord({ store, engine, id: "i", cap: 1000, src: "hal" });
    expect(r).toEqual({ ok: false, reason: "changed" });
    expect(store.items.i!.body).toBe(before + "\n- 11:00 [hal\u00b7change] late arrival <!-- src:z -->");
  });

  it("falls back to dropping the oldest non-marker lines when the model fails", async () => {
    const lines = [L(1, "change", "distilled:t3,distilled:t3:1"), L(2, "change", "a"), L(3, "change", "b"), L(4, "change", "c"), L(5, "change", "d")];
    const { store, run } = setup(["## Record", "", ...lines].join("\n"), "task", new Error("model down"));
    expect(await run(700)).toMatchObject({ ok: true });
    const out = await rec(store);
    expect(out.length).toBeLessThanOrEqual(420);
    expect(out).toContain("distilled:t3,distilled:t3:1");
    expect(out).toContain("<!-- src:d -->");
    expect(out).not.toContain("<!-- src:a -->");
  });

  it("when the trim must drop marker lines too, all distilled ids end up on one 'earlier lines compacted' line", async () => {
    const lines = [L(1, "change", "distilled:t4,distilled:t4:1"), L(2, "change", "distilled:t5,distilled:t5:1"), L(3, "change", "distilled:t6,distilled:t6:1"), L(4, "change", "d")];
    const { store, run } = setup(["## Record", "", ...lines].join("\n"), "task", new Error("model down"));
    expect(await run(300)).toMatchObject({ ok: true });
    const out = await rec(store);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out).toMatch(/earlier lines compacted <!-- src:(distilled:t[456](:1)?,?){6} -->/);
  });

  it("falls back to the trim when the model output is not shorter", async () => {
    const lines = [L(1, "change", "a"), L(2, "change", "b"), L(3, "change", "c")];
    const { store, run } = setup(["## Record", "", ...lines].join("\n"), "task", { lines: [{ kind: "change", text: "y".repeat(200), from: ["l1"] }, { kind: "change", text: "z".repeat(200), from: ["l2", "l3"] }] });
    expect((await run(300)).ok).toBe(true);
    expect((await rec(store)).length).toBeLessThanOrEqual(180);
  });
});
