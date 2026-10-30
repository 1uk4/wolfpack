import { afterEach, describe, expect, it } from "vitest";
import { HttpConsoleClient } from "@wolfpack/client";
import { request as nodeRequest, type IncomingMessage } from "node:http";
import { LINK_RELAY_PAUSE_HIGH, LINK_RELAY_HARD_SLACK, type LinkFrame } from "@wolfpack/protocol";
import { startLinkRig, type LinkRig } from "./testing/link-rig.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function rig(o: Parameters<typeof startLinkRig>[0] = {}) {
  const r = await startLinkRig(o);
  cleanup.push(() => r.close());
  if (!o.noHub) {
    await r.waitPresence("online");
    await r.workerd.supervisor.whenSettled();
  }
  const console_ = r.store.redeem(r.store.mintPairingCode({ kind: "console" }).code, "c", "console");
  const hubUrl = r.hub.url;
  const get = (path: string, token = console_.token, init: RequestInit = {}) => fetch(hubUrl + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers as object) } });
  return { r, token: console_.token, get, hubUrl };
}
const openStreams = async (r: LinkRig, wolf = "alpha") => ((await (await fetch(`${r.workerd.url}/v1/wolves/${wolf}/memory?openStreams`)).json()) as { openStreams: number }).openStreams;

describe("console relay through the hub", () => {
  it("plain request/response, POST body round trip, errors pass through; hub credentials are not forwarded", async () => {
    const { get } = await rig();
    const ok = await get("/v1/wolves/alpha/threads");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).threads[0].id).toBe("alpha/home");
    const body = JSON.stringify({ text: "héllo", pad: "x".repeat(300_000) });
    const post = await get("/v1/wolves/alpha/threads", undefined, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(post.status).toBe(201);
    const j = (await post.json()) as any;
    expect(j.echo).toBe(body);
    expect(j.type).toBe("application/json");
    expect(j.auth).toBeNull();
    expect((await get("/v1/threads/alpha%2Fnope")).status).toBe(404);
    expect((await get("/v1/wolves/ghost/threads")).status).toBe(404);
  });

  it("a large response is split into bounded chunk frames and arrives intact", async () => {
    const { r, get } = await rig();
    const sizes: number[] = [];
    const orig = r.workerd.link!.sendFrame.bind(r.workerd.link!);
    r.workerd.link!.sendFrame = (f, w) => (f.t === "chunk" && sizes.push(f.data.length), orig(f, w));
    const res = await get("/v1/wolves/alpha/memory?big=3500000");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(3_500_000);
    expect(buf.every((b) => b === 97)).toBe(true);
    expect(sizes.length).toBeGreaterThanOrEqual(13);
    expect(Math.max(...sizes)).toBeLessThan(8 * 1024 * 1024 / 4);
  });

  it("streams SSE through the hub unbuffered and ends", async () => {
    const { get } = await rig();
    const res = await get(`/v1/threads/${encodeURIComponent("beta/home")}/stream`, undefined, { headers: { "Last-Event-ID": "7" } }).catch(() => undefined);
    expect(res?.status).toBe(404); // beta is not on this rig: unknown wolf
    const a = await get(`/v1/threads/${encodeURIComponent("alpha/home")}/stream`, undefined, { headers: { "Last-Event-ID": "7" } });
    expect(a.headers.get("content-type")).toContain("text/event-stream");
    const t0 = Date.now();
    const at: number[] = [];
    let text = "";
    const dec = new TextDecoder();
    for await (const c of a.body as unknown as AsyncIterable<Uint8Array>) (at.push(Date.now() - t0), (text += dec.decode(c)));
    expect(text.startsWith('id: 1\ndata: {"lastEventId":"7"}')).toBe(true);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(at.length).toBeGreaterThanOrEqual(3);
    expect(at[0]).toBeLessThan(120);
  });

  it("the console client chats through the hub with only the hub url and token", async () => {
    const { r, token } = await rig();
    const c = new HttpConsoleClient({ baseUrl: r.hub.url, hub: { baseUrl: r.hub.url, token, relay: true } });
    expect((await c.listWolves()).map((w) => [w.name, w.host, w.status])).toEqual([["alpha", "box", "online"]]);
    expect((await c.listThreads("alpha")).map((t) => t.id)).toEqual(["alpha/home"]);
  });

  it("client abort cancels the worker's request", async () => {
    const { r, get } = await rig();
    const ctl = new AbortController();
    const res = await get(`/v1/threads/${encodeURIComponent("alpha/forever")}/stream`, undefined, { signal: ctl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    expect(await openStreams(r)).toBe(1);
    ctl.abort();
    await r.eventually(async () => (await openStreams(r)) === 0, "worker stream closed");
    expect(r.workerd.link).toBeDefined();
  });

  it("a link drop mid-stream ends the client's stream; the hub forgets the request", async () => {
    const { r, get } = await rig();
    const res = await get(`/v1/threads/${encodeURIComponent("alpha/forever")}/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    r.hub.link.closeByHost("box");
    await expect((async () => { for (;;) { const { done } = await reader.read(); if (done) return "done"; } })()).rejects.toThrow();
    await r.eventually(async () => (await openStreams(r)) === 0, "worker aborted its local request");
  });

  it("an offline or asleep worker fails at once naming the state", async () => {
    const { r, get } = await rig({ laptop: true });
    await r.workerd.link!.stop();
    await r.waitPresence("asleep");
    const t0 = Date.now();
    const a = await get("/v1/wolves/alpha/threads");
    expect(a.status).toBe(503);
    const env = (await a.json()) as any;
    expect(env.message).toContain("asleep");
    expect(env.details.presence).toBe("asleep");
    expect(Date.now() - t0).toBeLessThan(500);
    r.hub.link.closeAll();
    await r.registerWolf("orphan"); // registered, never on a host
    const o = await get("/v1/wolves/orphan/threads");
    expect(o.status).toBe(503);
    expect(((await o.json()) as any).details.presence).toBe("offline");
  });

  it("concurrent requests are multiplexed over the one socket", async () => {
    const { r, get } = await rig();
    const streams = await Promise.all([0, 1, 2].map(() => get(`/v1/threads/${encodeURIComponent("alpha/home")}/stream`)));
    const plain = await Promise.all(Array.from({ length: 20 }, () => get("/v1/wolves/alpha/threads").then((x) => x.status)));
    expect(plain.every((s) => s === 200)).toBe(true);
    const texts = await Promise.all(streams.map((s) => s.text()));
    for (const t of texts) expect(t.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(r.hub.link.presence("box")).toBe("online");
  });

  it("no head within the timeout: 504 and the worker is cancelled", async () => {
    const r0 = await startLinkRig({ hubTimers: { heartbeatMs: 100, deadAfterMs: 1000, helloTimeoutMs: 500, asleepOfflineMs: 60_000, relayHeadTimeoutMs: 300 } as any });
    cleanup.push(() => r0.close());
    await r0.waitPresence("online");
    await r0.workerd.supervisor.whenSettled();
    const console_ = r0.store.redeem(r0.store.mintPairingCode({ kind: "console" }).code, "c", "console");
    const res = await fetch(`${r0.hub.url}/v1/wolves/alpha/memory?hang`, { headers: { Authorization: `Bearer ${console_.token}` } });
    expect(res.status).toBe(504);
    expect(r0.hub.link.presence("box")).toBe("online");
  });

  it("unauthorized, worker-token and unknown-wolf requests are rejected", async () => {
    const { r, hubUrl, get } = await rig();
    expect((await fetch(`${hubUrl}/v1/wolves/alpha/threads`)).status).toBe(401);
    expect((await get("/v1/wolves/alpha/threads", "nope")).status).toBe(401);
    const other = r.mintWorker("other");
    expect((await get("/v1/wolves/alpha/threads", other.token)).status).toBe(403);
    expect((await get("/v1/wolves/alpha/threads", r.token)).status).toBe(403);
    expect((await get("/v1/wolves/ghost/threads")).status).toBe(404);
  });

  it("a worker cannot answer another host's request id", async () => {
    const { r, get } = await rig();
    const evil = r.mintWorker("evil");
    const raw = await r.rawLink(evil.token);
    raw.hello({ hostId: "evil" });
    await raw.until(() => raw.frames.some((f) => f.t === "welcome"), "welcome");
    const res = await get(`/v1/threads/${encodeURIComponent("alpha/forever")}/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    for (const id of ["h-1", "h-2", "h-3", "h-4", "h-5", "h-6", "h-7", "h-8"]) raw.send({ t: "rerr", id, code: "x" });
    const next = await reader.read();
    expect(next.done).toBe(false); // the stream is still alive
    await reader.cancel();
  });

  it("absolute-form and //host request targets are refused at the hub; nothing connects off-loopback", async () => {
    const { r, token, hubUrl } = await rig();
    const { request } = await import("node:http");
    const u = new URL(hubUrl);
    const sentFrames: string[] = [];
    const origSend = r.hub.link.sendToHost.bind(r.hub.link);
    r.hub.link.sendToHost = (h, f) => (sentFrames.push(f.t), origSend(h, f));
    const raw = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const q = request({ hostname: u.hostname, port: u.port, path: target, method: "GET", headers: { Authorization: `Bearer ${token}` } }, (x) => (x.resume(), resolve(x.statusCode ?? 0)));
        q.on("error", reject);
        q.end();
      });
    expect(await raw("http://evil.invalid:8080/v1/wolves/alpha/threads")).toBe(400);
    expect(await raw("//evil.invalid:8080/v1/wolves/alpha/threads")).toBe(400);
    expect(sentFrames).not.toContain("req");
    expect(r.workerd.link!.status().state).toBe("online");
  });

  it("GET /v1/wolves: a worker token sees only its own host's wolves; console sees all", async () => {
    const { r, get } = await rig({ preRegister: ["zed"] });
    const mine = (await (await get("/v1/wolves", r.token)).json()) as any;
    expect(mine.wolves.map((w: any) => w.name)).toEqual(["alpha"]);
    const other = r.mintWorker("other");
    expect(((await (await get("/v1/wolves", other.token)).json()) as any).wolves).toEqual([]);
    const all = (await (await get("/v1/wolves")).json()) as any;
    expect(all.wolves.map((w: any) => w.name).sort()).toEqual(["alpha", "zed"]);
  });

  it("set-cookie and CORS headers from the worker do not reach the console", async () => {
    const { get } = await rig();
    const res = await get("/v1/wolves/alpha/memory?cookies");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-keep")).toBe("1");
  });

});

// ---- flow control (pause / resume) ----------------------------------------------------------------------------------------------

/** Count the hub -> worker frames of one type (wraps sendToHost; call before the request). */
function recordHubFrames(r: LinkRig) {
  const frames: LinkFrame[] = [];
  const orig = r.hub.link.sendToHost.bind(r.hub.link);
  r.hub.link.sendToHost = (h, f) => (frames.push(f), orig(h, f));
  return { frames, count: (t: string) => frames.filter((f) => f.t === t).length };
}
/** A raw HTTP GET against the hub whose body is NOT read until `read()` is called (a slow client). */
function slowGet(hubUrl: string, token: string, path: string) {
  const u = new URL(hubUrl);
  let res!: IncomingMessage;
  let bytes = 0;
  let bad = 0;
  let abortFn = () => {};
  const done = new Promise<"end" | "error">((resolve) => {
    const q = nodeRequest({ hostname: u.hostname, port: u.port, path, headers: { Authorization: `Bearer ${token}` } }, (x) => {
      res = x;
      x.pause();
      x.on("data", (b: Buffer) => {
        bytes += b.length;
        for (const c of b) if (c !== 97) bad++;
      });
      x.on("end", () => resolve("end"));
      x.on("error", () => resolve("error"));
      x.on("aborted", () => resolve("error"));
    });
    q.on("error", () => resolve("error"));
    q.end();
    abortFn = () => q.destroy();
  });
  return { done, abort: () => (res?.destroy(), abortFn()), read: () => res.resume(), got: () => ({ bytes, bad }), head: () => until2(() => !!res) };
}
const until2 = async (c: () => boolean) => {
  const end = Date.now() + 5000;
  while (!c()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("relay flow control", () => {
  it("a slow reader gets a 24 MB body intact; the hub pauses and resumes the worker (no cutoff)", async () => {
    const { r, hubUrl, token } = await rig();
    const rec = recordHubFrames(r);
    const c = slowGet(hubUrl, token, "/v1/wolves/alpha/memory?big=25165824");
    await c.head();
    await r.eventually(() => rec.count("pause") >= 1, "a pause frame", 8000); // the client has not read a byte
    expect(rec.count("cancel")).toBe(0);
    c.read();
    expect(await c.done).toBe("end");
    expect(c.got()).toEqual({ bytes: 25165824, bad: 0 });
    expect(rec.count("resume")).toBeGreaterThanOrEqual(1);
    expect(rec.count("pause")).toBeLessThanOrEqual(rec.count("resume") + 1); // never two pauses without a resume between
    expect(rec.count("cancel")).toBe(0);
  });

  it("cancel while paused: the worker's paused local request is cleaned up", async () => {
    const { r, hubUrl, token } = await rig();
    const rec = recordHubFrames(r);
    const c = slowGet(hubUrl, token, "/v1/wolves/alpha/memory?big=25165824");
    await c.head();
    await r.eventually(() => rec.count("pause") >= 1, "a pause frame", 8000);
    await new Promise((x) => setTimeout(x, 200));
    expect(await openStreams(r)).toBe(1); // held open by the pause
    c.abort();
    await r.eventually(() => rec.count("cancel") === 1, "cancel frame");
    await r.eventually(async () => (await openStreams(r)) === 0, "paused worker request closed");
  });

  it("a worker that ignores pause is still cut off at the hard cap", async () => {
    const { r, hubUrl, token } = await rig({ noHub: true });
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    const c = slowGet(hubUrl, token, "/v1/wolves/alpha/memory");
    await w.until(() => w.frames.some((f) => f.t === "req"), "req");
    const id = (w.frames.find((f) => f.t === "req") as any).id as string;
    w.send({ t: "res", id, status: 200, headers: {} });
    const data = Buffer.alloc(128 * 1024, 97).toString("base64");
    let sent = 0;
    // Never honours pause: keeps sending until the hub cancels (bounded so a broken hub fails the test, not hangs it).
    while (!w.frames.some((f) => f.t === "cancel") && sent < 600) {
      w.send({ t: "chunk", id, seq: sent++, data, enc: "b64" });
      if (sent % 4 === 0) await new Promise((x) => setTimeout(x, 2));
    }
    expect(w.frames.some((f) => f.t === "pause")).toBe(true);
    expect(w.frames.some((f) => f.t === "cancel")).toBe(true);
    // The client's own queue (kernel buffers aside) was bounded by the hard cap, not by the whole 75 MB attempt.
    expect(sent * 128 * 1024).toBeLessThan(72 * 1024 * 1024);
    expect(LINK_RELAY_PAUSE_HIGH + LINK_RELAY_HARD_SLACK).toBeLessThan(20 * 1024 * 1024);
    c.read();
    expect(await c.done).toBe("error");
  });

  it("cancel while paused (raw worker): the hub sends exactly one pause, then cancel", async () => {
    const { r, hubUrl, token } = await rig({ noHub: true });
    const w = await r.rawLink(r.token);
    w.hello({ wolves: [{ name: "alpha", domains: [] }] });
    await w.until(() => w.frames.some((f) => f.t === "welcome"), "welcome");
    const c = slowGet(hubUrl, token, "/v1/wolves/alpha/memory");
    await w.until(() => w.frames.some((f) => f.t === "req"), "req");
    const id = (w.frames.find((f) => f.t === "req") as any).id as string;
    w.send({ t: "res", id, status: 200, headers: {} });
    const data = Buffer.alloc(128 * 1024, 97).toString("base64");
    let sent = 0;
    while (!w.frames.some((f) => f.t === "pause") && sent < 600) {
      w.send({ t: "chunk", id, seq: sent++, data, enc: "b64" }); // honours pause: stops at the first one
      if (sent % 4 === 0) await new Promise((x) => setTimeout(x, 2));
    }
    expect(w.frames.some((f) => f.t === "pause")).toBe(true);
    await new Promise((x) => setTimeout(x, 150));
    expect(w.frames.filter((f) => f.t === "pause")).toHaveLength(1);
    expect(w.frames.some((f) => f.t === "cancel")).toBe(false);
    c.abort();
    await w.until(() => w.frames.some((f) => f.t === "cancel"), "cancel after abort while paused");
  });
});
