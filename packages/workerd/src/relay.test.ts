import { afterEach, describe, expect, it } from "vitest";
import { HttpConsoleClient } from "@wolfpack/client";
import { startLinkRig, type LinkRig } from "./testing/link-rig.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function rig(o: Parameters<typeof startLinkRig>[0] = {}) {
  const r = await startLinkRig(o);
  cleanup.push(() => r.close());
  await r.waitPresence("online");
  await r.workerd.supervisor.whenSettled();
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
    r.workerd.link!.sendFrame = (f) => (f.t === "chunk" && sizes.push(f.data.length), orig(f));
    const res = await get("/v1/wolves/alpha/memory?big=3000000");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(3_000_000);
    expect(buf.every((b) => b === 97)).toBe(true);
    expect(sizes.length).toBeGreaterThan(10);
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
});
