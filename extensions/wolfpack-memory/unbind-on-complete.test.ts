import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTasksExtension, { readBoundTask as readBound } from "./unified-tasks.js";
import { bindingFile, readBindingFile, writeBindingFile } from "./conversation-binding.js";
import { unbindCompleted, unbindOnGraduation, writeUnboundNotice } from "@wolfpack/memory";

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
const run = async (name: string, args: Record<string, unknown> = {}, conversationId = 1) =>
  (await tool(name).execute(args, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId })).content[0].text;
const sectionText = (name: string, conversationId = 1) => ext.sections!.find((s) => s.name === name)!.render({ wolfDen: den, wolfName: "1uk4", conversationId } as any) as Promise<string>;

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


const bind = (cid: number, workId: string, featureId?: string) =>
  writeBindingFile(den, cid, { workId, domain: "wolfpack", boundAt: "2026-10-27T00:00:00Z", ...(featureId ? { featureId } : {}) });
const NOTICE = (t: string) => `Your previous work item ${t} is complete and you are unbound. Don't add work to it; new work needs a new or different item (task_create or task_bind).`;

describe("completing a work item unbinds its conversations", () => {
  it("shipping a task unbinds the other conversation bound to it, the shipper binds the next sibling", async () => {
    const f = add({ kind: "feature", title: "F" });
    const t1 = add({ kind: "task", title: "One", partOf: f.id });
    const t2 = add({ kind: "task", title: "Two", partOf: f.id });
    bind(1, t1.id, f.id);
    bind(2, t1.id, f.id); // a second conversation on the same task (e.g. a thread)
    const r = await run("task_done", { confirm: false }, 1);
    expect(r).toContain(`Bound to next: [${t2.id}]`);
    expect(r).toContain(`One (${t1.id}) is complete; you are no longer bound to it.`);
    expect(readBindingFile(den, 1)?.workId).toBe(t2.id);
    expect(readBindingFile(den, 2)).toBeNull();
    const text = await sectionText("active_task", 2);
    expect(text).toContain(NOTICE("One"));
    expect(await sectionText("active_task", 2)).not.toContain("Your previous work item"); // once
  });

  it("a shipper that binds nothing next is told and unbound on ship", async () => {
    const f = add({ kind: "feature", title: "F" });
    const a = add({ kind: "task", title: "A", partOf: f.id });
    add({ kind: "task", title: "B", partOf: f.id });
    bind(1, a.id, f.id);
    const r = await run("task_done", { confirm: false, bindNext: false }, 1);
    expect(r).toContain(`A (${a.id}) is complete; you are no longer bound to it.`);
    expect(readBindingFile(den, 1)).toBeNull();
    expect(await sectionText("active_task", 1)).not.toContain("Your previous work item"); // the result already said it
  });

  it("self-detects a completion that happened outside the wolf", async () => {
    const f = add({ kind: "feature", title: "Feat" });
    const t = add({ kind: "task", title: "Tk", partOf: f.id });
    bind(1, f.id, f.id);
    bind(2, t.id, f.id);
    items.get(f.id)!.stage = "archived"; // graduated via the console / Work API
    items.get(t.id)!.stage = "archived";
    expect(await readBoundTask(den)).toBeNull();
    expect(readBindingFile(den, 1)).toBeNull();
    const s1 = await sectionText("active_task", 1);
    expect(s1).toContain(NOTICE("Feat"));
    expect(await sectionText("active_task", 1)).not.toContain("Your previous work item");
    expect(await sectionText("active_task", 2)).toContain(NOTICE("Tk"));
    expect(readBindingFile(den, 2)).toBeNull();
  });

  it("a task shipped elsewhere inside a feature unbinds its holder on next render; a loose shipped task stays bound", async () => {
    const f = add({ kind: "feature", title: "F" });
    const t = add({ kind: "task", title: "In", partOf: f.id, stage: "shipped" });
    const loose = add({ kind: "task", title: "Loose", stage: "shipped" });
    bind(1, t.id, f.id);
    bind(2, loose.id);
    expect(await sectionText("active_task", 1)).toContain(NOTICE("In"));
    expect(readBindingFile(den, 2)?.workId).toBe(loose.id);
  });

  it("observations after unbinding carry no tag", async () => {
    const f = add({ kind: "feature", title: "F" });
    const t = add({ kind: "task", title: "T", partOf: f.id });
    bind(1, t.id, f.id);
    expect((await readBoundTask(den))?.taskId).toBe(t.id);
    items.get(t.id)!.stage = "archived";
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 30_000 }); // past the completion cache's TTL
    try {
      expect(await readBoundTask(den)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shipped loose task: the shipper and every other holder are unbound and told", async () => {
    const loose = add({ kind: "task", title: "Loose" });
    bind(1, loose.id);
    bind(2, loose.id);
    const r = await run("task_done", { confirm: false }, 1);
    expect(r).toContain(`Loose (${loose.id}) is complete; you are no longer bound to it.`);
    expect(readBindingFile(den, 1)).toBeNull();
    expect(readBindingFile(den, 2)).toBeNull();
    expect(await sectionText("active_task", 2)).toContain(NOTICE("Loose"));
  });

  it("self-detection treats a shipped loose task as complete, and never unbinds on a Work error or timeout", async () => {
    const loose = add({ kind: "task", title: "Loose", stage: "shipped" });
    bind(1, loose.id);
    bind(2, "work-missing"); // a 404
    expect(await readBoundTask(den)).toBeNull();
    vi.stubGlobal("fetch", async () => { throw new DOMException("timed out", "TimeoutError"); });
    expect((await readBound({ wolfDen: den, conversationId: 2 }))?.taskId).toBe("work-missing");
    expect(readBindingFile(den, 2)?.workId).toBe("work-missing");
  });

  it("completion lookups are cached for 10 s; shipping through task_done forgets them", async () => {
    const f = add({ kind: "feature", title: "F" });
    const a = add({ kind: "task", title: "A", partOf: f.id });
    bind(1, a.id, f.id);
    let gets = 0;
    const base = fetchImpl;
    vi.stubGlobal("fetch", (u: string | URL, i?: RequestInit) => { if (!i?.method || i.method === "GET") gets++; return base(u, i); });
    await readBoundTask(den);
    const first = gets;
    await readBoundTask(den);
    await readBoundTask(den);
    expect(gets).toBe(first); // no further Work GETs inside the TTL
  });

  it("task_unbind clears a pending completion notice", async () => {
    const live = add({ kind: "task", title: "Live" });
    bind(1, live.id);
    writeUnboundNotice(den, 1, { workId: "work-old", title: "Old", at: "2026-10-27T00:00:00Z" }); // a stale notice left beside a binding
    await run("task_unbind", {}, 1);
    expect(await sectionText("active_task", 1)).not.toContain("Your previous work item");
  });

  it("task_graduate confirm: unbinds the other holders (feature thread, task), the caller with the complete line, not unrelated ones", async () => {
    const f = add({ kind: "feature", title: "Feat", stage: "shipped" });
    const t = add({ kind: "task", title: "Tk", stage: "shipped", partOf: f.id });
    bind(3, f.id, f.id); // feature thread
    bind(4, t.id, f.id); // a conversation on a task
    bind(5, "work-unrelated");
    bind(1, t.id, f.id); // the caller (a task of the feature)
    // an in-memory graduate endpoint is missing in this fake API: serve the preview + confirm through the real flow
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const token = "abcdef012345";
    mkdirSync(join(den, "tasks", "graduation"), { recursive: true });
    const preview = { itemId: f.id, kind: "feature", title: "Feat", domain: "wolfpack", contributions: [], warnings: [], archive: [], token, createdAt: new Date().toISOString() };
    writeFileSync(join(den, "tasks", "graduation", `${token}.json`), JSON.stringify(preview));
    const base = fetchImpl;
    vi.stubGlobal("fetch", async (u: string | URL, i: RequestInit = {}) => {
      const m = new URL(String(u)).pathname.replace(/^\/work\/?/, "");
      if (i.method === "POST" && m === `${f.id}/graduate`) { items.get(f.id)!.graduated = "2026-10-27"; return json({ item: items.get(f.id) }); }
      return base(u, i);
    });
    ext = createTasksExtension({ kbRoots: { kbBase: join(den, "kbbase"), opsRoot: join(den, "ops"), denLocal: join(den, "kb") } }, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {} });
    const r = await run("task_graduate", { id: f.id, confirm: token }, 1);
    expect(r).toContain("2 item(s) archived");
    expect(r).toContain(`Feat (${f.id}) is complete; you are no longer bound to it.`);
    expect(readBindingFile(den, 1)).toBeNull();
    expect(readBindingFile(den, 3)).toBeNull();
    expect(readBindingFile(den, 4)).toBeNull();
    expect(readBindingFile(den, 5)?.workId).toBe("work-unrelated");
    expect(await sectionText("active_task", 3)).toContain(NOTICE("Feat"));
  });

  it("/task g (the graduation hook) unbinds the invoking conversation too and tells it", async () => {
    bind(1, "work-t", "work-f");
    bind(2, "work-f", "work-f");
    unbindOnGraduation(den, { id: "work-f", title: "Feat", archived: ["work-f", "work-t"] });
    expect(readBindingFile(den, 1)).toBeNull();
    expect(readBindingFile(den, 2)).toBeNull();
    expect(await sectionText("active_task", 1)).toContain(NOTICE("Feat"));
  });

  it("graduation unbinds the feature thread and conversations bound to its tasks, not the caller or others", async () => {
    bind(3, "work-f", "work-f"); // feature thread
    bind(4, "work-t1", "work-f"); // bound to a task of the feature
    bind(5, "work-other", "work-f2");
    bind(6, "work-t2", "work-f"); // the caller
    const gone = unbindCompleted(den, { workIds: ["work-f", "work-t1", "work-t2"], viaFeature: true, title: "Feat", id: "work-f", exceptRoot: 6 });
    expect(gone.sort()).toEqual([3, 4]);
    expect(readBindingFile(den, 6)?.workId).toBe("work-t2");
    expect(readBindingFile(den, 5)?.workId).toBe("work-other");
    expect(await sectionText("active_task", 3)).toContain(NOTICE("Feat"));
  });

  it("the binding guidance says when unbinding happens", async () => {
    expect(await sectionText("task_tools")).toContain("Completing it (shipping a task, graduating a feature) unbinds you automatically");
  });
});
