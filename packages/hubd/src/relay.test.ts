/** Hub relay unit tests with a stub link: exact control over the frames the "worker" sends. */
import { createServer, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkFrame } from "@wolfpack/protocol";
import type { Link } from "./link.js";
import { createRelay } from "./relay.js";

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

function setup(hostBuffered?: number) {
  const sent: LinkFrame[] = [];
  const link = { presence: () => "online", epoch: () => 1, relayHeadTimeoutMs: 60_000, sendToHost: (_h: string, f: LinkFrame) => (sent.push(f), true) } as unknown as Link;
  const registry = { get: () => ({ host: "h" }) } as any;
  const relay = createRelay({ link, registry, hostBuffered, log: () => {} });
  const responses = new Map<string, ServerResponse>();
  const server: Server = createServer((req, res) => {
    relay.handle(req, res, "w", req.url!).catch(() => res.destroy());
    setImmediate(() => {
      const f = sent.find((x) => x.t === "req" && x.path === req.url) as any;
      if (f) responses.set(req.url!, res);
    });
  });
  closers.push(() => (server.closeAllConnections(), server.close()));
  const listening = new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
  const idOf = async (path: string) => {
    for (let i = 0; i < 200; i++) {
      const f = sent.find((x) => x.t === "req" && x.path === path) as any;
      if (f) return f.id as string;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("no req frame");
  };
  const chunk = (id: string, seq: number, kb = 128) => relay.onFrame("h", 1, { t: "chunk", id, seq, enc: "b64", data: Buffer.alloc(kb * 1024, 97).toString("base64") });
  const head = (id: string) => relay.onFrame("h", 1, { t: "res", id, status: 200, headers: {} });
  const get = async (path: string, paused: boolean) => {
    const port = await listening;
    let bytes = 0;
    let state: "open" | "end" | "error" = "open";
    let resp: import("node:http").IncomingMessage | undefined;
    const q = request({ hostname: "127.0.0.1", port, path }, (x) => {
      resp = x;
      if (paused) x.pause();
      x.on("data", (b) => (bytes += b.length));
      x.on("end", () => (state = "end"));
      x.on("error", () => (state = "error"));
      x.on("aborted", () => (state = "error"));
      x.on("close", () => state === "open" && (state = x.complete ? "end" : "error"));
    });
    q.on("error", () => (state = "error"));
    q.end();
    return { read: () => resp?.resume(), pause: () => resp?.pause(), state: () => state, bytes: () => bytes };
  };
  return { relay, sent, responses, idOf, chunk, head, get };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("hub relay flow control", () => {
  it("pause and resume strictly alternate (one per paused state) and the last state is resumed once the client drains", async () => {
    const t = setup();
    const c = await t.get("/a", true);
    const id = await t.idOf("/a");
    t.head(id);
    await sleep(20);
    let seq = 0;
    while (!t.sent.some((f) => f.t === "pause") && seq < 400) {
      t.chunk(id, seq++);
      if (seq % 8 === 0) await sleep(1);
    }
    expect(t.sent.some((f) => f.t === "pause")).toBe(true);
    for (let i = 0; i < 20; i++) {
      t.chunk(id, seq++); // lots more data while (possibly) paused
      if (i % 5 === 0) await sleep(2);
    }
    c.read();
    await sleep(300);
    const flow = t.sent.filter((f) => f.t === "pause" || f.t === "resume").map((f) => f.t);
    expect(flow.length).toBeGreaterThanOrEqual(2);
    flow.forEach((x, i) => expect(x).toBe(i % 2 === 0 ? "pause" : "resume")); // never two pauses or two resumes in a row
    expect(flow.at(-1)).toBe("resume");
  });

  it("host cap: the slow hog is cut, not the fast innocent stream whose chunk crossed the cap", async () => {
    const t = setup(4 * 1024 * 1024);
    const hog = await t.get("/hog", true);
    const fast = await t.get("/fast", false);
    const hogId = await t.idOf("/hog");
    const fastId = await t.idOf("/fast");
    t.head(hogId);
    t.head(fastId);
    await sleep(20);
    const hogRes = t.responses.get("/hog")!;
    let seq = 0;
    // Fill the hog's queue to ~3.9 MB, just under the 4 MB test cap (socket buffers absorb the first part).
    while (hogRes.writableLength < 3.9 * 1024 * 1024 && seq < 20000) {
      t.chunk(hogId, seq++, 16);
      if (seq % 64 === 0) await sleep(1);
    }
    expect(hogRes.writableLength).toBeGreaterThanOrEqual(3.9 * 1024 * 1024);
    expect(hog.state()).toBe("open");
    // The innocent keeps streaming; its own queue stays small, but the host total crosses 4 MB.
    for (let i = 0; i < 40; i++) {
      t.chunk(fastId, i);
      await sleep(5);
    }
    await sleep(100);
    expect(t.sent.filter((f) => f.t === "cancel").map((f: any) => f.id)).toEqual([hogId]);
    expect(hogRes.destroyed).toBe(true);
    expect(t.responses.get("/fast")!.destroyed).toBe(false);
    t.relay.onFrame("h", 1, { t: "end", id: fastId });
    await sleep(100);
    expect(fast.state()).toBe("end");
    expect(fast.bytes()).toBe(40 * 128 * 1024);
  });
});
