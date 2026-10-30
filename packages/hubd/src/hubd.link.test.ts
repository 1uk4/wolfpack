/** Worker link contract: upgrade auth, hello/welcome, registration, presence, replace, revoke, bad frames. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ACTOR_HEADER, LINK_PROTOCOL_VERSION, parseLinkFrame, type LinkFrame, type LinkPresence } from "@wolfpack/protocol";
import { createTokenStore } from "./auth.js";
import { createHubServer, type HubServer } from "./server.js";

const KEY = "legacy-key-0123456789";
let dir = "";
let hub: HubServer;
let store: ReturnType<typeof createTokenStore>;
const open: WebSocket[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-link-"));
  hub = await createHubServer({ dataDir: dir, apiKey: KEY, port: 0, authPollMs: 30, linkTimers: { heartbeatMs: 50, deadAfterMs: 250, helloTimeoutMs: 200 } });
  store = createTokenStore(dir);
});
afterEach(async () => {
  for (const w of open.splice(0)) w.terminate();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function mint(kind: "worker" | "console", hostId?: string) {
  const { code } = store.mintPairingCode({ kind, ...(hostId ? { hostId } : {}) });
  const r = store.redeem(code, "t", kind, hostId);
  return { token: r.token, tokenId: r.tokenId };
}
const wsUrl = () => hub.url.replace("http", "ws") + "/v1/link";

class Conn {
  frames: LinkFrame[] = [];
  closed?: number;
  constructor(readonly ws: WebSocket) {
    open.push(ws);
    ws.on("message", (d) => {
      const p = parseLinkFrame(d.toString());
      if (p.ok) this.frames.push(p.frame);
    });
    ws.on("close", (c) => (this.closed = c));
  }
  send(f: unknown) {
    this.ws.send(typeof f === "string" ? f : JSON.stringify(f));
  }
  async until(cond: () => unknown, what: string, ms = 3000) {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  frame<T extends LinkFrame["t"]>(t: T) {
    return this.frames.find((f) => f.t === t) as Extract<LinkFrame, { t: T }> | undefined;
  }
}
async function connect(token: string): Promise<Conn> {
  const ws = new WebSocket(wsUrl(), { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((res, rej) => (ws.once("open", () => res()), ws.once("error", rej)));
  return new Conn(ws);
}
const hello = (hostId: string, extra: Record<string, unknown> = {}) => ({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId, laptop: false, wolves: [], kbRevisions: {}, ...extra });
async function join_(token: string, hostId: string, extra: Record<string, unknown> = {}) {
  const c = await connect(token);
  c.send(hello(hostId, extra));
  await c.until(() => c.frame("welcome"), "welcome");
  return c;
}
const reg = async (p: string) => (await (await fetch(`${hub.url}/v1/registry/${p}`, { headers: { "X-API-Key": KEY } })).json()) as Record<string, any>;
const watch = () => {
  const seen: Array<[string, LinkPresence]> = [];
  hub.link.onPresence((h, p) => seen.push([h, p]));
  return seen;
};
const rejectedWith = (headers: Record<string, string>) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(wsUrl(), { headers });
    ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {});
  });

describe("hubd worker link", () => {
  it("authenticates before upgrading: no token 401, legacy key / console token / hostless worker 403", async () => {
    expect(await rejectedWith({})).toBe(401);
    expect(await rejectedWith({ Authorization: "Bearer nope" })).toBe(401);
    expect(await rejectedWith({ "X-API-Key": KEY })).toBe(403);
    expect(await rejectedWith({ Authorization: `Bearer ${(await mint("console")).token}` })).toBe(403);
    expect(await fetch(`${hub.url}/v1/other`, { headers: { Upgrade: "websocket", Connection: "Upgrade" } }).then((r) => r.status).catch(() => 0)).not.toBe(101);
  });

  it("hello registers the host and its wolves, welcome carries heartbeat and retired; presence goes online", async () => {
    const seen = watch();
    const { token } = await mint("worker", "box");
    const c = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }, { name: "beta", domains: ["nope"] }] });
    expect(c.frame("welcome")).toMatchObject({ v: LINK_PROTOCOL_VERSION, heartbeatMs: 50, deadAfterMs: 250, retired: [] });
    expect((await reg("hosts")).hosts.map((h: any) => h.name)).toEqual(["box"]);
    const wolves = (await reg("wolves")).wolves;
    expect(wolves.map((w: any) => [w.name, w.host, w.domains])).toEqual([["alpha", "box", []], ["beta", "box", []]]); // unknown domain dropped
    expect(hub.link.presence("box")).toBe("online");
    expect(seen).toEqual([["box", "online"]]);
  });

  it("rejects a hello for another host id (4401) and a major version mismatch (4001, error frame first)", async () => {
    const { token } = await mint("worker", "box");
    const a = await connect(token);
    a.send(hello("other"));
    await a.until(() => a.closed !== undefined, "close");
    expect(a.closed).toBe(4401);
    const b = await connect(token);
    b.send(hello("box", { v: 2 }));
    await b.until(() => b.closed !== undefined, "close");
    expect(b.closed).toBe(4001);
    expect(b.frame("error")?.code).toBe("version_mismatch");
    expect(hub.link.presence("box")).toBe("offline");
  });

  it("no hello within the timeout closes 4400", async () => {
    const c = await connect((await mint("worker", "box")).token);
    await c.until(() => c.closed !== undefined, "close");
    expect(c.closed).toBe(4400);
  });

  it("an unknown frame gets error bad_frame and the link stays up; ping is answered", async () => {
    const c = await join_((await mint("worker", "box")).token, "box");
    c.send({ t: "nonsense" });
    c.send("not json");
    c.send({ t: "ping", n: 7 });
    await c.until(() => c.frame("pong"), "pong");
    expect(c.frames.filter((f) => f.t === "error").map((f) => (f as any).code)).toEqual(["bad_frame", "bad_frame"]);
    expect(c.closed).toBeUndefined();
  });

  it("the hub pings; any traffic keeps the link alive, silence past deadAfter drops it to offline", async () => {
    const seen = watch();
    const c = await join_((await mint("worker", "box")).token, "box");
    await c.until(() => c.frame("ping"), "hub ping");
    const stop = setInterval(() => c.send({ t: "pong", n: 0 }), 50);
    await new Promise((r) => setTimeout(r, 400));
    expect(hub.link.presence("box")).toBe("online");
    clearInterval(stop);
    await c.until(() => c.closed !== undefined, "dead drop", 2000);
    expect(hub.link.presence("box")).toBe("offline");
    expect(seen.at(-1)).toEqual(["box", "offline"]);
  });

  it("a clean close is asleep for a laptop and offline otherwise; a sleep frame is asleep", async () => {
    const lap = await join_((await mint("worker", "lap")).token, "lap", { laptop: true });
    lap.send({ t: "bye" });
    lap.ws.close(1000);
    await lap.until(() => lap.closed !== undefined, "close");
    expect(hub.link.presence("lap")).toBe("asleep");
    const srv = await join_((await mint("worker", "srv")).token, "srv", { laptop: false });
    srv.ws.close(1000);
    await srv.until(() => srv.closed !== undefined, "close");
    expect(hub.link.presence("srv")).toBe("offline");
    const sl = await join_((await mint("worker", "sl")).token, "sl");
    sl.send({ t: "sleep" });
    await sl.until(() => hub.link.presence("sl") === "asleep", "asleep");
    sl.ws.terminate();
    await sl.until(() => sl.closed !== undefined, "close");
    expect(hub.link.presence("sl")).toBe("asleep");
  });

  it("wolf.add / wolf.remove register and clear the host; omitted wolves in a later hello are cleared, not deleted", async () => {
    const { token } = await mint("worker", "box");
    const c = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }] });
    c.send({ t: "wolf.add", wolf: { name: "gamma", domains: [] } });
    await c.until(async () => true, "tick");
    await new Promise((r) => setTimeout(r, 100));
    expect((await reg("wolves")).wolves.map((w: any) => w.name).sort()).toEqual(["alpha", "gamma"]);
    c.send({ t: "wolf.remove", name: "gamma" });
    await new Promise((r) => setTimeout(r, 100));
    const g = (await reg("wolves")).wolves.find((w: any) => w.name === "gamma");
    expect(g).toBeDefined();
    expect(g.host).toBeUndefined();
    c.ws.terminate();
    const d = await join_(token, "box", { wolves: [] });
    expect((await reg("wolves")).wolves.find((w: any) => w.name === "alpha").host).toBeUndefined();
    d.ws.terminate();
  });

  it("a retired wolf is never resurrected and is listed in welcome.retired", async () => {
    const { token } = await mint("worker", "box");
    const c = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }] });
    c.ws.terminate();
    const op = { "X-API-Key": KEY, "Content-Type": "application/json", [ACTOR_HEADER]: JSON.stringify({ id: "op", kind: "operator" }) };
    expect((await fetch(`${hub.url}/v1/registry/wolves/alpha/retire`, { method: "POST", headers: op })).status).toBe(200);
    const d = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }] });
    expect(d.frame("welcome")?.retired).toEqual(["alpha"]);
    const a = (await reg("wolves")).wolves.find((w: any) => w.name === "alpha");
    expect(a.status).toBe("retired");
  });

  it("a newer connection from the same host replaces the old one (4409) without flipping presence offline", async () => {
    const seen = watch();
    const { token } = await mint("worker", "box");
    const a = await join_(token, "box");
    const b = await join_(token, "box");
    await a.until(() => a.closed !== undefined, "old closed");
    expect(a.closed).toBe(4409);
    expect(a.frame("error")?.code).toBe("replaced");
    expect(hub.link.presence("box")).toBe("online");
    expect(seen).toEqual([["box", "online"]]);
    b.ws.terminate();
  });

  it("revoking the token closes the link with 4401", async () => {
    const { token, tokenId } = await mint("worker", "box");
    const c = await join_(token, "box");
    store.revoke(tokenId);
    await c.until(() => c.closed !== undefined, "revoke close");
    expect(c.closed).toBe(4401);
    await c.until(() => hub.link.presence("box") === "offline", "offline");
  });

  it("close() ends open links", async () => {
    const c = await join_((await mint("worker", "box")).token, "box");
    await hub.close();
    await c.until(() => c.closed !== undefined, "closed");
    hub = await createHubServer({ dataDir: dir, apiKey: KEY, port: 0 });
  });
});
