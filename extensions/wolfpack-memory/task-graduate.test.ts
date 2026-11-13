import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@wolfpack/engine";
import { registerMemoryActions, unregisterMemoryActions } from "@wolfpack/harness/memory";
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
/** The owner's side of the host's card protocol, as the conversation reports it for the newest task_graduate card. */
type Newest = { status: "pending" | "answered"; yes?: boolean; laterTexts?: string[]; card: any } | undefined;
let newest: Newest;
let askCards: boolean;
const conversation = () => ({
  classify: async () => ({ kind: "root" }),
  latestCard: async (tool: string, match: (c: any) => boolean) =>
    newest && newest.card.tool === tool && match(newest.card)
      ? { status: newest.status, card: newest.card, answers: { confirm: { value: newest.yes } }, laterResults: (newest.laterTexts ?? []).map((t) => ({ message: { content: t } })) }
      : undefined,
});
const run = async (args: Record<string, unknown>) =>
  (await tool("task_graduate").execute(args, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1, conversation: conversation() } as never)) as any;
/** Ask (raises the card), then the owner answers on that card, then the agent calls again. */
const askThenAnswer = async (id: string, yes: boolean) => {
  const first = await run({ id });
  newest = { status: "answered", yes, card: first.card };
  return run({ id });
};
const storedTokens = () => {
  const dir = join(den, "tasks", "graduation");
  return existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.json$/, "")) : [];
};
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
  newest = undefined;
  askCards = true;
  ext = createTasksExtension({ engine: () => engine, kbRoots: kb }, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {}, capabilities: { askCards } } as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(den, { recursive: true, force: true });
});

describe("durable task_graduate: the owner's card, never an agent token", () => {
  const ready = () => {
    const f = add({ kind: "feature", title: "F", stage: "shipped", body: "# F\n\n## Plan\n\nx\n\n## Record\n\n### Decisions\n\n- A — why: B\n" });
    const t = add({ kind: "task", title: "T", stage: "shipped", partOf: f.id });
    return { f, t };
  };
  const bindTo = async (f: Item) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(den, "factory", "conversations", "1"), { recursive: true });
    await writeFile(join(den, "factory", "conversations", "1", "active-task.json"), JSON.stringify({ workId: f.id, domain: "wolfpack", boundAt: "now", featureId: f.id }));
  };

  it("a call raises a confirm card showing the preview and sends nothing", async () => {
    const { f } = ready();
    const r = await run({ id: f.id });
    expect(r.card.tool).toBe("task_graduate");
    expect(r.card.fields[0]).toMatchObject({ id: "confirm", kind: "confirm", label: `Graduate "F" (${f.id})?` });
    expect(r.card.fields[0].default).toBeUndefined();
    expect(r.card).toMatchObject({ paged: true, steps: [{ fields: ["confirm"] }] });
    expect(r.card.brief).toBeUndefined();
    expect(r.card.fields[0].description).toContain("The change");
    expect(r.content[0].text).not.toMatch(/confirm "/);
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
  });

  it("a token passed by the agent, even the real one from the preview, graduates nothing", async () => {
    const { f } = ready();
    await run({ id: f.id });
    const [real] = storedTokens();
    expect(real).toHaveLength(12);
    for (const confirm of [real, "abcdef012345"]) {
      const r = await run({ id: f.id, confirm });
      expect(r.card).toBeDefined(); // treated as a fresh request: asks the owner
    }
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
    expect(items.get(f.id)!.stage).toBe("shipped");
  });

  it("while the owner has not answered the card, a repeat call asks nothing new and sends nothing", async () => {
    const { f } = ready();
    const first = await run({ id: f.id });
    newest = { status: "pending", card: first.card };
    const r = await run({ id: f.id });
    expect(r.card).toBeUndefined();
    expect(r.endTurn).toBe(true);
    expect(items.get(f.id)!.graduated).toBeNull();
  });

  it("after the owner's yes on the card, the next call sends the contributions, graduates and archives", async () => {
    const { f, t } = ready();
    call.mockClear();
    const r = await askThenAnswer(f.id, true);
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("1 contribution(s) sent to Dewey; 2 item(s) archived");
    expect(call).toHaveBeenCalledTimes(1); // distilled once, at the first call
    expect(inboxFiles()).toHaveLength(1);
    expect(readFileSync(join(kb.opsRoot, "inbox", "1uk4", inboxFiles()[0]), "utf8")).toContain(`den_topic_id: ${f.id}`);
    expect(items.get(f.id)!.graduated).toBe("2026-10-22");
    expect(items.get(f.id)!.stage).toBe("archived");
    expect(items.get(t.id)!.stage).toBe("archived");
  });

  it("a graduation asks the memory actions to promote the topics sourced from that feature", async () => {
    const { f } = ready();
    const promoted: string[] = [];
    const actions = { promoteEnabled: true, isBusy: () => false, consolidate: async () => ({}) as never, promote: () => ({ status: "already_running", jobId: "x" }) as never, promoteForFeature: async (id: string) => { promoted.push(id); } };
    registerMemoryActions(den, actions);
    try {
      await askThenAnswer(f.id, true);
      await vi.waitFor(() => expect(promoted).toEqual([f.id]));
    } finally {
      unregisterMemoryActions(den, actions);
    }
  });

  it("a yes is spent once it graduated: the same card cannot graduate again", async () => {
    const { f } = ready();
    const first = await run({ id: f.id });
    newest = { status: "answered", yes: true, card: first.card };
    const done = await run({ id: f.id });
    newest.laterTexts = [done.content[0].text];
    await run({ id: f.id });
    expect(inboxFiles()).toHaveLength(1);
  });

  it("after the owner's no on the card, nothing is sent or archived", async () => {
    const { f } = ready();
    const r = await askThenAnswer(f.id, false);
    expect(r.content[0].text).toContain("declined");
    expect(r.card).toBeUndefined();
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
    expect(items.get(f.id)!.stage).toBe("shipped");
  });

  it("a no stays a no for that card, even after an unrelated tool result", async () => {
    const { f } = ready();
    const first = await run({ id: f.id });
    newest = { status: "answered", yes: false, laterTexts: ["ok: some other tool ran"], card: first.card };
    const r = await run({ id: f.id });
    expect(r.card).toBeUndefined();
    expect(r.content[0].text).toContain("declined");
    expect(inboxFiles()).toEqual([]);
  });

  it("a yes on a ship card for the same id sends nothing and asks afresh", async () => {
    const { f } = ready();
    await run({ id: f.id }); // a stored preview exists
    const shipCard = { tool: "task_done", fields: [{ id: "confirm", kind: "confirm", label: `Graduate "F" (${f.id})?` }] };
    newest = { status: "answered", yes: true, card: shipCard };
    const r = await run({ id: f.id });
    expect(r.card.tool).toBe("task_graduate");
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
  });

  it("a yes on the graduate card of another item sends nothing and asks afresh", async () => {
    const { f } = ready();
    const { f: g } = ready();
    const other = await run({ id: g.id });
    newest = { status: "answered", yes: true, card: other.card };
    const r = await run({ id: f.id });
    expect(r.card.fields[0].label).toContain(f.id);
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
  });

  it("a preview replaced between the card and the yes is not sent; the owner is asked again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { f } = ready();
      const first = await run({ id: f.id });
      vi.setSystemTime(Date.now() + 5000);
      newest = undefined;
      call.mockImplementationOnce(async (_s: string, schema: { parse: (v: unknown) => unknown }) =>
        schema.parse({ contributions: [{ slug: "main", title: "A different take", summary: "Changed.", body: "## How\n\nOther.\n\n## History\n\n- 2026-10-22: x (work-wolfpack-T000002)" }] }));
      await run({ id: f.id }); // e.g. the console modal makes a newer, different preview
      newest = { status: "answered", yes: true, card: first.card };
      const r = await run({ id: f.id });
      expect(r.card).toBeDefined();
      expect(inboxFiles()).toEqual([]);
      expect(items.get(f.id)!.graduated).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("two parallel calls before the card lands raise one card", async () => {
    const { f } = ready();
    const rs = await Promise.all([run({ id: f.id }), run({ id: f.id })]);
    expect(rs.filter((r) => r.card)).toHaveLength(1);
    expect(rs.filter((r) => !r.card)[0].endTurn).toBe(true);
  });

  it("where nobody can answer a card, the tool only previews and points to the console", async () => {
    const { f } = ready();
    ext = createTasksExtension({ engine: () => ({ call, usage: { summarize: () => ({}) } }) as unknown as Engine, kbRoots: kb }, { wolfDen: den, wolfName: "1uk4", domains: ["wolfpack"], wolfConfig: {} } as never);
    const r = (await tool("task_graduate").execute({ id: f.id }, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 } as never)) as any;
    expect(r.card).toBeUndefined();
    expect(r.content[0].text).toContain("Graduate button");
    expect(inboxFiles()).toEqual([]);
    expect(items.get(f.id)!.graduated).toBeNull();
  });

  it("an item that is not ready is refused before any card", async () => {
    const { f: g } = ready();
    add({ kind: "task", title: "open", stage: "in_build", partOf: g.id });
    const r = await run({ id: g.id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not ready to graduate");
    expect(r.card).toBeUndefined();
  });

  it("a graduated feature unbinds the session that was bound to it", async () => {
    const { f } = ready();
    await bindTo(f);
    await run({ id: f.id }); // asking alone leaves the binding
    const bound = () => JSON.parse(readFileSync(join(den, "factory", "conversations", "1", "active-task.json"), "utf8"));
    expect(bound().workId).toBe(f.id);
    await askThenAnswer(f.id, true);
    expect(bound()).toBeNull();
  });

  it("an Inbox task graduates alone after the owner's yes", async () => {
    const inbox = add({ kind: "feature", title: "Inbox", container: true });
    const s = add({ kind: "task", title: "Stray fix", stage: "shipped", partOf: inbox.id, body: "# Stray fix\n\nplan\n" });
    expect((await askThenAnswer(s.id, true)).isError).toBeFalsy();
    expect(items.get(s.id)!.graduated).toBe("2026-10-22");
    expect(items.get(inbox.id)!.stage).not.toBe("archived");
  });
});
