import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import createTasksExtension from "./unified-tasks.js";
import { registerThreadRunningCheck, unregisterThreadRunningCheck } from "@wolfpack/harness/memory";

// task_graduate and task_stage(archived) never act: they file an owner-approval request on the hub.
// Two in-memory servers behind fetch: the Work API (/work) and the hub's request route (/v1/work/:id/requests).
type Item = Record<string, any>;
let items: Map<string, Item>;
let n: number;
const add = (o: Item) => {
  const id = `work-wolfpack-T${String(++n).padStart(6, "0")}`;
  items.set(id, { id, stage: "plan", log: [], container: false, assignee: "1uk4", domain: "wolfpack", body: null, partOf: null, graduated: null, ...o });
  return items.get(id)!;
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

/** What the hub's requests route answers next: 201 files, 409 names the pending one, anything else is a refusal; "down" = unreachable. */
let hub: 201 | 409 | 403 | 500 | "down";
let filed: { path: string; auth: string | null; body: any }[];

async function fetchImpl(url: string | URL, init: RequestInit = {}) {
  const u = new URL(String(url));
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const req = /^\/v1\/work\/([^/]+)\/requests$/.exec(u.pathname);
  if (req) {
    if (hub === "down") throw new TypeError("fetch failed");
    filed.push({ path: u.pathname, auth: new Headers(init.headers).get("authorization"), body });
    if (hub === 201) return json({ request: { id: "req-new", workId: req[1], kind: body.kind } }, 201);
    if (hub === 409) return json({ error: "already pending", code: "request_pending", details: { requestId: "req-old" } }, 409);
    return json({ error: "refused", code: "request_forbidden" }, hub);
  }
  const m = u.pathname.replace(/^\/work\/?/, "");
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
let kb: { kbBase: string; opsRoot: string; denLocal: string };
let ext: ReturnType<typeof createTasksExtension>;
const tool = (name: string) => ext.tools!.find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown>) =>
  (await tool(name).execute(args, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 } as never)) as any;
const inboxFiles = () => {
  const dir = join(kb.opsRoot, "inbox", "1uk4");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const ready = () => {
  const f = add({ kind: "feature", title: "F", stage: "shipped", body: "# F\n\n## Plan\n\nx\n\n## Record\n\n### Decisions\n\n- A — why: B\n" });
  add({ kind: "task", title: "T", stage: "shipped", partOf: f.id });
  return f;
};

beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "grad-d-"));
  kb = { kbBase: join(den, "kbbase"), opsRoot: join(den, "ops"), denLocal: join(den, "kb") };
  items = new Map();
  n = 0;
  hub = 201;
  filed = [];
  vi.stubEnv("PI_SUBAGENT_AGENT", ""); // these tests run as the main session
  vi.stubEnv("WORK_ENDPOINT", "http://127.0.0.1:1");
  vi.stubEnv("WORK_TOKEN", "t");
  vi.stubEnv("WOLFPACK_HUB_URL", "http://hub.test");
  vi.stubEnv("WOLFPACK_HUB_TOKEN", "hub-secret");
  vi.stubGlobal("fetch", fetchImpl);
  const call = vi.fn(async (_step: string, schema: { parse: (v: unknown) => unknown }) =>
    schema.parse({
      summary: "The KB gains how the change works now.",
      contributions: [{ slug: "main", title: "The change", summary: "How it works now.", body: "## How\n\nLike this.\n\n## History\n\n- 2026-10-22: changed (work-wolfpack-T000002)" }],
    }));
  const engine = { call, usage: { summarize: () => ({}) } } as unknown as Engine;
  ext = createTasksExtension({ engine: () => engine, kbRoots: kb, workLog: "fold" }, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {}, capabilities: { askCards: true } } as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(den, { recursive: true, force: true });
});

describe("task_graduate files an owner-approval request and never graduates", () => {
  it("files the request with the preview set, names its id, and sends nothing", async () => {
    const f = ready();
    const r = await run("task_graduate", { id: f.id });
    expect(r.isError).toBeUndefined();
    expect(r.card).toBeUndefined();
    expect(r.content[0].text).toContain(`Queued for the owner's approval: request req-new for ${f.id}, 1 contributions. Nothing is sent until the owner approves it from the thread card, the Work page or Needs-you.`);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ path: `/v1/work/${f.id}/requests`, auth: "Bearer hub-secret", body: { kind: "graduate", wolf: "1uk4" } });
    expect(filed[0].body.preview.contributions).toMatchObject([{ title: "The change" }]);
    expect(filed[0].body.preview.summary).toBe("The KB gains how the change works now.");
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
    expect(items.get(f.id)!.stage).toBe("shipped");
  });

  it("answers a clear thread-still-running error and files nothing while the feature's thread is busy; files again once idle", async () => {
    const f = ready();
    let busy: string | undefined = "a turn is in progress";
    const check = (id: string) => (id === f.id ? busy : undefined);
    registerThreadRunningCheck(den, check);
    try {
      const refused = await run("task_graduate", { id: f.id });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("thread still running: a turn is in progress");
      expect(filed).toEqual([]);
      busy = undefined;
      expect((await run("task_graduate", { id: f.id })).isError).toBeUndefined();
      expect(filed).toHaveLength(1);
    } finally {
      unregisterThreadRunningCheck(den, check);
    }
  });

  it("a request already pending returns the existing id, not a second request", async () => {
    const f = ready();
    hub = 409;
    const r = await run("task_graduate", { id: f.id });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Already queued for the owner's approval: request req-old");
    expect(items.get(f.id)!.graduated).toBeNull();
  });

  it.each([
    ["the hub refuses (403)", 403],
    ["the hub fails (500)", 500],
    ["the hub is unreachable", "down"],
  ] as const)("when %s it is an error and never says the owner was asked", async (_name, mode) => {
    const f = ready();
    hub = mode;
    const r = await run("task_graduate", { id: f.id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("the owner has not been asked");
    expect(r.content[0].text).not.toMatch(/^Queued/);
    expect(items.get(f.id)!.graduated).toBeNull();
  });

  it("on a wolf with only the Work env, files the request on the hub behind the Work endpoint with the Work token", async () => {
    const f = ready();
    vi.stubEnv("WOLFPACK_HUB_URL", "");
    vi.stubEnv("WOLFPACK_HUB_TOKEN", "");
    vi.stubEnv("WORK_ENDPOINT", "http://hub.test/v1/workapi");
    vi.stubEnv("WORK_TOKEN", "work-secret");
    const r = await run("task_graduate", { id: f.id });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Queued for the owner's approval: request req-new");
    expect(filed).toMatchObject([{ path: `/v1/work/${f.id}/requests`, auth: "Bearer work-secret" }]);
  });

  it("with no hub configured it is an error", async () => {
    const f = ready();
    vi.stubEnv("WOLFPACK_HUB_URL", "");
    const r = await run("task_graduate", { id: f.id });
    expect(r.isError).toBe(true);
    expect(filed).toEqual([]);
  });
});

describe("task_stage to archived files an archive request instead of archiving", () => {
  it("files kind archive, leaves the stage, and says it is queued", async () => {
    const t = add({ kind: "task", title: "Old", stage: "shipped" });
    const r = await run("task_stage", { to: "archived", id: t.id });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain(`Queued for the owner's approval: request req-new for ${t.id}, archive.`);
    expect(filed).toMatchObject([{ path: `/v1/work/${t.id}/requests`, body: { kind: "archive", wolf: "1uk4" } }]);
    expect(items.get(t.id)!.stage).toBe("shipped");
  });

  it("is an error when the request cannot be filed", async () => {
    const t = add({ kind: "task", title: "Old", stage: "shipped" });
    hub = 403;
    const r = await run("task_stage", { to: "archived", id: t.id });
    expect(r.isError).toBe(true);
    expect(items.get(t.id)!.stage).toBe("shipped");
  });

  it("other stages still move the item directly", async () => {
    const t = add({ kind: "task", title: "Work", stage: "plan" });
    await run("task_stage", { to: "approved", id: t.id });
    expect(items.get(t.id)!.stage).toBe("approved");
    expect(filed).toEqual([]);
  });
});

describe("task_graduate ids: one multi-select card for several finished items", () => {
  const cardCtx = { cwd: "", wolfDen: "", wolfName: "1uk4", conversationId: 1, conversation: { latestCard: () => undefined, classify: async () => ({ kind: "main" }) } };
  const withCards = () => {
    ext = createTasksExtension({ engine: () => ({ call: vi.fn(async (_s: string, schema: { parse: (v: unknown) => unknown }) => schema.parse({ summary: "The KB gains how the change works now.", contributions: [{ slug: "main", title: "The change", summary: "How it works now.", body: "## How\n\nLike this.\n\n## History\n\n- 2026-10-22: changed (work-wolfpack-T000002)" }] })), usage: { summarize: () => ({}) } }) as unknown as Engine, kbRoots: kb, workLog: "fold" }, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {}, capabilities: { askCards: true } } as never);
  };
  const runCard = async (args: Record<string, unknown>, conversation: unknown = cardCtx.conversation) => (await tool("task_graduate").execute(args, { ...cardCtx, conversation, cwd: den, wolfDen: den } as never)) as any;
  const shippedFeature = (title: string, updated: string) => {
    const f = add({ kind: "feature", title, stage: "shipped", updated, body: "# F\n\n## Plan\n\nx\n\n## Record\n\n### Decisions\n\n- A — why: B\n" });
    add({ kind: "task", title: "T", stage: "shipped", partOf: f.id });
    return f;
  };

  it("raises one picked card: features first, newest first, loose named items last; open ones reported, nothing filed", async () => {
    withCards();
    const old = shippedFeature("Old feature", "2026-11-01");
    const fresh = shippedFeature("Fresh feature", "2026-11-20");
    const loose = add({ kind: "task", title: "Loose task", stage: "shipped", updated: "2026-11-24" });
    const open = add({ kind: "feature", title: "Open feature" });
    add({ kind: "task", title: "Open T", stage: "plan", partOf: open.id });
    const r = await runCard({ ids: [loose.id, old.id, open.id, fresh.id], named: [loose.id] });
    expect(r.isError).toBeUndefined();
    expect(r.card.tool).toBe("task_graduate");
    expect(r.card.meta).toEqual({ wolf: "1uk4", via: "card" });
    expect(r.card.fields).toHaveLength(1);
    expect(r.card.fields[0]).toMatchObject({ id: "picked", kind: "multi" });
    expect(r.card.fields[0].options.map((o: any) => o.value)).toEqual([fresh.id, old.id, loose.id]);
    expect(r.card.fields[0].options[0]).toMatchObject({
      label: "Fresh feature",
      description: "The KB gains how the change works now.",
      href: `/work/${fresh.id}?view=graduation&wolf=1uk4`,
    });
    expect(r.content[0].text).toContain(`${open.id}: not eligible (1 task open)`);
    expect(filed).toEqual([]);
  });

  it("a loose item the owner did not name is not eligible when gathering; named, it is", async () => {
    withCards();
    const f = shippedFeature("F", "2026-11-01");
    const loose = add({ kind: "task", title: "Loose task", stage: "shipped", updated: "2026-11-24" });
    const r = await runCard({ ids: [f.id, loose.id] });
    expect(r.card.fields[0].options.map((o: any) => o.value)).toEqual([f.id]);
    expect(r.content[0].text).toContain(`${loose.id}: not eligible (a loose task graduates only when the owner names it)`);
    const named = await runCard({ ids: [f.id, loose.id], named: [loose.id] });
    expect(named.card.fields[0].options.map((o: any) => o.value)).toEqual([f.id, loose.id]);
  });

  it("orders by finish time, not by the date text: an offset timestamp sorts by the instant it names", async () => {
    withCards();
    const early = shippedFeature("Early", "2026-11-21T23:30:00+14:00"); // 09:30Z
    const late = shippedFeature("Late", "2026-11-21T12:00:00Z");
    const r = await runCard({ ids: [early.id, late.id] });
    expect(r.card.fields[0].options.map((o: any) => o.value)).toEqual([late.id, early.id]);
  });

  it("a subagent conversation never raises a card: it files requests instead", async () => {
    withCards();
    const a = shippedFeature("A", "2026-11-01");
    const r = await runCard({ ids: [a.id] }, { latestCard: () => undefined, classify: async () => ({ kind: "task" }) });
    expect(r.card).toBeUndefined();
    expect(filed.map((x) => x.path)).toEqual([`/v1/work/${a.id}/requests`]);
  });

  it("reconcile tells graduated, picked-but-not-graduated, not picked, and unreadable apart", async () => {
    withCards();
    const a = shippedFeature("A", "2026-11-01");
    const b = shippedFeature("B", "2026-11-02");
    const c = shippedFeature("C", "2026-11-03");
    items.get(a.id)!.graduated = "2026-11-25";
    const answered = { status: "answered", card: { fields: [{ id: "picked", kind: "multi", options: [a.id, b.id, c.id].map((value) => ({ value })) }] }, answers: { picked: { value: [a.id, b.id] } }, laterResults: [] };
    const conv = { latestCard: async () => answered, classify: async () => ({ kind: "main" }) };
    const r = await runCard({ ids: [a.id, b.id, c.id, "work-wolfpack-Nope000"], reconcile: true }, conv);
    const t = r.content[0].text;
    expect(r.card).toBeUndefined();
    expect(t).toContain(`${a.id}: graduated`);
    expect(t).toContain(`${b.id}: picked but NOT graduated`);
    expect(t).toContain(`${c.id}: not picked`);
    expect(t).toContain("work-wolfpack-Nope000: could not be checked");
  });

  it("with no card surface files one approval request per eligible id", async () => {
    const a = shippedFeature("A", "2026-11-01");
    const b = shippedFeature("B", "2026-11-02");
    const r = await run("task_graduate", { ids: [a.id, b.id] });
    expect(r.card).toBeUndefined();
    expect(filed.map((x) => x.path).sort()).toEqual([`/v1/work/${a.id}/requests`, `/v1/work/${b.id}/requests`].sort());
  });
});
