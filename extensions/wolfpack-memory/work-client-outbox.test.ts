/**
 * WorkClient outbox: writes made while the hub is unreachable are saved on disk and replayed, in order, once it is back.
 * The stub hub below never deduplicates: the client's contract is that every resend of a write carries the key of its first
 * attempt. That a resend with the same key applies once is the hub's contract, tested in packages/hubd/src/hubd.workproxy.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryOutboxLock, WorkClient, WorkQueuedError, WorkStoreReadOnlyError } from "./work-client.js";
import createTasksExtension from "./unified-tasks.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const outbox = () => {
  const d = mkdtempSync(join(tmpdir(), "work-outbox-"));
  dirs.push(d);
  return join(d, "work-outbox");
};

interface Req { method: string; path: string; body: unknown; key: string | undefined }
/**
 * A hub that is down (connection refused) until `up` is set. Every request that reaches it is recorded in `sent`, with no
 * dedup. `answer` decides the reply (default 200); `hang` makes it record the request and then never answer (an answer lost
 * after the hub applied the write).
 */
function hub() {
  const state = {
    up: false,
    hang: false,
    sent: [] as Req[],
    answer: (_r: Req): { status: number; body?: unknown } => ({ status: 200 }),
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (!state.up) throw new TypeError("fetch failed");
    const r: Req = {
      method: init.method ?? "GET",
      path: new URL(url).pathname.replace(/^\/w\/work/, ""),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      key: (init.headers as Record<string, string>)["Idempotency-Key"],
    };
    if (r.method !== "GET") state.sent.push(r);
    if (state.hang) {
      return await new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    const a = state.answer(r);
    return new Response(JSON.stringify(a.body ?? { item: { id: "work-personal-abcd123" }, id: "work-personal-abcd123", items: [] }), { status: a.status });
  });
  return state;
}
const notes = (h: { sent: Req[] }) => h.sent.map((r) => (r.body as { note?: string }).note);
const client = (dir: string, ms = 3000) => new WorkClient("http://hub/w", "tok", ms, dir);
const rejected = (dir: string) => (existsSync(join(dir, "rejected")) ? readdirSync(join(dir, "rejected")).filter((f) => f.endsWith(".json")) : []);

describe("WorkClient outbox", () => {
  it("queues writes while the hub is unreachable and replays them in order, each once, after a restart", async () => {
    const h = hub();
    const dir = outbox();
    const c = client(dir);
    await expect(c.note("work-personal-abcd123", "first")).rejects.toBeInstanceOf(WorkQueuedError);
    await expect(c.create({ kind: "task", domain: "personal", title: "offline", assignee: "1uk4" } as never)).rejects.toBeInstanceOf(WorkQueuedError);
    await expect(c.stage("work-personal-abcd123", "shipped")).rejects.toThrow(/Queued, hub unreachable/);
    expect(h.sent).toEqual([]);

    h.up = true;
    const after = client(dir); // a restarted wolf: only the disk remembers
    await after.note("work-personal-abcd123", "fourth");
    expect(h.sent.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "PATCH", path: "/work-personal-abcd123", body: { note: "first" } },
      { method: "POST", path: "", body: { kind: "task", domain: "personal", title: "offline", assignee: "1uk4" } },
      { method: "PATCH", path: "/work-personal-abcd123", body: { stage: "shipped" } },
      { method: "PATCH", path: "/work-personal-abcd123", body: { note: "fourth" } },
    ]);
    await after.flush();
    await client(dir).flush();
    expect(h.sent).toHaveLength(4);
  });

  it("a write the hub applied but whose answer was lost is resent with the key of its first attempt", async () => {
    const h = hub();
    h.up = true;
    h.hang = true;
    const dir = outbox();
    await expect(client(dir, 50).note("work-personal-abcd123", "landed")).rejects.toBeInstanceOf(WorkQueuedError);
    h.hang = false;
    await client(dir).flush();
    expect(notes(h)).toEqual(["landed", "landed"]);
    expect(h.sent[0]!.key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(h.sent[1]!.key).toBe(h.sent[0]!.key);
  });

  it("a validation error from the hub fails at once and is not saved for later", async () => {
    const h = hub();
    h.up = true;
    h.answer = () => ({ status: 400, body: { error: "stage: bogus is not a stage" } });
    const c = client(outbox());
    const e = await c.stage("work-personal-abcd123", "bogus").catch((x) => x);
    expect(e).not.toBeInstanceOf(WorkQueuedError);
    expect(e.message).toBe("stage: bogus is not a stage");
    expect(c.queued).toBe(0);
    await c.flush();
    expect(h.sent).toHaveLength(1);
  });

  it("429 and an unlabelled 5xx queue the write; a labelled work_store_read_only fails at once and queues nothing", async () => {
    const h = hub();
    h.up = true;
    const c = client(outbox());
    h.answer = () => ({ status: 429, body: { error: "slow down" } });
    await expect(c.note("work-personal-abcd123", "a")).rejects.toBeInstanceOf(WorkQueuedError);
    h.answer = () => ({ status: 502 });
    await expect(c.note("work-personal-abcd123", "b")).rejects.toBeInstanceOf(WorkQueuedError);
    expect(c.queued).toBe(2);

    const d2 = outbox();
    const c2 = client(d2);
    h.answer = () => ({ status: 503, body: { error: "read-only", code: "work_store_read_only" } });
    await expect(c2.note("work-personal-abcd123", "c")).rejects.toBeInstanceOf(WorkStoreReadOnlyError);
    expect(c2.queued).toBe(0);
  });

  it("a new write queues behind a pending one even when the hub would take it, and both go in order later", async () => {
    const h = hub();
    const dir = outbox();
    const c = client(dir);
    await expect(c.note("work-personal-abcd123", "older")).rejects.toBeInstanceOf(WorkQueuedError);
    h.up = true;
    h.answer = (r) => ((r.body as { note?: string }).note === "older" ? { status: 503 } : { status: 200 });
    await expect(c.note("work-personal-abcd123", "newer")).rejects.toBeInstanceOf(WorkQueuedError);
    expect(notes(h)).toEqual(["older"]);
    h.answer = () => ({ status: 200 });
    await c.flush();
    expect(notes(h)).toEqual(["older", "older", "newer"]);
    expect(c.queued).toBe(0);
  });

  it("401 on replay stops the replay and keeps the write for after the token is fixed", async () => {
    const h = hub();
    const dir = outbox();
    const c = client(dir);
    await expect(c.note("work-personal-abcd123", "one")).rejects.toBeInstanceOf(WorkQueuedError);
    await expect(c.note("work-personal-abcd123", "two")).rejects.toBeInstanceOf(WorkQueuedError);
    h.up = true;
    h.answer = () => ({ status: 401, body: { error: "unauthorized" } });
    await c.flush();
    expect(notes(h)).toEqual(["one"]);
    expect(c.queued).toBe(2);
    expect(rejected(dir)).toEqual([]);
    h.answer = () => ({ status: 200 });
    await c.flush();
    expect(notes(h)).toEqual(["one", "one", "two"]);
  });

  it("a write the hub refuses on replay moves to rejected/ and the next one still goes", async () => {
    const h = hub();
    const dir = outbox();
    const c = client(dir);
    await expect(c.note("work-personal-abcd123", "doomed")).rejects.toBeInstanceOf(WorkQueuedError);
    await expect(c.note("work-personal-abcd123", "fine")).rejects.toBeInstanceOf(WorkQueuedError);
    h.up = true;
    h.answer = (r) => ((r.body as { note?: string }).note === "doomed" ? { status: 404, body: { error: "no such item" } } : { status: 200 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await c.flush();
    expect(notes(h)).toEqual(["doomed", "fine"]);
    expect(c.queued).toBe(0);
    expect(rejected(dir)).toHaveLength(1);
  });

  it("clients sharing an outbox replay each write once, and a live holder of flush.lock blocks replay until it is stale", async () => {
    const h = hub();
    const dir = outbox();
    for (const n of ["w1", "w2", "w3", "w4"]) await expect(client(dir).note("work-personal-abcd123", n)).rejects.toBeInstanceOf(WorkQueuedError);
    h.up = true;
    // Another process (alive: our parent) holds the lock: nobody here sends.
    const lock = join(dir, "flush.lock");
    writeFileSync(lock, `${process.ppid}\n`);
    await client(dir).flush();
    expect(notes(h)).toEqual([]);
    // Its holder died: the lock is stale and taken over.
    writeFileSync(lock, "2147483646\n");
    await Promise.all([client(dir).flush(), client(dir).flush(), client(dir).flush()]);
    expect(notes(h)).toEqual(["w1", "w2", "w3", "w4"]);
    // A live holder that has held it over 2 minutes is stale too.
    h.up = false;
    await expect(client(dir).note("work-personal-abcd123", "w5")).rejects.toBeInstanceOf(WorkQueuedError);
    h.up = true;
    writeFileSync(lock, `${process.ppid}\n`);
    const old = (Date.now() - 3 * 60_000) / 1000;
    utimesSync(lock, old, old);
    await client(dir).flush();
    expect(notes(h)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
  });

  it("an empty lock file (a holder still writing it, or torn) is only taken over once it is more than 5 s old", async () => {
    const h = hub();
    const dir = outbox();
    await expect(client(dir).note("work-personal-abcd123", "w1")).rejects.toBeInstanceOf(WorkQueuedError);
    h.up = true;
    const lock = join(dir, "flush.lock");
    writeFileSync(lock, "");
    await client(dir).flush();
    expect(notes(h)).toEqual([]);
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(lock, old, old);
    await client(dir).flush();
    expect(notes(h)).toEqual(["w1"]);
  });

  it("two takeovers of one stale lock, interleaved, leave exactly one holder", () => {
    const dir = outbox();
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, "flush.lock");
    writeFileSync(lock, "2147483646\nstale-token\n"); // its holder died
    let b: (() => void) | undefined;
    // A inspects the stale lock; before A acts, B inspects it too, takes it over and holds a fresh lock.
    const a = tryOutboxLock(dir, { beforeTakeover: () => { b = tryOutboxLock(dir); } });
    expect([a === undefined, b === undefined]).toEqual([true, false]);
    const held = readFileSync(lock, "utf8");
    expect(tryOutboxLock(dir)).toBeUndefined(); // B's live lock still stands
    expect(readFileSync(lock, "utf8")).toBe(held);
    b!();
    expect(existsSync(lock)).toBe(false);
  });

  it("a write the hub fails with a 500 on every replay, 30 s or more apart, is dead-lettered after 20 tries; rapid retries, no answer or a 503 never dead-letter", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = hub();
    const dir = outbox();
    await expect(client(dir).note("work-personal-abcd123", "poison")).rejects.toBeInstanceOf(WorkQueuedError);
    await expect(client(dir).note("work-personal-abcd123", "behind")).rejects.toBeInstanceOf(WorkQueuedError);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 30; i++) await client(dir).flush(); // hub down: no answer, never counted
    h.up = true;
    h.answer = () => ({ status: 503 });
    for (let i = 0; i < 30; i++) await client(dir).flush();
    expect(client(dir).queued).toBe(2);
    h.answer = (r) => ((r.body as { note?: string }).note === "poison" ? { status: 500, body: { error: "boom" } } : { status: 200 });
    for (let i = 0; i < 25; i++) {
      await client(dir).flush(); // 25 failures within 30 s count as one
      now += 1000;
    }
    expect(client(dir).queued).toBe(2);
    for (let i = 0; i < 18; i++) {
      now += 30_000;
      await client(dir).flush();
    }
    expect(client(dir).queued).toBe(2);
    expect(rejected(dir)).toEqual([]);
    now += 30_000;
    await client(dir).flush();
    expect(rejected(dir)).toHaveLength(1);
    expect(client(dir).queued).toBe(0);
    expect(notes(h).filter((n) => n === "behind")).toEqual(["behind"]);
  });

  it("a flush removes temp files of a save that crashed over a minute ago and leaves a fresh one", async () => {
    const h = hub();
    h.up = true;
    const dir = outbox();
    const c = client(dir);
    mkdirSync(dir, { recursive: true });
    const old = join(dir, ".crashed.tmp");
    const fresh = join(dir, ".inflight.tmp");
    writeFileSync(old, "{");
    writeFileSync(fresh, "{");
    const t = (Date.now() - 2 * 60_000) / 1000;
    utimesSync(old, t, t);
    await c.flush();
    expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
  });

  it("a task tool reports a write made while the hub is down as queued, not failed", async () => {
    hub();
    const den = mkdtempSync(join(tmpdir(), "work-outbox-den-"));
    dirs.push(den);
    vi.stubEnv("PI_SUBAGENT_AGENT", "");
    const ext = createTasksExtension({}, { wolfDen: den, wolfName: "1uk4", domains: ["personal"], wolfConfig: {}, env: { WORK_ENDPOINT: "http://hub/w", WORK_TOKEN: "tok" } as never });
    const note = ext.tools!.find((t) => t.name === "task_note")!;
    const r = await note.execute({ id: "work-personal-abcd123", text: "while down" }, { cwd: den, wolfDen: den, wolfName: "1uk4", conversationId: 1 } as never);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Queued, hub unreachable/);
  });
});

