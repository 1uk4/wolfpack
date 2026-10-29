import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingTaskNotice, stripTaskNotice, withTaskNotice, type TaskNoticeReader, type WorkItemLite } from "./task-notice.js";

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

  it("the notice is a head line the history strips again", () => {
    const text = withTaskNotice("Task update: Record updated", "hello");
    expect(text).toBe("Task update: Record updated\n\nhello");
    expect(stripTaskNotice(text)).toBe("hello");
    expect(stripTaskNotice("hello")).toBe("hello");
  });
});
