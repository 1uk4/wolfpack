import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { section } from "../extension-api.js";
import { adaptToDurable } from "../adapters/durable.js";
import { pendingNotices, pendingTaskNotice, stripTaskNotice, withTaskNotice, type TaskNoticeReader, type WorkItemLite } from "./task-notice.js";

let den: string;
let items: Map<string, { item: WorkItemLite; body: string }>;
const reader: TaskNoticeReader = {
  async get(id) { return items.get(id); },
  async children(_d, featureId) { return [...items.values()].map((v) => v.item).filter((i) => i.partOf === featureId); },
};
const put = (id: string, o: Partial<WorkItemLite>, body = "") => items.set(id, { item: { id, stage: "plan", domain: "wolfpack", ...o }, body });
const bind = (cid: string, workId: string | null) => {
  const dir = join(den, "factory", "conversations", cid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "active-task.json"), workId ? JSON.stringify({ workId }) : "null");
};
/** One boundary: the notice text, committed as a delivered message would. */
const boundary = async (cid = "1") => { const n = await pendingTaskNotice(den, cid, reader); n.commit(); return n.text; };

beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "tn-"));
  items = new Map();
  put("F", { kind: "feature", stage: "in_build" });
  put("T1", { kind: "task", partOf: "F", stage: "in_build" }, "plan");
  put("T2", { kind: "task", partOf: "F" });
  put("T3", { kind: "task", partOf: "F" });
  bind("1", "T1");
});
afterEach(() => rmSync(den, { recursive: true, force: true }));

describe("task-update notice", () => {
  it("first look records a baseline without a notice; nothing changed means nothing", async () => {
    expect(await boundary()).toBe("");
    expect(await boundary()).toBe("");
  });

  it("one coalesced notice per change burst, then none", async () => {
    await boundary();
    items.get("T1")!.item.stage = "shipped";
    items.get("T1")!.body = "plan\n## Record\nfact";
    items.get("T2")!.item.stage = "shipped";
    expect(await boundary()).toBe("Task update: stage in_build → shipped; 2/3 tasks shipped; Record updated");
    expect(await boundary()).toBe("");
  });

  it("a note-only change says Record updated; a stage-only change says the stage", async () => {
    await boundary();
    items.get("T1")!.body = "plan\nnote";
    expect(await boundary()).toBe("Task update: Record updated");
    items.get("T1")!.item.stage = "in_review";
    items.get("F")!.item.stage = "in_review"; // the feature's own stage is not reported
    expect(await boundary()).toBe("Task update: stage in_build → in_review");
  });

  it("a failed delivery is not committed: the notice comes again", async () => {
    await boundary();
    items.get("T1")!.body = "changed";
    const first = await pendingTaskNotice(den, "1", reader); // not committed
    expect(first.text).toBe("Task update: Record updated");
    expect((await pendingTaskNotice(den, "1", reader)).text).toBe("Task update: Record updated");
  });

  it("a restart with unchanged state sends nothing (the snapshot is on disk); a change made while down is announced once", async () => {
    await boundary();
    expect(await boundary()).toBe(""); // a new process reads the same file
    items.get("T2")!.item.stage = "shipped";
    expect(await boundary()).toBe("Task update: 1/3 tasks shipped");
    expect(await boundary()).toBe("");
  });

  it("bind, unbind and rebind send no notice (the header changes instead)", async () => {
    await boundary();
    bind("1", "T2");
    expect(await boundary()).toBe("");
    bind("1", null);
    expect(await boundary()).toBe("");
    bind("1", "T2");
    items.get("T2")!.item.stage = "shipped";
    expect(await boundary()).toBe(""); // rebind to the same item after an unbind: fresh baseline
    items.get("T2")!.body = "x";
    expect(await boundary()).toBe("Task update: Record updated");
  });

  it("unreadable Work API or unbound conversation: silent", async () => {
    await boundary();
    items.clear();
    expect(await boundary()).toBe("");
    expect(await boundary("2")).toBe("");
  });

  it("a failed parent read keeps the baseline (no false Record update); a failed children read keeps the old counts", async () => {
    await boundary();
    const failing: TaskNoticeReader = { ...reader, async get(id) { if (id === "F") throw new Error("boom"); return items.get(id); } };
    const n = await pendingTaskNotice(den, "1", failing);
    expect(n.text).toBe("");
    const partial: TaskNoticeReader = { ...reader, async children() { throw new Error("boom"); } };
    expect((await pendingTaskNotice(den, "1", partial)).text).toBe("");
    items.get("T2")!.item.stage = "shipped";
    expect(await boundary()).toBe("Task update: 1/3 tasks shipped");
    items.get("F")!.body = "feature record";
    const down: TaskNoticeReader = { ...reader, async get(id) { return id === "F" ? undefined : items.get(id); } };
    expect((await pendingTaskNotice(den, "1", down)).text).toBe("");
    expect(await boundary()).toBe("Task update: Record updated");
  });

  it("only generated notices are stripped", () => {
    expect(stripTaskNotice("Task update: stage a → b; 2/3 tasks shipped; feature tasks changed; Record updated\n\nx")).toBe("x");
    expect(stripTaskNotice("Task update: please review\n\nx")).toBe("Task update: please review\n\nx");
    expect(stripTaskNotice("Task update: Record updated; nonsense\n\nx")).toContain("Task update");
  });

  it("the notice is a head line the history strips again", () => {
    const text = withTaskNotice("Task update: Record updated", "hello");
    expect(text).toBe("Task update: Record updated\n\nhello");
    expect(stripTaskNotice(text)).toBe("hello");
    expect(stripTaskNotice("hello")).toBe("hello");
  });
});

describe("context update line", () => {
  const ctx = { abortSignal: undefined } as never;
  const memory = { v: "- a.md [x] -- one" };
  const CTX = "Context update: wolf_memory changed (+1: b.md [x] -- two); read the topic files";
  /** The frozen wolf_memory section, driven the way pi-durable drives it: render per request with the transcript's text as `shown`. */
  const render = async (cid: string, shown: string | undefined) => {
    const ext = adaptToDurable({ name: "t", sections: [section("wolf_memory", () => memory.v, { frozen: true })] } as never, { wolfDen: den, wolfName: "w" });
    const [sec] = ext.sections as unknown as Array<{ render(i: unknown, c: unknown): Promise<string | undefined> }>;
    return sec!.render({ conversationId: cid, shown: shown === undefined ? {} : { wolf_memory: `<wolf_memory>\n${shown}\n</wolf_memory>` } }, ctx);
  };
  const changeMemory = async (cid: string) => {
    const first = await render(cid, undefined);
    memory.v = "- a.md [x] -- one\n- b.md [x] -- two";
    await render(cid, first);
  };
  beforeEach(() => { memory.v = "- a.md [x] -- one"; });

  it("rides after the task update, one commit marks both delivered, and the history strips both", async () => {
    await boundary(); // baseline for the bound task
    items.get("T1")!.item.stage = "shipped";
    await changeMemory("1");
    const n = await pendingNotices(den, "1", reader);
    expect(n.text).toBe(`Task update: stage in_build → shipped; 1/3 tasks shipped\n\n${CTX}`);
    n.commit();
    expect((await pendingNotices(den, "1", reader)).text).toBe("");
    expect(stripTaskNotice(stripTaskNotice(withTaskNotice(n.text, "hello")))).toBe("hello");
  });

  it("still carries the context update on a wolf with no Work API", async () => {
    await changeMemory("2");
    expect((await pendingNotices(den, "2")).text).toBe(CTX);
  });

  it("a slow Work API drops only the task part", async () => {
    await boundary();
    items.get("T1")!.item.stage = "shipped";
    await changeMemory("1");
    const slow: TaskNoticeReader = { ...reader, get: () => new Promise(() => {}) };
    expect((await pendingNotices(den, "1", slow, 20)).text).toBe(CTX);
  });

  it("strips only the generated line: operator text that starts like it survives", () => {
    expect(stripTaskNotice("Context update: kb_access changed the plan\n\nhi")).toBe("Context update: kb_access changed the plan\n\nhi");
    expect(stripTaskNotice("Context update: is a phrase I use\n\nhello")).toBe("Context update: is a phrase I use\n\nhello");
    expect(stripTaskNotice('Context update: active_task changed (now work-wolfpack-AbC1234 "T"); call task_current\n\nhi')).toBe("hi");
  });
});
