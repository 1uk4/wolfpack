import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@wolfpack/protocol";
import { createMemoryBus, type ActivityBus } from "./activity/bus.js";
import { createPresenceStore } from "./activity/presence.js";
import { createEventBus } from "./events.js";
import { createHubServer, type HubOptions, type HubServer } from "./server.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";
import { OP, registerWolfOnHost, seedTokens } from "./testing/tokens.js";

const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

async function start(extra: Partial<HubOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hubd-activity-"));
  tmp.push(dir);
  seedFixture(dir);
  seedTokens(dir);
  const h = await createHubServer({ dataDir: dir, ...extra });
  servers.push(h);
  const w1 = await registerWolfOnHost(h, OP, "w1", "h1");
  const w2 = await registerWolfOnHost(h, OP, "w2", "h2");
  return { h, w1, w2 };
}

const ev = (over: Record<string, unknown> = {}, actor: Record<string, unknown> = { kind: "wolf", wolf: "w1" }) => ({
  v: 1, id: `e${Math.random()}`, pack: "client-chosen", ts: 1, ttlMs: 60_000, actor, verb: "thread-active", ...over,
});
const post = (h: HubServer, headers: Record<string, string>, events: unknown[]) =>
  fetch(h.url + "/v1/activity", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, events }) });

/** Open /v1/events; `activity()` returns the pack.activity frames seen so far after a short settle. */
async function open(h: HubServer, o: { headers?: Record<string, string>; activity?: boolean } = {}) {
  const ctl = new AbortController();
  const res = await fetch(h.url + "/v1/events" + (o.activity === false ? "" : "?activity=1"), { headers: o.headers ?? OP, signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    frames: async () => {
      await new Promise((r) => setTimeout(r, 150));
      return buf.split("\n\n").flatMap((c) => {
        const d = /^data: (.*)$/m.exec(c);
        return d ? [{ hasId: /^id: /m.test(c), data: JSON.parse(d[1]) }] : [];
      });
    },
    close: () => ctl.abort(),
  };
}

describe("POST /v1/activity", () => {
  it("needs a token; a wolf cannot publish as another wolf; invalid events are dropped, valid ones fan out stamped with the hub's pack", async () => {
    const { h, w1 } = await start({ packId: "pack-1" });
    expect((await fetch(h.url + "/v1/activity", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(h.url + "/v1/activity/presence")).status).toBe(401);
    const s = await open(h);
    const r = await post(h, w1, [ev(), ev({}, { kind: "wolf", wolf: "w2" }), { v: 1, nonsense: true }, ev({}, { kind: "owner" })]);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: 1, dropped: 3 });
    const got = (await s.frames()).filter((f) => f.data.type === "pack.activity");
    expect(got).toHaveLength(1);
    expect(got[0].data.event).toMatchObject({ pack: "pack-1", actor: { kind: "wolf", wolf: "w1" } });
    expect(got[0].hasId).toBe(false); // never moves the Last-Event-ID cursor
    s.close();
  });

  it("accepts wolfd's events with an empty pack and fills the pack from the hub", async () => {
    const { h, w1 } = await start({ packId: "pack-1" });
    const r = await post(h, w1, [ev({ pack: "" }), (() => { const { pack: _p, ...noPack } = ev(); return noPack; })()]);
    expect(await r.json()).toEqual({ accepted: 2, dropped: 0 });
    const snap = (await (await fetch(h.url + "/v1/activity/presence", { headers: OP })).json()) as any;
    expect(snap.wolves[0].event.pack).toBe("pack-1");
  });

  it("an owner/console token publishes owner events only", async () => {
    const { h } = await start();
    const r = await post(h, OP, [ev({}, { kind: "owner" }), ev()]);
    expect(await r.json()).toEqual({ accepted: 1, dropped: 1 });
  });

  it("rate limits per token: the excess is dropped with a 202, not an error", async () => {
    const { h, w1, w2 } = await start({ activityBurst: 3, activityRatePerSec: 0.001 });
    const r = await post(h, w1, [ev(), ev(), ev(), ev(), ev()]);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: 3, dropped: 2 });
    expect(await (await post(h, w2, [ev({}, { kind: "wolf", wolf: "w2" })])).json()).toEqual({ accepted: 1, dropped: 0 }); // other token has its own bucket
  });

  it("rejects a body over 64 KB", async () => {
    const { h, w1 } = await start();
    const r = await post(h, w1, [ev({ id: "x".repeat(70_000) })]);
    expect(r.status).toBe(400);
  });
});

describe("activity scope", () => {
  it("only a device token that opts in with ?activity=1 receives pack.activity frames; a worker token never does", async () => {
    const { h, w1, w2 } = await start();
    const wolfFlagged = await open(h, { headers: w2 });
    const noFlag = await open(h, { activity: false });
    const flagged = await open(h);
    await post(h, w1, [ev()]);
    const count = async (s: Awaited<ReturnType<typeof open>>) => (await s.frames()).filter((f) => f.data.type === "pack.activity").length;
    expect(await count(flagged)).toBe(1);
    expect(await count(noFlag)).toBe(0);
    expect(await count(wolfFlagged)).toBe(0);
    for (const s of [wolfFlagged, noFlag, flagged]) s.close();
  });

  it("presence is 403 for a worker token", async () => {
    const { h, w1 } = await start();
    expect((await fetch(h.url + "/v1/activity/presence", { headers: w1 })).status).toBe(403);
  });
});

describe("GET /v1/activity/presence", () => {
  it("lists accepted actors by kind and forgets them after their ttl", async () => {
    let t = 1_000_000;
    const { h, w1 } = await start({ now: () => t });
    await post(h, w1, [ev({ ttlMs: 1000 }), ev({ ttlMs: 5000 }, { kind: "thread", wolf: "w1", threadId: "t1" })]);
    const snap = async () => (await fetch(h.url + "/v1/activity/presence", { headers: OP })).json() as Promise<any>;
    let s = await snap();
    expect(s.pack).toBe("default");
    expect(s.wolves).toHaveLength(1);
    expect(s.threads).toHaveLength(1);
    t += 1001;
    s = await snap();
    expect(s.wolves).toHaveLength(0);
    expect(s.threads).toHaveLength(1);
  });
});

describe("presence store", () => {
  it("a later transient event from the same actor does not evict its needs-you or bound state", () => {
    const store = createPresenceStore();
    const th = { kind: "thread", wolf: "w1", threadId: "t1" };
    store.set(ev({ pack: "p", verb: "needs-you" }, th) as ActivityEvent);
    store.set(ev({ pack: "p", verb: "bound" }, th) as ActivityEvent);
    store.set(ev({ pack: "p", verb: "kb-write" }, th) as ActivityEvent);
    store.set(ev({ pack: "p", verb: "contribution" }, th) as ActivityEvent);
    const verbs = store.snapshot("p").threads.map((e) => e.event.verb).sort();
    expect(verbs).toEqual(["bound", "contribution", "needs-you"]);
    store.stop();
  });
});

describe("wolf presence", () => {
  it("lists a wolf from its wolf-online heartbeat, expires it with the ttl, and drops it on wolf-offline", () => {
    let t = 1000;
    const store = createPresenceStore({ now: () => t });
    const w = (verb: string, wolf: string) => ev({ pack: "p", verb, ttlMs: 180_000 }, { kind: "wolf", wolf }) as ActivityEvent;
    store.set(w("wolf-online", "hal"));
    store.set(w("wolf-online", "jack"));
    expect(store.snapshot("p").wolves.map((e) => e.event.actor.wolf).sort()).toEqual(["hal", "jack"]);
    store.set(w("wolf-offline", "jack"));
    expect(store.snapshot("p").wolves.map((e) => e.event.actor.wolf)).toEqual(["hal"]);
    t += 180_001;
    expect(store.snapshot("p").wolves).toEqual([]);
    store.stop();
  });
});

describe("activity bus", () => {
  it("delivers only to subscribers of the event's pack", () => {
    const bus = createMemoryBus();
    const a: ActivityEvent[] = [];
    const b: ActivityEvent[] = [];
    bus.subscribe("A", (e) => a.push(e));
    const unsubB = bus.subscribe("B", (e) => b.push(e));
    bus.publish(ev({ pack: "B" }) as ActivityEvent);
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
    unsubB();
    bus.publish(ev({ pack: "B" }) as ActivityEvent);
    expect(b).toHaveLength(1);
  });

  it("a backed-up SSE subscriber gets resync and is closed; the others keep receiving", () => {
    const bus = createEventBus();
    const activity = createMemoryBus();
    const mk = (writableLength: number) =>
      Object.assign(new EventEmitter(), {
        destroyed: false, writableEnded: false, writableLength, written: [] as string[], writeHead: vi.fn(),
        write(s: string) { this.written.push(s); return true; },
        end(s?: string) { if (s) this.written.push(s); this.writableEnded = true; this.emit("close"); },
        destroy() { this.destroyed = true; this.emit("close"); },
      });
    const slow = mk(10_000_000);
    const fine = mk(0);
    bus.attach(slow as unknown as ServerResponse, undefined, { pack: "p", bus: activity });
    bus.attach(fine as unknown as ServerResponse, undefined, { pack: "p", bus: activity });
    activity.publish(ev({ pack: "p" }) as ActivityEvent);
    expect(slow.written.join("")).toContain('"type":"resync"');
    expect(slow.writableEnded).toBe(true);
    expect(fine.written.join("")).toContain("pack.activity");
    expect(bus.streamCount).toBe(1);
  });
});

describe("bus failure", () => {
  it("a throwing bus adapter never breaks ingest, the event stream, or the Work API", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom: ActivityBus = { publish() { throw new Error("redis down"); }, subscribe() { throw new Error("redis down"); } };
    const { h, w1 } = await start({ activityBus: boom });
    expect((await post(h, w1, [ev()])).status).toBe(202);
    const s = await open(h);
    expect((await fetch(h.url + `/v1/work?domain=${FIXTURE_DOMAIN}`, { headers: OP })).status).toBe(200);
    expect((await fetch(h.url + "/v1/activity/presence", { headers: OP })).status).toBe(200);
    h.emitKbChanged(["a"]);
    expect((await s.frames()).some((f) => f.data.type === "kb.changed")).toBe(true);
    s.close();
  });
});
