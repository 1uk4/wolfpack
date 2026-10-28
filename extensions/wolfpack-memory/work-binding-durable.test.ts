import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTasksExtension, { readBoundTask as readBound } from "./unified-tasks.js";
import { bindingFile } from "./conversation-binding.js";

// The same task tools on the durable stack: an in-memory Work API behind fetch.
type Item = Record<string, any>;
let items: Map<string, Item>;
let n: number;
const add = (o: Item) => {
  const id = `work-${++n}`;
  items.set(id, { id, stage: "plan", log: [], container: false, assignee: "1uk4", domain: "wolfpack", body: null, partOf: null, ...o });
  return items.get(id)!;
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function fetchImpl(url: string | URL, init: RequestInit = {}) {
  const u = new URL(String(url));
  const m = u.pathname.replace(/^\/work\/?/, "");
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (init.method === "POST" && m === "") { const it = add(body); return json({ id: it.id, item: it }); }
  if (init.method === "GET" && m === "") {
    const partOf = u.searchParams.get("partOf");
    return json({ items: [...items.values()].filter((i) => !partOf || i.partOf === partOf) });
  }
  const it = items.get(m);
  if (!it) return json({ error: "not found" }, 404);
  if (init.method === "GET") return json({ item: it, body: it.body });
  if (init.method === "PATCH") {
    if (body.stage) it.stage = body.stage;
    if (body.note) it.log.push({ at: "now", text: body.note });
    if (typeof body.body === "string") it.body = body.body;
    return json({ item: it });
  }
  return json({ error: "unsupported" }, 400);
}

let den: string;
let ext: ReturnType<typeof createTasksExtension>;
const readBoundTask = (d: string) => readBound({ wolfDen: d, conversationId: 1 });
const tool = (name: string) => ext.tools!.find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown> = {}) =>
  (await tool(name).execute(args, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 })).content[0].text;
const sectionText = (name: string) => ext.sections!.find((s) => s.name === name)!.render({ wolfDen: den, wolfName: "1uk4", conversationId: 1 } as any) as Promise<string>;

beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "bind-d-"));
  items = new Map();
  n = 0;
  vi.stubEnv("PI_SUBAGENT_AGENT", ""); // these tests run as the main session
  vi.stubEnv("WORK_ENDPOINT", "http://127.0.0.1:1");
  vi.stubEnv("WORK_TOKEN", "t");
  vi.stubGlobal("fetch", fetchImpl);
  ext = createTasksExtension({}, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {} });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(den, { recursive: true, force: true });
});

describe("durable task tools: binding", () => {
  it("has bind, unbind and current; the section says where learning goes while unbound", async () => {
    for (const t of ["task_bind", "task_unbind", "task_current"]) expect(tool(t)).toBeDefined();
    expect(await sectionText("active_task")).toContain("No work item bound: what you learn now goes to den topics, not to a work item. Bind the item you're working on (task_bind).");
    expect(await sectionText("task_tools")).not.toContain("workItem");
  });

  it("task_create binds a new task when nothing is bound (feature = a real parent), and not twice", async () => {
    const f = add({ kind: "feature", title: "F" });
    const r = await run("task_create", { kind: "task", domain: "wolfpack", title: "T1", partOf: f.id });
    expect(r).toContain("Bound to it.");
    expect(await readBoundTask(den)).toMatchObject({ taskId: "work-2", featureId: f.id });
    const r2 = await run("task_create", { kind: "task", domain: "wolfpack", title: "T2", partOf: f.id });
    expect(r2).toContain("Not bound: another item is already bound");
    expect((await readBoundTask(den))?.taskId).toBe("work-2");
  });

  it("an Inbox task is bound without a feature (it keeps its own Record)", async () => {
    const inbox = add({ kind: "feature", title: "Inbox", container: true });
    await run("task_create", { kind: "task", domain: "wolfpack", title: "Stray", partOf: inbox.id });
    expect((await readBoundTask(den))?.featureId).toBeUndefined();
  });

  it("in_build on an unbound item binds it; heads-up on a non-bound item", async () => {
    const a = add({ kind: "task", title: "A", stage: "approved" });
    const b = add({ kind: "task", title: "B" });
    expect(await run("task_stage", { id: a.id, to: "in_build" })).toContain("bound now");
    expect((await readBoundTask(den))?.taskId).toBe(a.id);
    const r = await run("task_note", { id: b.id, text: "x" });
    expect(r.split("\n").at(-1)).toContain(`Heads-up: you're working on "B" (${b.id}) but the bound item is`);
    expect(r).toContain(`Call task_bind ${b.id} if you're switching.`);
    expect(await run("task_update", { id: b.id, body: "p" })).toContain("Heads-up");
    expect(await run("task_done", { id: b.id, confirm: false })).toContain("Heads-up");
    expect((await readBoundTask(den))?.taskId).toBe(a.id);
  });

  it("unbind clears, current reports it", async () => {
    const a = add({ kind: "task", title: "A" });
    await run("task_bind", { id: a.id });
    expect(await run("task_current")).toContain(`ID: ${a.id}`);
    await run("task_unbind");
    expect(await run("task_current")).toBe("No task currently bound.");
    expect(await readBoundTask(den)).toBeNull();
    expect(JSON.parse(readFileSync(bindingFile(den, 1), "utf8"))).toBeNull();
  });
});

describe("durable task tools: Outcomes on ship", () => {
  it("task_done folds the shipped task into its feature's ## Outcomes; the Inbox gets none", async () => {
    const f = add({ kind: "feature", title: "F", body: "# F\n\n## Plan\n\nkeep\n" });
    const t = add({ kind: "task", title: "Do it", partOf: f.id, updated: "2026-10-22T09:00:00Z" });
    await run("task_bind", { id: t.id });
    await run("task_done", { confirm: false });
    expect(items.get(f.id)!.body).toMatch(/^# F\n\n## Plan\n\nkeep\n\n## Outcomes\n[\s\S]*- Do it, shipped 2026-10-22/);

    const inbox = add({ kind: "feature", title: "Inbox", container: true, body: "# Inbox" });
    const s = add({ kind: "task", title: "Stray", partOf: inbox.id });
    await run("task_stage", { id: s.id, to: "shipped" });
    expect(items.get(inbox.id)!.body).toBe("# Inbox");
  });
});

describe("durable task tools: subagent sessions (PI_SUBAGENT_AGENT)", () => {
  it("no binding context or rules, no auto-bind, no heads-up; task_bind / task_unbind refuse", async () => {
    const mine = add({ kind: "task", title: "Mine" });
    await run("task_bind", { id: mine.id });
    expect((await readBoundTask(den))?.taskId).toBe(mine.id);

    vi.stubEnv("PI_SUBAGENT_AGENT", "worker");
    const sub = createTasksExtension({}, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {} });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      sub.tools!.find((t) => t.name === name)!.execute(args, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 });
    const section = (name: string) => sub.sections!.find((s) => s.name === name)!.render({ wolfDen: den, wolfName: "1uk4", conversationId: 1 } as any) as Promise<string>;

    expect(await section("active_task")).toBe("");
    expect(await section("task_tools")).not.toContain("Work item binding");
    for (const [tool, args] of [["task_bind", { id: mine.id }], ["task_unbind", {}]] as const) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.content[0].text).toBe("Subagents don't bind: the orchestrator owns the binding.");
    }
    const created = (await call("task_create", { kind: "task", domain: "wolfpack", title: "Sub task" })).content[0].text as string;
    expect(created).not.toMatch(/Bound to it|Not bound/);
    const other = add({ kind: "task", title: "Other", stage: "approved" });
    expect((await call("task_stage", { id: other.id, to: "in_build" })).content[0].text).toBe(`${other.id} → in_build`);
    const noted = (await call("task_note", { id: other.id, text: "x" })).content[0].text as string;
    expect(noted).not.toContain("Heads-up");
    expect(other.log.at(-1).text).toBe("x");
    // the orchestrator's binding is untouched
    expect((await readBoundTask(den))?.taskId).toBe(mine.id);
  });
});

describe("durable task tools: finishing the last task stays bound until graduated", () => {
  const readyLine = "Bound to F — all tasks done, ready to graduate (press g / task_graduate). Follow-up discussion goes to its Record.";

  it("the last task of a feature: bound to the FEATURE (work = feature = its id), ready label in the context, reply ends with it", async () => {
    const f = add({ kind: "feature", title: "F", body: "# F\n\n## Plan\n\nx\n" });
    const t1 = add({ kind: "task", title: "T1", partOf: f.id });
    const t2 = add({ kind: "task", title: "T2", partOf: f.id });
    await run("task_bind", { id: t1.id });
    expect(await run("task_done", { confirm: false })).toContain(`Bound to next: [${t2.id}]`);
    const last = await run("task_done", { confirm: false });
    expect(last.split("\n").at(-1)).toBe("Bound to F (all tasks done — ready to graduate)");
    expect(last).toContain("Tell the user");
    expect(await readBoundTask(den)).toEqual({ taskId: f.id, featureId: f.id });
    expect(await sectionText("active_task")).toContain(readyLine);
    expect(await sectionText("active_task")).toContain("**Feature:** [");
    // task_done does not ship the feature
    const again = await tool("task_done").execute({ confirm: false }, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 });
    expect(again.isError).toBe(true);
    expect(items.get(f.id)!.stage).not.toBe("shipped");
    // a task added later: the binding stays
    add({ kind: "task", title: "Late", partOf: f.id });
    expect((await readBoundTask(den))?.taskId).toBe(f.id);
  });

  it("a lone Inbox task is complete when shipped: the shipper is unbound and told, graduating stays the owner's call", async () => {
    const inbox = add({ kind: "feature", title: "Inbox", container: true });
    const s = add({ kind: "task", title: "Stray", partOf: inbox.id });
    add({ kind: "task", title: "Another stray", partOf: inbox.id });
    await run("task_bind", { id: s.id });
    const r = await run("task_done", { confirm: false });
    expect(r).toContain(`Stray (${s.id}) is complete; you are no longer bound to it.`);
    expect(r).toContain("ready to graduate on its own");
    expect(r).not.toContain("Bound to next");
    expect(await readBoundTask(den)).toBeNull();
  });
});

describe("durable task tools: binding defaults and rebinds", () => {
  it("binds only one of several tasks created at the same time", async () => {
    const replies = await Promise.all(["A", "B", "C"].map((title) => run("task_create", { kind: "task", domain: "wolfpack", title })));
    expect(replies.filter((r) => r.includes("Bound to it."))).toHaveLength(1);
    expect(replies.filter((r) => r.includes("Not bound: another item is already bound"))).toHaveLength(2);
  });

  it("after a rebind, task_stage without an id acts on the new item and the heads-up names the right ones", async () => {
    const a = add({ kind: "task", title: "First" });
    const b = add({ kind: "task", title: "Second" });
    await run("task_bind", { id: a.id });
    await run("task_bind", { id: b.id });
    const r = await run("task_stage", { to: "approved" });
    expect(items.get(b.id)!.stage).toBe("approved");
    expect(items.get(a.id)!.stage).toBe("plan");
    expect(r).not.toContain("Heads-up");
    expect(await run("task_note", { id: a.id, text: "x" })).toContain(`you're working on "First" (${a.id}) but the bound item is "Second" (${b.id})`);
  });
});
