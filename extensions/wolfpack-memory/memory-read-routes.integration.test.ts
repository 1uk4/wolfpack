/**
 * Read-only memory resources through a real durable wolf over /v1: GET .../memory (status), .../memory/topics/:id and
 * .../work/:id/record, plus the `librarian` flag on the wolf summary. The memory Engine is the stubbed `engine.call`
 * seam; the sandbox root is a temp snapshot with its own local Work server, and a "live" tree is hashed before/after.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "@wolfpack/engine";
import { takeSnapshot } from "@wolfpack/engine";
import { startLocalWorkServer } from "@wolfpack/agent";
import { ErrorEnvelopeSchema, MemoryStatusSchema, MemoryTopicSchema, PROTOCOL_VERSION, WorkRecordResponseSchema, type MemoryEvent } from "@wolfpack/protocol";
import { adaptToDurable } from "../../packages/harness/src/adapters/durable.js";
import { fauxAssistantMessage } from "../../packages/harness/src/wolfd/scripted-model.js";
import { startTestWolf, type TestWolf } from "../../packages/harness/src/wolfd/test-wolf.js";
import { memoryState, readWorkRecord } from "../../packages/harness/src/wolfd/memory-read.js";
import createMemoryExtension from "./unified.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `mread-${p}-`));
  dirs.push(d);
  return d;
};
let tw: TestWolf | undefined;
const aborts: AbortController[] = [];
afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  await tw?.stop();
  tw = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REPLY = "We decided to cache the session lookups for five minutes because the profile endpoint was the hot path.";
const OBS = "Sessions are cached for five minutes because the profile endpoint is the hot path in the load test.";

function stubEngine(): Engine {
  return {
    call: async (step: string, schema: { parse: (v: unknown) => unknown }) => {
      if (step === "classify") return schema.parse({ observations: [{ timestamp: "2026-10-25 10:00", content: OBS }] });
      if (step === "consolidate") {
        return schema.parse({
          actions: [{ sessionTopicId: "x", action: "create", reasoning: "new", result: { id: "caching", title: "Caching", summary: "Session lookups are cached", body: "Cache session lookups for five minutes." } }],
        });
      }
      if (step === "distill") return schema.parse({ contributions: [{ slug: "main", title: "Caching", summary: "Session lookups are cached", body: "## Details\nCache session lookups." }] });
      throw new Error(`unexpected step ${step}`);
    },
  } as unknown as Engine;
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

async function liveAndDev(withKb = false): Promise<{ live: string; dev: string }> {
  const live = tmp("live");
  const work = join(live, "work");
  const srv = await startLocalWorkServer({ ledgerDir: work, token: "live-fixture" });
  await srv.close();
  mkdirSync(join(live, "ops"), { recursive: true });
  mkdirSync(join(live, "den"), { recursive: true });
  let kbBaseDir: string | undefined;
  if (withKb) {
    kbBaseDir = join(live, "kbbase");
    mkdirSync(join(kbBaseDir, "domains/wolfpack/entries"), { recursive: true });
    writeFileSync(join(kbBaseDir, "domains.yaml"), "domains: [wolfpack]\n");
  }
  const dev = join(tmp("dev"), "snap");
  takeSnapshot({ source: { workDir: work, workBaseDir: join(work, "base"), opsDir: join(live, "ops"), denDir: join(live, "den"), ...(kbBaseDir ? { kbBaseDir } : {}) }, devRoot: dev });
  return { live, dev };
}

interface Opts {
  sandbox?: boolean;
  dev?: string;
  yaml?: string;
  memory?: Record<string, unknown>;
}
async function startMemoryWolf(opts: Opts = {}): Promise<TestWolf> {
  const sandbox = opts.sandbox ?? true;
  const kbBase = tmp("kb");
  tw = await startTestWolf({
    script: [fauxAssistantMessage(REPLY)],
    yaml: sandbox ? `sandbox:\n  root: ${opts.dev ?? (await liveAndDev()).dev}\n${opts.yaml ?? ""}` : (opts.yaml ?? ""),
    hooks: {
      extensions: ({ config, den, env }) => [
        adaptToDurable(
          createMemoryExtension(
            { ...config.memory, ...opts.memory, engine: stubEngine() },
            { wolfDen: den, wolfName: "testwolf", domains: ["wolfpack"], wolfConfig: { sandbox: config.sandbox }, env: { ...env, KB_BASE: env.KB_BASE || kbBase } },
          ),
          { wolfDen: den, wolfName: "testwolf" },
        ),
      ],
    },
  });
  return tw;
}

const H = { "X-Protocol-Version": String(PROTOCOL_VERSION) };
const get = (t: TestWolf, path: string) => fetch(`${t.url}${path}`, { headers: H });
const post = (t: TestWolf, action: "consolidate" | "promote") => fetch(`${t.url}/v1/wolves/testwolf/memory/${action}`, { method: "POST", headers: H });

function collect(t: TestWolf): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  const ctl = new AbortController();
  aborts.push(ctl);
  (async () => {
    for await (const e of t.client.watchMemory!("testwolf", { signal: ctl.signal })) events.push(e);
  })().catch(() => {});
  return events;
}
async function waitFor(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const types = (evs: MemoryEvent[]) => evs.map((e) => e.type);
const errorOf = async (res: Response) => ErrorEnvelopeSchema.parse(await res.json());

/** A work item in the sandbox's local Work server, with a document body. */
async function createWorkItem(t: TestWolf, body: string): Promise<string> {
  const sb = t.wolf.sandbox!;
  const h = { "Content-Type": "application/json", "X-API-Key": sb.env.WORK_TOKEN };
  const created = await fetch(`${sb.env.WORK_ENDPOINT}/work`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ kind: "task", domain: "wolfpack", title: "Cache sessions", assignee: "owner", successCriteria: "cached" }),
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const patched = await fetch(`${sb.env.WORK_ENDPOINT}/work/${id}`, { method: "PATCH", headers: h, body: JSON.stringify({ body }) });
  expect(patched.ok).toBe(true);
  return id;
}

describe("memory read routes", { timeout: 30_000 }, () => {
  it("status, topics and the work record reflect a running sandbox wolf; the live tree is untouched", async () => {
    const { live, dev } = await liveAndDev();
    const liveBefore = hashTree(live);
    const t = await startMemoryWolf({ dev });

    // before anything happens: running, empty pool, nothing tracked
    const idle = MemoryStatusSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory")).json());
    expect(idle).toMatchObject({ state: "sandbox", pool: { count: 0, tokens: 0, consolidateAtTokens: 20000, poolTarget: 10000, trigger: "hybrid" }, sessionTopics: [], denTopics: [], lastPromote: null, bound: null });
    expect(idle.reason).toMatch(/sandbox/);

    const events = collect(t);
    await new Promise((r) => setTimeout(r, 100));
    await t.submit("hello");
    await waitFor(() => types(events).includes("observation_captured"));
    const pooled = MemoryStatusSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory")).json());
    expect(pooled.pool).toMatchObject({ count: 1 });
    expect(pooled.pool!.tokens).toBeGreaterThan(0);

    // consolidate -> a session topic, listed and readable
    expect((await post(t, "consolidate")).status).toBe(200);
    const afterC = MemoryStatusSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory")).json());
    expect(afterC.pool!.count).toBe(0);
    expect(afterC.sessionTopics).toEqual([expect.objectContaining({ id: "caching", title: "Caching", summary: "Session lookups are cached" })]);
    const session = MemoryTopicSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory/topics/caching")).json());
    expect(session).toMatchObject({ scope: "session", id: "caching", body: "Cache session lookups for five minutes." });

    // promote -> den topic, lastPromote tracked
    const job = (await (await post(t, "promote")).json()) as { jobId: string };
    await waitFor(() => types(events).includes("promote_finished"));
    const afterP = MemoryStatusSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory")).json());
    expect(afterP.lastPromote).toMatchObject({ jobId: job.jobId, result: "finished", contributions: 1 });
    expect(afterP.denTopics.map((d) => d.id)).toContain("caching");
    const den = MemoryTopicSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory/topics/caching?scope=den")).json());
    expect(den).toMatchObject({ scope: "den", id: "caching", promotable: true });
    // the typed client agrees with the raw routes
    expect(await t.client.getMemoryStatus!("testwolf")).toEqual(afterP);
    expect(await t.client.getMemoryTopic!("testwolf", "caching", { scope: "session" })).toMatchObject({ scope: "session" });

    expect(hashTree(live)).toEqual(liveBefore);
  });

  it("topic lookup: unknown is 404, traversal and bad scope are 400, another wolf's den is never served", async () => {
    const t = await startMemoryWolf();
    await get(t, "/v1/wolves/testwolf/memory");

    const missing = await get(t, "/v1/wolves/testwolf/memory/topics/nope");
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("not_found");

    for (const id of ["..%2F..%2Fsession", "%2Fetc%2Fpasswd", ".hidden", "a%00b"]) {
      const res = await get(t, `/v1/wolves/testwolf/memory/topics/${id}`);
      expect([400, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    }
    expect((await errorOf(await get(t, "/v1/wolves/testwolf/memory/topics/..%2Fx"))).code).toBe("invalid_request");
    expect((await errorOf(await get(t, "/v1/wolves/testwolf/memory/topics/x?scope=all"))).code).toBe("invalid_request");

    // a topic sitting in some other wolf's den (a sibling dir) is invisible, by id and through the status lists
    const otherDen = join(t.wolf.config.den, "..", "other-den");
    mkdirSync(join(otherDen, "memory", "topics"), { recursive: true });
    writeFileSync(join(otherDen, "memory", "topics", "secret.md"), "---\nid: secret\ntitle: Secret\nsummary: s\nupdated: 2026-10-26\n---\nprivate\n");
    expect((await get(t, "/v1/wolves/testwolf/memory/topics/secret")).status).toBe(404);
    expect((await get(t, "/v1/wolves/testwolf/memory")).status).toBe(200);
    expect(MemoryStatusSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory")).json()).denTopics).toEqual([]);
    // and the other wolf's name addresses nothing here
    for (const p of ["/v1/wolves/other/memory", "/v1/wolves/other/memory/topics/secret", "/v1/wolves/other/work/work-x-1234567/record"]) {
      const res = await get(t, p);
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe("not_found");
    }
    // an unknown thread is not_found too
    expect((await get(t, "/v1/wolves/testwolf/memory?thread=other%2Fhome")).status).toBe(404);
  });

  it("memory inert and memory off answer 200 with the state and reason; topics are 409 memory_unavailable", async () => {
    const inert = await startMemoryWolf({ sandbox: false });
    const s = MemoryStatusSchema.parse(await (await get(inert, "/v1/wolves/testwolf/memory")).json());
    expect(s).toMatchObject({ state: "inert", pool: null, sessionTopics: [], denTopics: [], lastPromote: null });
    expect(s.reason).toMatch(/inert/);
    const topic = await get(inert, "/v1/wolves/testwolf/memory/topics/x");
    expect(topic.status).toBe(409);
    expect((await errorOf(topic)).code).toBe("memory_unavailable");
    await inert.stop();
    tw = undefined;

    // no memory extension at all
    tw = await startTestWolf({ script: [fauxAssistantMessage(REPLY)] });
    const off = MemoryStatusSchema.parse(await (await get(tw, "/v1/wolves/testwolf/memory")).json());
    expect(off).toMatchObject({ state: "off", pool: null, bound: null });
    expect(off.reason).toMatch(/not loaded/);
    expect((await errorOf(await get(tw, "/v1/wolves/testwolf/memory/topics/x"))).code).toBe("memory_unavailable");
  });

  it("memory.enabled: false is off; gated or not initialised stays inert", () => {
    const base = { den: "/d", extensionInstalled: true, running: false, config: { sandbox: false, consolidation: { threshold: 1, poolTarget: 1, trigger: "hybrid" as const } } };
    expect(memoryState({ ...base, config: { ...base.config, disabled: true } })).toMatchObject({ state: "off", reason: expect.stringMatching(/enabled: false/) });
    expect(memoryState(base).state).toBe("inert");
  });

  it("a topic id with a space is served when it matches a listed topic", async () => {
    const t = await startMemoryWolf();
    await get(t, "/v1/wolves/testwolf/memory");
    const dir = join(t.wolf.config.den, ".memory", "sessions", "durable");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "my topic.md"), "---\nid: my topic\ntitle: Spacey\nsummary: s\nupdated: 2026-10-26\n---\nbody here\n");
    const topic = MemoryTopicSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory/topics/my%20topic")).json());
    expect(topic).toMatchObject({ id: "my topic", scope: "session", body: "body here" });
  });

  it("memory.live reports state live", async () => {
    const t = await startMemoryWolf({ sandbox: false, yaml: "memory:\n  live: true\n", memory: { live: true } });
    expect(MemoryStatusSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory")).json())).toMatchObject({ state: "live", pool: { count: 0 } });
  });

  it("work record: plan, Record and links through the Work API; unknown item is 404; bound follows the binding file", async () => {
    const t = await startMemoryWolf();
    const id = await createWorkItem(t, "## Plan\n\nDo the caching.\n\n## Record\n\n### Decisions\n\n- Cache five minutes\n\n## Log\n\n- generated\n");

    const res = await get(t, `/v1/wolves/testwolf/work/${id}/record`);
    expect(res.status).toBe(200);
    const rec = WorkRecordResponseSchema.parse(await res.json());
    expect(rec).toMatchObject({ id, title: "Cache sessions", kind: "task", domain: "wolfpack", dependsOn: [] });
    expect(rec.partOf).toMatch(/^work-wolfpack-/); // an unparented item sits under its domain Inbox
    expect(rec.plan).toContain("Do the caching.");
    expect(rec.plan).not.toContain("Cache five minutes");
    expect(rec.plan).not.toContain("generated");
    expect(rec.record).toBe("### Decisions\n\n- Cache five minutes");
    expect(rec.updated).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(await t.client.getWorkRecord!("testwolf", id)).toEqual(rec);

    const none = await createWorkItem(t, "## Plan\n\nonly a plan\n");
    expect(WorkRecordResponseSchema.parse(await (await get(t, `/v1/wolves/testwolf/work/${none}/record`)).json()).record).toBe("");

    const unknown = await get(t, "/v1/wolves/testwolf/work/work-wolfpack-zzzzzzz/record");
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("not_found");
    expect((await errorOf(await get(t, "/v1/wolves/testwolf/work/..%2Fx/record"))).code).toBe("invalid_request");

    // bound: the lineage root's binding file, with title/kind from the Work API; per-thread and default agree
    const cid = t.wolf.conversation.id;
    mkdirSync(join(t.wolf.config.den, "factory", "conversations", cid), { recursive: true });
    writeFileSync(join(t.wolf.config.den, "factory", "conversations", cid, "active-task.json"), JSON.stringify({ workId: id, domain: "wolfpack", boundAt: "2026-10-26T00:00:00.000Z" }));
    const want = { workId: id, title: "Cache sessions", kind: "task" };
    expect(MemoryStatusSchema.parse(await (await get(t, "/v1/wolves/testwolf/memory")).json()).bound).toEqual(want);
    expect((await t.client.getMemoryStatus!("testwolf", { thread: t.home })).bound).toEqual(want);
  });

  it("work record: a feature lists its children (with dependsOn); a task has none; a failing list leaves the record intact", async () => {
    const t = await startMemoryWolf();
    const sb = t.wolf.sandbox!;
    const h = { "Content-Type": "application/json", "X-API-Key": sb.env.WORK_TOKEN };
    const api = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${sb.env.WORK_ENDPOINT}${path}`, { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(r.ok).toBe(true);
      return (await r.json()) as { id: string };
    };
    const feature = (await api("POST", "/work", { kind: "feature", domain: "wolfpack", title: "Cache", assignee: "owner" })).id;
    const mk = async (title: string) => (await api("POST", "/work", { kind: "task", domain: "wolfpack", title, assignee: "owner", successCriteria: "done", partOf: feature })).id;
    const [a, b, c] = [await mk("A"), await mk("B"), await mk("C")];
    await api("PATCH", `/work/${b}`, { link: { rel: "depends_on", target: a } });
    await api("PATCH", `/work/${c}`, { link: { rel: "depends_on", target: b } });

    const rec = WorkRecordResponseSchema.parse(await (await get(t, `/v1/wolves/testwolf/work/${feature}/record`)).json());
    expect(rec.kind).toBe("feature");
    expect(rec.children).toHaveLength(3);
    const byId = new Map(rec.children!.map((x) => [x.id, x]));
    expect(byId.get(a)).toEqual({ id: a, title: "A", kind: "task", stage: expect.any(String), dependsOn: [] });
    expect(byId.get(b)!.dependsOn).toEqual([a]);
    expect(byId.get(c)!.dependsOn).toEqual([b]);
    expect(await t.client.getWorkRecord!("testwolf", feature)).toEqual(rec);

    const task = WorkRecordResponseSchema.parse(await (await get(t, `/v1/wolves/testwolf/work/${c}/record`)).json());
    expect(task.children).toBeUndefined();

    // a container sends only a count; a feature past the cap is cut and flagged
    const many = Array.from({ length: 205 }, (_, i) => ({ id: `work-wolfpack-c${i}`, title: `C${i}`, kind: "task", stage: "idea", dependsOn: [] }));
    const big = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/work?")) res.end(JSON.stringify({ items: many }));
      else if (req.url?.includes("inbox")) res.end(JSON.stringify({ item: { id: "work-wolfpack-inbox", title: "Inbox", kind: "feature", stage: "in_build", container: true }, body: "" }));
      else res.end(JSON.stringify({ item: { id: "work-wolfpack-f", title: "F", kind: "feature", stage: "in_build" }, body: "" }));
    });
    await new Promise<void>((r) => big.listen(0, "127.0.0.1", r));
    try {
      const w = { endpoint: `http://127.0.0.1:${(big.address() as { port: number }).port}`, token: "x" };
      const inbox = await readWorkRecord("work-wolfpack-inbox", w);
      expect(inbox.kind === "ok" && inbox.value).toMatchObject({ container: true, childCount: 205 });
      expect(inbox.kind === "ok" && inbox.value.children).toBeUndefined();
      const capped = await readWorkRecord("work-wolfpack-f", w);
      expect(capped.kind === "ok" && capped.value.children).toHaveLength(200);
      expect(capped.kind === "ok" && capped.value.childrenTruncated).toBe(true);
    } finally {
      await new Promise((r) => big.close(r));
    }

    // the Work API serves the item but fails the list: the record is still returned, without children
    const stub = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/work?")) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "boom" }));
      } else res.end(JSON.stringify({ item: { id: "work-wolfpack-f", title: "F", kind: "feature", stage: "in_build" }, body: "## Plan\n\nx\n" }));
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    try {
      const port = (stub.address() as { port: number }).port;
      const r = await readWorkRecord("work-wolfpack-f", { endpoint: `http://127.0.0.1:${port}`, token: "x" });
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") {
        expect(r.value).toMatchObject({ id: "work-wolfpack-f", kind: "feature", plan: "## Plan\n\nx" });
        expect(r.value.children).toBeUndefined();
      }
    } finally {
      await new Promise((r) => stub.close(r));
    }
  });

  it("work record without a Work API is 409 memory_unavailable", async () => {
    tw = await startTestWolf({ script: [fauxAssistantMessage(REPLY)] });
    const res = await get(tw, "/v1/wolves/testwolf/work/work-wolfpack-abcdefg/record");
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("memory_unavailable");
  });

  it("wolf summaries carry the librarian flag, and KB roots reach the server only with a KB copy", async () => {
    const plain = await startMemoryWolf();
    expect((await plain.client.listWolves())[0]).toMatchObject({ name: "testwolf", librarian: false });
    expect(plain.wolf.kbRoots).toBeUndefined();
    await plain.stop();
    tw = undefined;

    const { dev } = await liveAndDev(true);
    const lib = await startMemoryWolf({ dev, yaml: "memory:\n  librarian: true\n" });
    expect((await lib.client.listWolves())[0]).toMatchObject({ name: "testwolf", librarian: true });
    expect(lib.wolf.kbRoots).toMatchObject({ kbBase: join(dev, "kb-base"), opsRoot: join(dev, "ops") });
  });
});
