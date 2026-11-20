import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import createTasksExtension from "./unified-tasks.js";

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
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
    expect(items.get(f.id)!.stage).toBe("shipped");
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
