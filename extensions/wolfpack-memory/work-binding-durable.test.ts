import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTasksExtension, { readBoundTask } from "./unified-tasks.js";

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
const tool = (name: string) => ext.tools!.find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown> = {}) =>
  (await tool(name).execute(args, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 })).content[0].text;
const sectionText = (name: string) => ext.sections!.find((s) => s.name === name)!.render({} as any) as string;

beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "bind-d-"));
  items = new Map();
  n = 0;
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
    expect(sectionText("active_task")).toContain("No work item bound: what you learn now goes to den topics, not to a work item. Bind the item you're working on (task_bind).");
    expect(sectionText("task_tools")).not.toContain("workItem");
  });

  it("task_create binds a new task when nothing is bound (feature = a real parent), and not twice", async () => {
    const f = add({ kind: "feature", title: "F" });
    const r = await run("task_create", { kind: "task", domain: "wolfpack", title: "T1", partOf: f.id });
    expect(r).toContain("Bound to it.");
    expect(readBoundTask(den)).toMatchObject({ taskId: "work-2", featureId: f.id });
    const r2 = await run("task_create", { kind: "task", domain: "wolfpack", title: "T2", partOf: f.id });
    expect(r2).toContain("Not bound: another item is already bound");
    expect(readBoundTask(den)?.taskId).toBe("work-2");
  });

  it("an Inbox task is bound without a feature (it keeps its own Record)", async () => {
    const inbox = add({ kind: "feature", title: "Inbox", container: true });
    await run("task_create", { kind: "task", domain: "wolfpack", title: "Stray", partOf: inbox.id });
    expect(readBoundTask(den)?.featureId).toBeUndefined();
  });

  it("in_build on an unbound item binds it; heads-up on a non-bound item", async () => {
    const a = add({ kind: "task", title: "A", stage: "approved" });
    const b = add({ kind: "task", title: "B" });
    expect(await run("task_stage", { id: a.id, to: "in_build" })).toContain("bound now");
    expect(readBoundTask(den)?.taskId).toBe(a.id);
    const r = await run("task_note", { id: b.id, text: "x" });
    expect(r.split("\n").at(-1)).toContain(`Heads-up: you're working on "B" (${b.id}) but the bound item is`);
    expect(r).toContain(`Call task_bind ${b.id} if you're switching.`);
    expect(await run("task_update", { id: b.id, body: "p" })).toContain("Heads-up");
    expect(await run("task_done", { id: b.id, confirm: false })).toContain("Heads-up");
    expect(readBoundTask(den)?.taskId).toBe(a.id);
  });

  it("unbind clears, current reports it", async () => {
    const a = add({ kind: "task", title: "A" });
    await run("task_bind", { id: a.id });
    expect(await run("task_current")).toContain(`ID: ${a.id}`);
    await run("task_unbind");
    expect(await run("task_current")).toBe("No task currently bound.");
    expect(readBoundTask(den)).toBeNull();
    expect(JSON.parse(readFileSync(join(den, "tasks", "active.json"), "utf8"))).toBeNull();
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
