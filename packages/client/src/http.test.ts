import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubServer } from "@wolfpack/protocol/stub";
import { PROTOCOL_VERSION_HEADER } from "@wolfpack/protocol";
import {
  BusyError,
  HttpConsoleClient,
  NotFoundError,
  ProtocolError,
  type SnapshotEvent,
} from "./index.js";
import { collect, homeThread, runBehaviours } from "./behaviours.js";

// Fresh stub per test: threads (and running turns) are stateful.
let stub: StubServer;
let url = "";
beforeEach(async () => {
  stub = new StubServer({ delayMs: 5 });
  url = await stub.listen();
});
afterEach(() => stub.close());

const make = (opts: Partial<ConstructorParameters<typeof HttpConsoleClient>[0]> = {}) =>
  new HttpConsoleClient({ baseUrl: url, retryDelayMs: 5, ...opts });

runBehaviours("http ↔ stub", () => make());

/** Wraps fetch so the first stream response dies (network error) after `frames` SSE frames. */
function dropFirstStream(frames: number, calls: Request[] = []): typeof fetch {
  let dropped = false;
  return async (input, init) => {
    const res = await fetch(input, init);
    calls.push(new Request(input as string, init));
    if (dropped || !String(input).endsWith("/stream") || !res.body) return res;
    dropped = true;
    const reader = res.body.getReader();
    let seen = 0;
    const dec = new TextDecoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (seen >= frames) {
          await reader.cancel();
          return c.error(new TypeError("terminated"));
        }
        const { done, value } = await reader.read();
        if (done) return c.close();
        seen += (dec.decode(value, { stream: true }).match(/\n\n/g) ?? []).length;
        c.enqueue(value);
      },
    });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

function sseResponse(frames: string[]): Response {
  return new Response(frames.map((f) => `${f}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("HttpConsoleClient", () => {
  it("sends the protocol version header on every request", async () => {
    const seen: (string | null)[] = [];
    const c = make({
      fetch: async (input, init) => {
        seen.push(new Headers(init?.headers).get(PROTOCOL_VERSION_HEADER));
        return fetch(input, init);
      },
    });
    const id = await homeThread(c);
    await c.getThread(id);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((v) => v === "1")).toBe(true);
  });

  it("auto-resumes across a dropped connection without gaps or duplicates", async () => {
    const plain = make();
    const id = await homeThread(plain);
    await plain.submit(id, "go");
    const reference = await collect(plain.watch(id));

    await plain.submit(id, "again");
    const calls: Request[] = [];
    const c = make({ fetch: dropFirstStream(4, calls) });
    const events = await collect(c.watch(id));
    const streams = calls.filter((r) => r.url.endsWith("/stream"));
    expect(streams.length).toBeGreaterThanOrEqual(2);
    expect(streams[1].headers.get("Last-Event-ID")).not.toBeNull();
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1] + 1);
    expect(events[0].type).toBe("turn-start");
    expect(events.at(-1)?.type).toBe("turn-end");
    expect(events.length).toBe(reference.length);
  });

  it("gives up with a retryable ProtocolError after bounded retries", async () => {
    const c = make({
      maxStreamRetries: 2,
      fetch: async (input) => {
        if (String(input).endsWith("/stream")) throw new TypeError("fetch failed");
        return fetch(input);
      },
    });
    const id = await homeThread(c);
    await expect(collect(c.watch(id))).rejects.toMatchObject({ name: "ProtocolError", code: "engine_error", retryable: true });
  });

  it("folds a snapshot on a stale cursor: onSnapshot fires, events continue", async () => {
    const c = make();
    const id = await homeThread(c);
    await c.submit(id, "first");
    await collect(c.watch(id));
    await c.submit(id, "second"); // new turn clears the replay buffer
    const seq = (await c.getThread(id)).lastEventId;
    const snaps: SnapshotEvent[] = [];
    const events = await collect(c.watch(id, { from: 0, onSnapshot: (s) => snaps.push(s) }));
    expect(snaps).toHaveLength(1);
    expect(snaps[0].upToId).toBeGreaterThanOrEqual(1);
    expect(snaps[0].thread.id).toBe(id);
    expect(events.every((e) => (e.type as string) !== "snapshot")).toBe(true);
    expect(events.every((e) => e.id > snaps[0].upToId)).toBe(true);
    expect(events.at(-1)?.type).toBe("turn-end");
    expect(seq).toBeGreaterThan(0);
  });

  it("skips unknown event types and throws on invalid known events", async () => {
    const ev = (o: object) => JSON.stringify({ id: 1, threadId: "t", at: "2026-01-01T00:00:00Z", actor: { id: "w", kind: "wolf" }, ...o });
    const good = ev({ type: "turn-start", turnId: "a" });
    const unknown = JSON.stringify({ ...JSON.parse(ev({ type: "from-the-future", x: 1 })), id: 2 });
    const end = JSON.stringify({ ...JSON.parse(ev({ type: "turn-end", turnId: "a", reason: "complete" })), id: 3 });
    const c = new HttpConsoleClient({
      baseUrl: "http://x",
      fetch: async () => sseResponse([`id: 1\ndata: ${good}`, `id: 2\ndata: ${unknown}`, `id: 3\ndata: ${end}`, "data: [DONE]"]),
    });
    expect((await collect(c.watch("t"))).map((e) => e.type)).toEqual(["turn-start", "turn-end"]);

    const bad = JSON.stringify({ ...JSON.parse(ev({ type: "text-delta", turnId: "a" })), id: 2 }); // missing text
    const c2 = new HttpConsoleClient({
      baseUrl: "http://x",
      fetch: async () => sseResponse([`id: 1\ndata: ${good}`, `id: 2\ndata: ${bad}`]),
    });
    await expect(collect(c2.watch("t"))).rejects.toMatchObject({ name: "ProtocolError", code: "invalid_request" });
  });

  it("maps error envelopes by code", async () => {
    const c = make();
    const id = await homeThread(c);
    await c.submit(id, "one");
    await expect(c.submit(id, "two")).rejects.toBeInstanceOf(BusyError);
    await collect(c.watch(id));
    await expect(c.getThread("nope/missing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(c.listThreads("no-such-wolf")).rejects.toBeInstanceOf(NotFoundError);

    const old = make({
      fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as object), [PROTOCOL_VERSION_HEADER]: "99" } }),
    });
    await expect(old.listWolves()).rejects.toMatchObject({ name: "ProtocolError", code: "version_mismatch" });
    await expect(old.listWolves()).rejects.toBeInstanceOf(ProtocolError);
  });

  it("maps by envelope code even when the HTTP status disagrees", async () => {
    const c = new HttpConsoleClient({
      baseUrl: "http://x",
      fetch: async () => new Response(JSON.stringify({ code: "busy", message: "m", retryable: true }), { status: 500 }),
    });
    await expect(c.submit("t", "x")).rejects.toBeInstanceOf(BusyError);
  });

  it("submit always sends an explicit whenBusy (default reject)", async () => {
    const bodies: unknown[] = [];
    const c = new HttpConsoleClient({
      baseUrl: "http://x",
      fetch: async (_i, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ messageId: "m", disposition: "started" }), { status: 200 });
      },
    });
    await c.submit("a/b", "hi");
    await c.submit("a/b", "hi", { whenBusy: "steer" });
    expect(bodies).toEqual([
      { input: "hi", whenBusy: "reject" },
      { input: "hi", whenBusy: "steer" },
    ]);
  });
});

describe("memory actions", () => {
  it("map the stub's inert wolf to ProtocolError memory_unavailable", async () => {
    const c = make();
    const wolf = (await c.listWolves())[0].name;
    await expect(c.consolidateMemory(wolf)).rejects.toMatchObject({ name: "ProtocolError", code: "memory_unavailable" });
    await expect(c.promoteMemory(wolf)).rejects.toMatchObject({ code: "memory_unavailable" });
    await expect(c.promoteMemory("nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  it("promote: 202 started and already_running resolve, 409 envelope rejects", async () => {
    const replies = [
      json(202, { jobId: "j1", status: "started" }),
      json(202, { jobId: "j1", status: "already_running" }),
      json(409, { code: "promote_unavailable", message: "no kb roots", retryable: false }),
    ];
    const c = make({ fetch: (async () => replies.shift()!) as typeof fetch });
    expect(await c.promoteMemory("w")).toEqual({ jobId: "j1", status: "started" });
    expect(await c.promoteMemory("w")).toEqual({ jobId: "j1", status: "already_running" });
    await expect(c.promoteMemory("w")).rejects.toMatchObject({ code: "promote_unavailable" });
  });

  it("consolidate parses the response", async () => {
    const body = { observationsProcessed: 2, topicsCreated: 1, topicsMerged: 0, topicsSkipped: 0, claimsSubmitted: 0, topicIds: ["a"] };
    const c = make({ fetch: (async () => json(200, body)) as typeof fetch });
    expect(await c.consolidateMemory("w")).toEqual(body);
  });
});

describe("unknown error codes", () => {
  it("keep the server's message and retryable flag as a generic engine_error", async () => {
    const reply = () => new Response(JSON.stringify({ code: "from_the_future", message: "try again soon", retryable: true }), { status: 409, headers: { "Content-Type": "application/json" } });
    const c = make({ fetch: (async () => reply()) as typeof fetch });
    await expect(c.promoteMemory("w")).rejects.toMatchObject({ name: "ProtocolError", code: "engine_error", message: "try again soon", retryable: true });
  });
});
