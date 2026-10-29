import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { createEventBus } from "./events.js";
import { createHubServer, type HubOptions, type HubServer } from "./server.js";
import { FIXTURE_DOMAIN, seedFixture } from "./testing/fixture.js";

const KEY = "k";
const tmp: string[] = [];
const servers: HubServer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (servers.length) await servers.pop()!.close();
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "hubd-events-"));
  tmp.push(d);
  return d;
};
async function start(extra: Partial<HubOptions> = {}, dir = mk(), seed = true) {
  if (seed) seedFixture(dir);
  const h = await createHubServer({ dataDir: dir, apiKey: KEY, ...extra });
  servers.push(h);
  return h;
}
const create = (h: HubServer, domain = FIXTURE_DOMAIN) =>
  fetch(h.url + "/v1/work", {
    method: "POST",
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", [ACTOR_HEADER]: JSON.stringify({ id: "1uk4", kind: "operator" }) },
    body: JSON.stringify({ kind: "task", domain, title: "t", assignee: "1uk4" }),
  }).then((r) => r.json() as Promise<{ id: string }>);

type Frame = { id?: string; data: any };
/** Open /v1/events; `next(n)` resolves the next n data frames (comments skipped). */
async function open(h: HubServer, headers: Record<string, string> = {}, query = "") {
  const ctl = new AbortController();
  const res = await fetch(h.url + "/v1/events" + query, { headers: { "X-API-Key": KEY, ...headers }, signal: ctl.signal });
  if (res.status !== 200) return { res, next: async () => [] as Frame[], close: () => ctl.abort() };
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const next = async (n: number): Promise<Frame[]> => {
    const out: Frame[] = [];
    while (out.length < n) {
      const i = buf.indexOf("\n\n");
      if (i < 0) {
        const r = await reader.read();
        if (r.done) throw new Error("stream ended");
        buf += dec.decode(r.value, { stream: true });
        continue;
      }
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const d = /^data: (.*)$/m.exec(chunk);
      if (d) out.push({ id: /^id: (.*)$/m.exec(chunk)?.[1], data: JSON.parse(d[1]) });
    }
    return out;
  };
  return { res, next, close: () => ctl.abort() };
}
/** The first frame of a connect with a cursor from no boot: a resync whose id names this hub's boot and current seq. */
async function cursorNow(h: HubServer): Promise<{ boot: string; seq: number }> {
  const s = await open(h, { "Last-Event-ID": "zz:0" });
  const [f] = await s.next(1);
  s.close();
  const [boot, seq] = f.id!.split(":");
  return { boot, seq: Number(seq) };
}
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe("hubd /v1/events", () => {
  it("requires the API key", async () => {
    const h = await start();
    expect((await fetch(h.url + "/v1/events")).status).toBe(401);
  });

  it("emits kb.changed (with domain) through emitKbChanged", async () => {
    const h = await start();
    const s = await open(h);
    h.emitKbChanged(["a", "b"], "d");
    h.emitKbChanged(["c"]);
    const [x, y] = await s.next(2);
    expect(x.data).toMatchObject({ type: "kb.changed", entryIds: ["a", "b"], domain: "d" });
    expect(y.data.domain).toBeUndefined();
    s.close();
  });

  it("work.changed carries the item's domain", async () => {
    const h = await start();
    const s = await open(h);
    const { id } = await create(h);
    const frames = await s.next(1);
    expect(frames[0].data).toMatchObject({ type: "work.changed", itemId: expect.any(String), domain: FIXTURE_DOMAIN });
    expect(id).toBeTruthy();
    s.close();
  });

  it("one write that appends several ledger events yields consecutive ids, in ledger order", async () => {
    const h = await start({}, mk(), false); // empty ledger: creating a task also files its Inbox
    const s = await open(h);
    const { id } = await create(h, "fresh");
    const got: Frame[] = [];
    while (!got.some((f) => f.data.itemId === id)) got.push(...(await s.next(1)));
    expect(got.length).toBeGreaterThanOrEqual(2);
    got.forEach((f, i) => expect(f.data.id).toBe(i + 1));
    expect(got[got.length - 1].data.itemId).toBe(id); // the item's own create is last
    s.close();
  });

  describe("resync and cursors", () => {
    it("empty hub: a stale cursor answers resync with id <boot>:0, and that id resumes at event 1", async () => {
      const h = await start();
      const s = await open(h, { "Last-Event-ID": "zz:7" });
      const [r] = await s.next(1);
      expect(r.data).toMatchObject({ type: "resync", id: 0 });
      expect(r.id).toMatch(/^[0-9a-f]+:0$/);
      s.close();
      const { id } = await create(h);
      const again = await open(h, { "Last-Event-ID": r.id! });
      const [e] = await again.next(1);
      expect(e.data).toMatchObject({ type: "work.changed", id: 1 });
      expect(id).toBeTruthy();
      again.close();
    });

    it("a malformed cursor and a cursor ahead of the hub both answer resync", async () => {
      const h = await start();
      await create(h);
      const { boot } = await cursorNow(h);
      for (const cursor of ["garbage", "12", `${boot}:9999`, `${boot}:-1`]) {
        const s = await open(h, { "Last-Event-ID": cursor });
        const [f] = await s.next(1);
        expect(f.data.type, cursor).toBe("resync");
        s.close();
      }
    });

    it("?from= works, and an empty Last-Event-ID header falls back to it", async () => {
      const h = await start();
      const { boot } = await cursorNow(h);
      await create(h);
      await create(h);
      const q = await open(h, {}, `?from=${boot}:0`);
      const [a] = await q.next(1);
      expect(a.data).toMatchObject({ type: "work.changed", id: 1 });
      q.close();
      const both = await open(h, { "Last-Event-ID": " " }, `?from=${boot}:0`);
      expect((await both.next(1))[0].data.id).toBe(1);
      both.close();
    });

    it("no cursor = live only", async () => {
      const h = await start();
      await create(h);
      const s = await open(h);
      h.emitKbChanged(["x"]);
      expect((await s.next(1))[0].data.type).toBe("kb.changed");
      s.close();
    });

    it("a cursor inside the buffer after an overflow replays everything after it; an evicted one resyncs", async () => {
      const h = await start({ eventBufferSize: 3 });
      const { boot } = await cursorNow(h);
      for (let i = 1; i <= 6; i++) h.emitKbChanged([`e${i}`]); // seq 1..6, buffer keeps 4,5,6
      const inside = await open(h, { "Last-Event-ID": `${boot}:3` }); // exactly first-1: gap-free
      expect((await inside.next(3)).map((f) => f.data.entryIds[0])).toEqual(["e4", "e5", "e6"]);
      inside.close();
      const partial = await open(h, { "Last-Event-ID": `${boot}:5` });
      expect((await partial.next(1)).map((f) => f.data.entryIds[0])).toEqual(["e6"]);
      partial.close();
      const evicted = await open(h, { "Last-Event-ID": `${boot}:2` });
      expect((await evicted.next(1))[0].data).toMatchObject({ type: "resync", id: 6 });
      evicted.close();
    });
  });

  it("a ledger diff that cannot be taken broadcasts resync to live clients, with the current id", async () => {
    const dir = mk();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await start({}, dir, false);
    const s = await open(h);
    h.emitKbChanged(["pre"]); // seq 1
    await s.next(1);
    // Make `ledger` a file so statting the ledger fails with ENOTDIR (not ENOENT): the size probe fails.
    rmSync(join(dir, "ledger"), { recursive: true, force: true });
    writeFileSync(join(dir, "ledger"), "x");
    await create(h, "d").catch(() => {});
    const [r] = await s.next(1);
    expect(r.data).toMatchObject({ type: "resync", id: 2 }); // seq 1 was the last event; the gap marker takes 2
    expect(r.id).toMatch(/:2$/);
    expect(log).toHaveBeenCalled();
    s.close();
  });

  it("after a lost diff, a reconnect with a cursor at or before the gap resyncs; one after the gap replays normally", async () => {
    const dir = mk();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await start({}, dir, false);
    const { boot } = await cursorNow(h);
    h.emitKbChanged(["a"]); // seq 1
    h.emitKbChanged(["b"]); // seq 2
    const live = await open(h, { "Last-Event-ID": `${boot}:1` });
    expect((await live.next(1))[0].data.entryIds).toEqual(["b"]); // replays normally before any gap
    rmSync(join(dir, "ledger"), { recursive: true, force: true });
    writeFileSync(join(dir, "ledger"), "x");
    await create(h, "d").catch(() => {}); // probe fails -> broadcast resync, gapSeq = 2
    const [r] = await live.next(1);
    expect(r.data).toMatchObject({ type: "resync", id: 3 });
    live.close();
    // The old cursor (1, and 2 itself) lies at or before the gap: resync, not a buffer replay.
    for (const c of [1, 2]) {
      const again = await open(h, { "Last-Event-ID": `${boot}:${c}` });
      expect((await again.next(1))[0].data.type, `cursor ${c}`).toBe("resync");
      again.close();
    }
    // The resync's own id (3) is past the gap: reconnecting with it does not resync again, and replays what follows.
    const after = await open(h, { "Last-Event-ID": r.id! });
    h.emitKbChanged(["c"]); // seq 4
    expect((await after.next(1))[0].data).toMatchObject({ type: "kb.changed", entryIds: ["c"], id: 4 });
    after.close();
    const post = await open(h, { "Last-Event-ID": `${boot}:4` });
    h.emitKbChanged(["d"]);
    expect((await post.next(1))[0].data.entryIds).toEqual(["d"]);
    post.close();
  });

  it("the stream cap refuses with 409 busy (the protocol has no 429), and frees a slot on disconnect", async () => {
    const h = await start({ maxEventStreams: 2 });
    const a = await open(h);
    const b = await open(h);
    const c = await open(h);
    expect(c.res.status).toBe(409);
    expect(((await c.res.json()) as { code: string; retryable: boolean })).toMatchObject({ code: "busy", retryable: true });
    a.close();
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await settle(50);
      const d = await open(h);
      ok = d.res.status === 200;
      d.close();
    }
    expect(ok).toBe(true);
    b.close();
  });

  it("close() with an open stream ends it and does not hang", async () => {
    const h = await start();
    const s = await open(h);
    h.emitKbChanged(["x"]);
    await s.next(1);
    const t0 = Date.now();
    await h.close();
    servers.splice(servers.indexOf(h), 1);
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(s.next(1)).rejects.toThrow(); // stream ended
  });
});

/** A ServerResponse stand-in for bus-level tests. */
function fakeRes(over: Partial<{ writableLength: number; write: (s: string) => boolean }> = {}) {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    written: [] as string[],
    writeHead: vi.fn(),
    write(s: string) {
      this.written.push(s);
      return true;
    },
    end() {
      this.writableEnded = true;
      this.emit("close");
    },
    destroy() {
      this.destroyed = true;
      this.emit("close");
    },
    ...over,
  });
  return res as typeof res & ServerResponse;
}

describe("event bus", () => {
  it("disconnect removes the subscriber and clears its keepalive timer", () => {
    vi.useFakeTimers();
    const bus = createEventBus();
    const res = fakeRes();
    bus.attach(res as unknown as ServerResponse, undefined);
    expect(bus.streamCount).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    res.emit("close");
    expect(bus.streamCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    bus.emit({ type: "kb.changed", entryIds: ["x"] });
    expect(res.written.join("")).not.toContain("kb.changed");
  });

  it("a backed-up client is destroyed and the others keep receiving", () => {
    const bus = createEventBus();
    const slow = fakeRes({ writableLength: 2_000_000 });
    const fine = fakeRes();
    bus.attach(slow as unknown as ServerResponse, undefined);
    bus.attach(fine as unknown as ServerResponse, undefined);
    bus.emit({ type: "kb.changed", entryIds: ["x"] });
    expect(slow.destroyed).toBe(true);
    expect(bus.streamCount).toBe(1);
    expect(fine.written.join("")).toContain('"entryIds":["x"]');
  });

  it("a subscriber that throws is destroyed; the batch continues and the sequence has no gap", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = createEventBus();
    const bad = fakeRes({
      write(this: { written: string[] }, s: string) {
        if (s.startsWith("id:")) throw new Error("EPIPE");
        return true;
      },
    });
    const good = fakeRes();
    bus.attach(bad as unknown as ServerResponse, undefined);
    bus.attach(good as unknown as ServerResponse, undefined);
    bus.workAppended([
      { type: "created", id: "work-a-1111" },
      { type: "staged", id: "work-a-1111" },
    ]);
    expect(bad.destroyed).toBe(true);
    const ids = [...good.written.join("").matchAll(/^id: \w+:(\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([1, 2]);
  });
});
