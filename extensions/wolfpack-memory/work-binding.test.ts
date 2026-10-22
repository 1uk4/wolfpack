import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The pi host packages aren't installed in the repo: stand-ins for what work-system.ts touches.
vi.mock("@earendil-works/pi-coding-agent", () => ({ defineTool: (t: unknown) => t }));
vi.mock("@earendil-works/pi-ai", () => {
  const t: any = new Proxy(() => ({}), { get: () => t, apply: () => ({}) });
  return { Type: t };
});
vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
  Key: {},
  matchesKey: () => false,
}));

import { initWorkSystem } from "./work-system.js";

// ── an in-memory Work API behind fetch ───────────────────────────────────────

type Item = Record<string, any>;
function fakeWorkApi() {
  const items = new Map<string, Item>();
  let n = 0;
  const add = (o: Item) => {
    const id = `work-${++n}`;
    items.set(id, { id, stage: "plan", log: [], container: false, assignee: "1uk4", domain: "wolfpack", body: null, partOf: null, ...o });
    return items.get(id)!;
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const fetchImpl = async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const m = u.pathname.replace(/^\/work\/?/, "");
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method === "POST" && m === "") {
      const it = add(body);
      return json({ id: it.id, item: it });
    }
    if (init.method === "GET" && m === "") return json({ items: [...items.values()] });
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
  };
  return { items, add, fetchImpl };
}

// ── a fake pi ────────────────────────────────────────────────────────────────

function fakePi() {
  const tools: Record<string, any> = {};
  const handlers: Record<string, (...a: any[]) => any> = {};
  const pi: any = {
    registerTool: (t: any) => { tools[t.name] = t; },
    registerCommand: () => {},
    on: (ev: string, fn: any) => { handlers[ev] = fn; },
    sendUserMessage: () => {},
  };
  return { pi, tools, handlers };
}

let den: string;
let api: ReturnType<typeof fakeWorkApi>;
let h: ReturnType<typeof fakePi>;
const statuses: Array<string | undefined> = [];
const ctx: any = {
  hasUI: true,
  sessionManager: { getSessionId: () => "sess-1" },
  ui: { setStatus: (_k: string, v?: string) => statuses.push(v), setWidget: () => {}, notify: () => {}, confirm: async () => true },
};
const text = (r: any) => r.content[0].text as string;
const run = (name: string, params: Record<string, unknown> = {}) => h.tools[name].execute("call", params, undefined, undefined, ctx);

beforeEach(async () => {
  den = mkdtempSync(join(tmpdir(), "bind-"));
  vi.stubEnv("PI_SUBAGENT_AGENT", ""); // these tests run as the main session
  vi.stubEnv("WOLF_DEN", den);
  vi.stubEnv("WOLF_NAME", "1uk4");
  vi.stubEnv("WORK_ENDPOINT", "http://127.0.0.1:1");
  vi.stubEnv("WORK_TOKEN", "t");
  api = fakeWorkApi();
  vi.stubGlobal("fetch", api.fetchImpl);
  statuses.length = 0;
  h = fakePi();
  initWorkSystem(h.pi, { domains: ["wolfpack"] });
  await h.handlers["session_start"]({}, ctx);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(den, { recursive: true, force: true });
});

const feature = () => api.add({ kind: "feature", title: "The feature" });
const task = (over: Item = {}) => api.add({ kind: "task", title: "A task", ...over });

describe("task_bind / task_unbind / task_current", () => {
  it("binds a task, reports it, and task_current shows it; unbind clears", async () => {
    const t = task();
    expect(text(await run("task_current"))).toContain("No work item bound");
    expect(text(await run("task_bind", { id: t.id }))).toContain(`Bound to: [${t.id}] A task`);
    expect(text(await run("task_current"))).toContain(`ID: ${t.id}`);
    expect(statuses.at(-1)).toContain("⛓ A task");
    expect(text(await run("task_unbind"))).toBe(`Unbound from ${t.id}.`);
    expect(text(await run("task_current"))).toContain("No work item bound");
    expect(statuses.at(-1)).toContain("⛓ unbound");
    expect(text(await run("task_unbind"))).toBe("No work item bound.");
  });

  it("refuses a feature and an unknown id; rebinding says it switched", async () => {
    const f = feature();
    expect((await run("task_bind", { id: f.id })).isError).toBe(true);
    expect((await run("task_bind", { id: "nope" })).isError).toBe(true);
    const a = task({ title: "First" });
    const b = task({ title: "Second" });
    await run("task_bind", { id: a.id });
    expect(text(await run("task_bind", { id: b.id }))).toContain(`Switched from First (${a.id})`);
  });

  it("the binding carries the feature only when the parent is a real feature", async () => {
    const f = feature();
    const inbox = api.add({ kind: "feature", title: "Inbox", container: true });
    const t1 = task({ partOf: f.id });
    const t2 = task({ partOf: inbox.id });
    await run("task_bind", { id: t1.id });
    expect(h.tools["task_current"]).toBeDefined();
    const { readFileSync } = await import("node:fs");
    const file = join(den, "factory", "sessions", "sess-1", "active-task.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ workId: t1.id, featureId: f.id });
    await run("task_bind", { id: t2.id });
    expect(JSON.parse(readFileSync(file, "utf8")).featureId).toBeUndefined();
  });
});

describe("auto-bind", () => {
  it("task_create binds a new task assigned to this wolf when nothing is bound, and says so", async () => {
    const r = text(await run("task_create", { kind: "task", domain: "wolfpack", title: "New one" }));
    expect(r).toContain("Created");
    expect(r).toContain("Bound to it.");
    expect(text(await run("task_current"))).toContain("New one");
  });

  it("does not bind when something is bound, and says why; bind:true overrides", async () => {
    const t = task();
    await run("task_bind", { id: t.id });
    const r = text(await run("task_create", { kind: "task", domain: "wolfpack", title: "Second" }));
    expect(r).toContain("Not bound: another item is already bound");
    expect(text(await run("task_current"))).toContain("A task");
    const r2 = text(await run("task_create", { kind: "task", domain: "wolfpack", title: "Third", bind: true }));
    expect(r2).toContain("Bound to it.");
    expect(text(await run("task_current"))).toContain("Third");
  });

  it("does not bind a feature, an item assigned to someone else, or with bind:false", async () => {
    expect(text(await run("task_create", { kind: "feature", domain: "wolfpack", title: "F" }))).toContain("Not bound");
    expect(text(await run("task_create", { kind: "task", domain: "wolfpack", title: "Hal's", assignee: "hal" }))).toContain("Not bound: it is assigned to hal");
    expect(text(await run("task_create", { kind: "task", domain: "wolfpack", title: "No", bind: false }))).toContain("Not bound: bind was false");
    expect(text(await run("task_current"))).toContain("No work item bound");
  });

  it("staging an item to in_build binds it when nothing is bound", async () => {
    const t = task({ stage: "approved" });
    const r = text(await run("task_stage", { id: t.id, to: "in_build" }));
    expect(r).toContain("→ in_build");
    expect(r).toContain("bound now");
    expect(r).not.toContain("Heads-up");
    expect(text(await run("task_current"))).toContain(t.id);
  });

  it("staging to in_build does not steal the binding", async () => {
    const a = task({ title: "Mine" });
    const b = task({ title: "Other", stage: "approved" });
    await run("task_bind", { id: a.id });
    const r = text(await run("task_stage", { id: b.id, to: "in_build" }));
    expect(r).not.toContain("bound now");
    expect(r).toContain("Heads-up");
    expect(text(await run("task_current"))).toContain(a.id);
  });
});

describe("heads-up on a mismatch", () => {
  it("ends the reply of note / stage / update / done on a non-bound item", async () => {
    const mine = task({ title: "Mine" });
    const other = task({ title: "Other" });
    await run("task_bind", { id: mine.id });
    const line = `Heads-up: you're working on "Other" (${other.id}) but the bound item is "Mine" (${mine.id}). Call task_bind ${other.id} if you're switching.`;
    for (const [tool, p] of [
      ["task_note", { id: other.id, text: "x" }],
      ["task_stage", { id: other.id, to: "approved" }],
      ["task_update", { id: other.id, body: "## Plan\n\np" }],
      ["task_done", { id: other.id }],
    ] as const) {
      const r = text(await run(tool, p as any));
      expect(r.split("\n").at(-1), tool).toBe(line);
    }
    // shipping another item leaves the binding alone
    expect(text(await run("task_current"))).toContain(mine.id);
  });

  it("says the bound item is nothing when nothing is bound", async () => {
    const other = task({ title: "Other" });
    const r = text(await run("task_note", { id: other.id, text: "x" }));
    expect(r).toContain("but the bound item is nothing.");
    expect(r).toContain(`Call task_bind ${other.id} if you're switching.`);
  });

  it("is silent on the bound item, with or without an explicit id", async () => {
    const mine = task({ title: "Mine" });
    await run("task_bind", { id: mine.id });
    expect(text(await run("task_note", { text: "x" }))).not.toContain("Heads-up");
    expect(text(await run("task_note", { id: mine.id, text: "x" }))).not.toContain("Heads-up");
    expect(text(await run("task_update", { body: "b" }))).not.toContain("Heads-up");
  });
});

describe("context", () => {
  it("unbound: the injected context says where learning goes and how to bind", async () => {
    const event: any = { systemPrompt: "BASE", systemPromptOptions: { sections: {} } };
    const r = await h.handlers["before_agent_start"](event, ctx);
    expect(r.systemPrompt).toContain("No work item bound: what you learn now goes to den topics, not to a work item. Bind the item you're working on (task_bind).");
    expect(r.systemPrompt).not.toContain("workItem");
  });

  it("bound: the rules are there and the unbound notice is not", async () => {
    const t = task();
    await run("task_bind", { id: t.id });
    const event: any = { systemPrompt: "BASE", systemPromptOptions: { sections: {} } };
    await h.handlers["before_agent_start"](event, ctx);
    const section = event.systemPromptOptions.sections["active_task"];
    expect(section).toContain("One bound item per session");
    expect(section).not.toContain("No work item bound");
  });

  it("while bound to a task of a feature, the feature's Record is shown", async () => {
    const f = feature();
    f.body = "## Plan\n\nfp\n\n## Record\n\n### Decisions\n\n- Use X — why: Y\n";
    const t = task({ partOf: f.id });
    await run("task_bind", { id: t.id });
    const event: any = { systemPrompt: "BASE", systemPromptOptions: { sections: {} } };
    await h.handlers["before_agent_start"](event, ctx);
    const section = event.systemPromptOptions.sections["active_task"];
    expect(section).toContain("## Feature Record — The feature");
    expect(section).toContain("- Use X — why: Y");
  });
});

describe("subagent sessions (PI_SUBAGENT_AGENT): no binding", () => {
  it("no status, no injected context, no auto-bind, no heads-up; task_bind / task_unbind refuse; other tools work", async () => {
    // The orchestrator's binding, in the shared den.
    const mine = task({ title: "Mine" });
    await run("task_bind", { id: mine.id });
    const { readFileSync } = await import("node:fs");
    const file = join(den, "factory", "sessions", "sess-1", "active-task.json");
    const before = readFileSync(file, "utf8");

    // The subagent child: same den, the env var set before the extension loads.
    vi.stubEnv("PI_SUBAGENT_AGENT", "worker");
    const sub = fakePi();
    initWorkSystem(sub.pi, { domains: ["wolfpack"] });
    statuses.length = 0;
    await sub.handlers["session_start"]({}, ctx);
    await sub.handlers["turn_end"]({}, ctx);
    expect(statuses).toEqual([]); // no ⛓ status, bound or unbound

    const event: any = { systemPrompt: "BASE", systemPromptOptions: { sections: {} } };
    expect(await sub.handlers["before_agent_start"](event, ctx)).toBeUndefined();
    expect(event.systemPromptOptions.sections["active_task"]).toBeUndefined();

    const call = (name: string, p: Record<string, unknown> = {}) => sub.tools[name].execute("call", p, undefined, undefined, ctx);
    for (const [tool, p] of [["task_bind", { id: mine.id }], ["task_unbind", {}]] as const) {
      const r = await call(tool, p as any);
      expect(r.isError, tool).toBe(true);
      expect(text(r)).toBe("Subagents don't bind: the orchestrator owns the binding.");
    }

    // auto-bind paths do not bind, and no heads-up lines
    const created = text(await call("task_create", { kind: "task", domain: "wolfpack", title: "From the subagent" }));
    expect(created).toContain("Created");
    expect(created).not.toMatch(/Bound to it|Not bound/);
    const other = task({ title: "Other", stage: "approved" });
    const staged = text(await call("task_stage", { id: other.id, to: "in_build" }));
    expect(staged).toContain("→ in_build");
    expect(staged).not.toMatch(/bound now|Heads-up/);
    const noted = text(await call("task_note", { id: other.id, text: "found X" }));
    expect(noted).toContain("Logged: found X");
    expect(noted).not.toContain("Heads-up");
    expect(other.log.at(-1).text).toBe("found X"); // other work tools keep working

    // the orchestrator's binding was never touched
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(statuses).toEqual([]);
  });
});
