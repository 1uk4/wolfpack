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

  it("getThread pages through the limit/before query", async () => {
    const urls: string[] = [];
    const c = make({ fetch: async (input, init) => (urls.push(String(input)), fetch(input, init)) });
    const id = await homeThread(c);
    const page = await c.getThread(id, { limit: 5 });
    expect(page.hasMore).toBe(false);
    await c.getThread(id, { limit: 5, before: "x" });
    expect(urls.some((u) => u.endsWith("?limit=5"))).toBe(true);
    expect(urls.some((u) => u.endsWith("?limit=5&before=x"))).toBe(true);
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

  it("a mid-stream snapshot reaches onSnapshot in order and the stream continues after it", async () => {
    const env = { threadId: "t", at: "2026-01-01T00:00:00Z", actor: { id: "w", kind: "wolf" } };
    const frames = [
      { id: 1, type: "turn-start", turnId: "a" },
      { id: 2, type: "text-delta", turnId: "a", text: "stale" },
      {
        id: 2, type: "snapshot", upToId: 2, inFlight: { turnId: "a", text: "the full text" },
        thread: { id: "t", wolf: "w", title: "t", kind: "home", busy: true, lastEventId: 2, updatedAt: env.at, messages: [{ id: "m", role: "assistant", text: "the full text", at: env.at }] },
      },
      { id: 3, type: "turn-end", turnId: "a", reason: "complete" },
    ];
    const body = frames.map((f) => `id: ${f.id}\ndata: ${JSON.stringify({ ...env, ...f })}\n\n`).join("") + "data: [DONE]\n\n";
    const c = make({
      fetch: async (input) =>
        String(input).endsWith("/stream") ? new Response(body, { headers: { "Content-Type": "text/event-stream" } }) : fetch(input),
    });
    const order: string[] = [];
    const snaps: SnapshotEvent[] = [];
    for await (const e of c.watch("t", { onSnapshot: (s) => (order.push("snapshot"), snaps.push(s)) })) order.push(e.type);
    expect(order).toEqual(["turn-start", "text-delta", "snapshot", "turn-end"]);
    expect(snaps[0].inFlight?.text).toBe("the full text");
    expect(snaps[0].thread.messages.at(-1)?.text).toBe("the full text");
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

describe("children and ledger", () => {
  it("list a thread's children and read a child's ledger; a missing thread is NotFoundError", async () => {
    const c = make();
    const home = await homeThread(c);
    expect(await c.listChildren(home)).toEqual([]);
    await expect(c.listChildren("nope/nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(c.getLedger(home)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("HttpConsoleClient watchHubEvents", () => {
  const sse = (frames: string) => new Response(new TextEncoder().encode(frames), { headers: { "Content-Type": "text/event-stream" } });
  it("yields events, sends the API key, and reconnects with the last frame id (resync included) as Last-Event-ID", async () => {
    const seen: { url: string; cursor: string | null; key: string | null }[] = [];
    const ctl = new AbortController();
    const f: typeof fetch = async (input, init) => {
      const req = new Request(input as string, init);
      seen.push({ url: req.url, cursor: req.headers.get("last-event-id"), key: req.headers.get("authorization") });
      if (seen.length === 1) return sse(`id: b:0\ndata: {"type":"resync","id":0,"at":"2026-10-29T00:00:00.000Z"}\n\nid: b:1\ndata: {"type":"kb.changed","id":1,"at":"2026-10-29T00:00:00.000Z","entryIds":["e"]}\n\n`);
      return sse(`id: b:2\ndata: {"type":"future.thing","id":2,"at":"x"}\n\nid: b:3\ndata: {"type":"wolf.presence","id":3,"at":"2026-10-29T00:00:00.000Z","wolf":"w","state":"online","host":"h"}\n\n`);
    };
    const c = new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid", token: "sekret" }, fetch: f, retryDelayMs: 1 });
    const got: string[] = [];
    for await (const ev of c.watchHubEvents({ signal: ctl.signal })) {
      got.push(ev.type);
      if (got.length === 3) ctl.abort();
    }
    expect(got).toEqual(["resync", "kb.changed", "wolf.presence"]); // the unknown type is skipped
    expect(seen[0]).toEqual({ url: "http://hub.invalid/v1/events", cursor: null, key: "Bearer sekret" });
    expect(seen[1].cursor).toBe("b:1");
  });
  it("hub requests send the bearer token and never X-API-Key", async () => {
    const seen: { auth: string | null; key: string | null }[] = [];
    const ctl = new AbortController();
    const f: typeof fetch = async (input, init) => {
      const req = new Request(input as string, init);
      seen.push({ auth: req.headers.get("authorization"), key: req.headers.get("x-api-key") });
      return sse(`id: b:1\ndata: {"type":"kb.changed","id":1,"at":"2026-10-29T00:00:00.000Z","entryIds":["e"]}\n\n`);
    };
    const c = new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid", token: "tok123" }, fetch: f });
    for await (const _ev of c.watchHubEvents({ signal: ctl.signal })) ctl.abort();
    expect(seen[0]).toEqual({ auth: "Bearer tok123", key: null });
  });
  it("a busy refusal is retried (no limit) and then succeeds", async () => {
    let calls = 0;
    const ctl = new AbortController();
    const f: typeof fetch = async () => {
      calls++;
      if (calls <= 8) return Response.json({ code: "busy", message: "too many open event streams", retryable: true }, { status: 409 });
      return sse(`id: b:1\ndata: {"type":"kb.changed","id":1,"at":"2026-10-29T00:00:00.000Z","entryIds":["e"]}\n\n`);
    };
    const c = new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid" }, fetch: f, retryDelayMs: 1, maxStreamRetries: 2 });
    for await (const ev of c.watchHubEvents({ signal: ctl.signal })) {
      expect(ev.type).toBe("kb.changed");
      ctl.abort();
    }
    expect(calls).toBe(9); // more attempts than maxStreamRetries: hub events retry without a limit
  });
  it("an abort during backoff returns promptly", async () => {
    const ctl = new AbortController();
    const f: typeof fetch = async () => Response.json({ code: "busy", message: "busy", retryable: true }, { status: 409 });
    const c = new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid" }, fetch: f, retryDelayMs: 60_000 });
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 50);
    const got: unknown[] = [];
    for await (const ev of c.watchHubEvents({ signal: ctl.signal })) got.push(ev);
    expect(got).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("needs a hub", async () => {
    const c = new HttpConsoleClient({ baseUrl: "http://wolf.invalid", fetch: async () => new Response("") });
    await expect(c.watchHubEvents().next()).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe("HttpConsoleClient hub work reads", () => {
  it("goes to the hub's /v1/work routes with the API key; other calls keep using baseUrl", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const f: typeof fetch = async (input, init) => {
      const req = new Request(input as string, init);
      seen.push({ url: req.url, key: req.headers.get("authorization") });
      if (req.url.includes("/record")) return Response.json({ id: "work-x-1234567", title: "T", kind: "task", stage: "plan", plan: "p", record: "" });
      return Response.json({ items: [{ id: "work-x-1234567", title: "T", kind: "task", stage: "plan", domain: "x", dependsOn: [] }] });
    };
    const c = new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid/", token: "sekret" }, fetch: f });
    expect((await c.listWork("any", { domain: "x y", graduated: true })).items).toHaveLength(1);
    expect((await c.getWorkRecord("any", "work-x-1234567")).title).toBe("T");
    expect(seen.map((s) => s.url)).toEqual(["http://hub.invalid/v1/work?domain=x%20y&graduated=true", "http://hub.invalid/v1/work/work-x-1234567/record"]);
    expect(seen.every((s) => s.key === "Bearer sekret")).toBe(true);
  });
  it("sends no credentials without a token, and never X-API-Key or X-Wolfpack-Actor", async () => {
    const seen: (string | null)[][] = [];
    const f: typeof fetch = async (input, init) => {
      const h = new Request(input as string, init).headers;
      seen.push([h.get("authorization"), h.get("x-api-key"), h.get("x-wolfpack-actor")]);
      return Response.json({ items: [] });
    };
    await new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid" }, fetch: f }).listWork("w", { domain: "x" });
    await new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid", token: "t" }, fetch: f }).listWork("w", { domain: "x" });
    expect(seen).toEqual([[null, null, null], ["Bearer t", null, null]]);
  });
  it("maps a hub not_found envelope to NotFoundError", async () => {
    const f: typeof fetch = async () => Response.json({ code: "not_found", message: "work item w", retryable: false }, { status: 404 });
    const c = new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid" }, fetch: f });
    await expect(c.getWorkRecord("any", "work-x-1234567")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("hub claim posts to /claim and a conflict envelope keeps its details on the ProtocolError", async () => {
    const seen: string[] = [];
    const f: typeof fetch = async (u, init) => {
      seen.push(`${init?.method} ${String(u)}`);
      return Response.json({ code: "conflict", message: "already claimed: w is held by w1", retryable: false, details: { holder: "w1" } }, { status: 409 });
    };
    const c = new HttpConsoleClient({ baseUrl: "http://wolf.invalid", hub: { baseUrl: "http://hub.invalid" }, fetch: f });
    const e = await c.claimWork("work-x-1234567").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProtocolError);
    expect((e as ProtocolError).code).toBe("conflict");
    expect((e as ProtocolError).details).toEqual({ holder: "w1" });
    await c.releaseWork("work-x-1234567").catch(() => undefined);
    expect(seen).toEqual(["POST http://hub.invalid/v1/work/work-x-1234567/claim", "POST http://hub.invalid/v1/work/work-x-1234567/unclaim"]);
  });
  it("without a hub, work reads still use the wolf-scoped routes", async () => {
    const c = make();
    await expect(c.listWork("1uk4", { domain: "x" })).rejects.toBeInstanceOf(ProtocolError); // stub: no Work API
  });
});
