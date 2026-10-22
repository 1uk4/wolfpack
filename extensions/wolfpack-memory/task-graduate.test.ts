import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import createTasksExtension from "./unified-tasks.js";

// task_graduate on the durable stack: an in-memory Work API behind fetch, a mocked engine, temp dirs.
type Item = Record<string, any>;
let items: Map<string, Item>;
let n: number;
const add = (o: Item) => {
  const id = `work-wolfpack-T${String(++n).padStart(6, "0")}`;
  items.set(id, { id, stage: "plan", log: [], container: false, assignee: "1uk4", domain: "wolfpack", body: null, partOf: null, graduated: null, ...o });
  return items.get(id)!;
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function fetchImpl(url: string | URL, init: RequestInit = {}) {
  const u = new URL(String(url));
  const m = u.pathname.replace(/^\/work\/?/, "");
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (init.method === "GET" && m === "") {
    const partOf = u.searchParams.get("partOf");
    return json({ items: [...items.values()].filter((i) => !partOf || i.partOf === partOf) });
  }
  const graduate = /^(.+)\/graduate$/.exec(m);
  if (init.method === "POST" && graduate) { items.get(graduate[1])!.graduated = "2026-10-22"; return json({ item: items.get(graduate[1]) }); }
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
let call: ReturnType<typeof vi.fn>;
const tool = (name: string) => ext.tools!.find((t) => t.name === name)!;
const run = async (args: Record<string, unknown>) =>
  (await tool("task_graduate").execute(args, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 }));
const inboxFiles = () => {
  const dir = join(kb.opsRoot, "inbox", "1uk4");
  return existsSync(dir) ? readdirSync(dir) : [];
};

beforeEach(() => {
  den = mkdtempSync(join(tmpdir(), "grad-d-"));
  kb = { kbBase: join(den, "kbbase"), opsRoot: join(den, "ops"), denLocal: join(den, "kb") };
  items = new Map();
  n = 0;
  vi.stubEnv("PI_SUBAGENT_AGENT", ""); // these tests run as the main session
  vi.stubEnv("WORK_ENDPOINT", "http://127.0.0.1:1");
  vi.stubEnv("WORK_TOKEN", "t");
  vi.stubGlobal("fetch", fetchImpl);
  call = vi.fn(async (_step: string, schema: { parse: (v: unknown) => unknown }) =>
    schema.parse({
      contributions: [{ slug: "main", title: "The change", summary: "How it works now.", body: "## How\n\nLike this.\n\n## History\n\n- 2026-10-22: changed (work-wolfpack-T000002)" }],
    }));
  const engine = { call, usage: { summarize: () => ({}) } } as unknown as Engine;
  ext = createTasksExtension({ engine: () => engine, kbRoots: kb }, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {} });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(den, { recursive: true, force: true });
});

describe("durable task_graduate: preview, then confirm", () => {
  const ready = () => {
    const f = add({ kind: "feature", title: "F", stage: "shipped", body: "# F\n\n## Plan\n\nx\n\n## Record\n\n### Decisions\n\n- A — why: B\n" });
    const t = add({ kind: "task", title: "T", stage: "shipped", partOf: f.id });
    return { f, t };
  };

  it("the first call returns the preview and a token and sends nothing", async () => {
    const { f } = ready();
    const r = await run({ id: f.id });
    const text = r.content[0].text as string;
    expect(text).toContain('Graduating "F" (feature): 1 contribution');
    expect(text).toContain("1. The change");
    expect(text).toContain("NOTHING HAS BEEN SENT");
    const token = /confirm "([a-f0-9]+)"/.exec(text)![1];
    expect(token).toHaveLength(12);
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
    expect(items.get(f.id)!.stage).toBe("shipped");
  });

  it("confirm with the token sends the contributions, graduates and archives", async () => {
    const { f, t } = ready();
    call.mockClear();
    const token = /confirm "([a-f0-9]+)"/.exec((await run({ id: f.id })).content[0].text as string)![1];
    const r = await run({ id: f.id, confirm: token });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("1 contribution(s) sent to Dewey; 2 item(s) archived");
    expect(call).toHaveBeenCalledTimes(1); // distilled once, at the preview
    expect(inboxFiles()).toHaveLength(1);
    expect(readFileSync(join(kb.opsRoot, "inbox", "1uk4", inboxFiles()[0]), "utf8")).toContain(`den_topic_id: ${f.id}`);
    expect(items.get(f.id)!.graduated).toBe("2026-10-22");
    expect(items.get(f.id)!.stage).toBe("archived");
    expect(items.get(t.id)!.stage).toBe("archived");
    // a token works once
    expect((await run({ id: f.id, confirm: token })).isError).toBe(true);
  });

  it("a confirm without a preview, with another item's token, or for an item that is not ready is refused", async () => {
    const { f } = ready();
    expect((await run({ id: f.id, confirm: "abcdef012345" })).content[0].text).toContain("No such preview");
    const g = add({ kind: "feature", title: "G", stage: "shipped" });
    add({ kind: "task", title: "open", stage: "in_build", partOf: g.id });
    const r = await run({ id: g.id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not ready to graduate");
    const token = /confirm "([a-f0-9]+)"/.exec((await run({ id: f.id })).content[0].text as string)![1];
    expect((await run({ id: g.id, confirm: token })).content[0].text).toContain(`for ${f.id}, not ${g.id}`);
    expect(inboxFiles()).toEqual([]);
  });

  it("a confirmed graduation unbinds the session that was bound to the finished feature", async () => {
    const { f, t } = ready();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(den, "tasks"), { recursive: true });
    await writeFile(join(den, "tasks", "active.json"), JSON.stringify({ taskId: f.id, domain: "wolfpack", boundAt: "now", featureId: f.id }));
    const token = /confirm "([a-f0-9]+)"/.exec((await run({ id: f.id })).content[0].text as string)![1];
    // previewing alone leaves the binding
    expect(JSON.parse(readFileSync(join(den, "tasks", "active.json"), "utf8")).taskId).toBe(f.id);
    await run({ id: f.id, confirm: token });
    expect(JSON.parse(readFileSync(join(den, "tasks", "active.json"), "utf8"))).toBeNull();
    void t;
  });

  it("an Inbox task graduates alone with the same two steps", async () => {
    const inbox = add({ kind: "feature", title: "Inbox", container: true });
    const s = add({ kind: "task", title: "Stray fix", stage: "shipped", partOf: inbox.id, body: "# Stray fix\n\nplan\n" });
    const token = /confirm "([a-f0-9]+)"/.exec((await run({ id: s.id })).content[0].text as string)![1];
    expect((await run({ id: s.id, confirm: token })).isError).toBeFalsy();
    expect(items.get(s.id)!.graduated).toBe("2026-10-22");
    expect(items.get(inbox.id)!.stage).not.toBe("archived");
  });
});
