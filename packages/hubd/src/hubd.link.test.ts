/** Worker link contract: upgrade auth, hello/welcome, registration rules, presence, replace, revoke, bad frames. */
import { request } from "node:http";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LINK_PROTOCOL_VERSION, parseLinkFrame, type LinkFrame, type LinkPresence } from "@wolfpack/protocol";
import { createTokenStore } from "./auth.js";
import { registryFile } from "./layout.js";
import { createHubServer, type HubServer } from "./server.js";
import { OP as OP_AUTH, seedTokens } from "./testing/tokens.js";

const OP = { ...OP_AUTH, "Content-Type": "application/json" };
let dir = "";
let hub: HubServer;
let hubClosed = false;
let store: ReturnType<typeof createTokenStore>;
const open: WebSocket[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hubd-link-"));
  hubClosed = false;
  seedTokens(dir);
  hub = await createHubServer({ dataDir: dir, port: 0, authPollMs: 30, linkTimers: { heartbeatMs: 100, deadAfterMs: 1000, helloTimeoutMs: 400, asleepOfflineMs: 600 } });
  store = createTokenStore(dir);
});
afterEach(async () => {
  for (const w of open.splice(0)) w.terminate();
  try {
    chmodSync(dirname(registryFile(dir)), 0o755);
  } catch {
    /* not created */
  }
  if (!hubClosed) await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function mint(kind: "worker" | "console", hostId?: string) {
  const { code } = store.mintPairingCode({ kind, ...(hostId ? { hostId } : {}) });
  const r = store.redeem(code, "t", kind, hostId);
  return { token: r.token, tokenId: r.tokenId };
}
const wsUrl = () => hub.url.replace("http", "ws") + "/v1/link";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(cond: () => unknown | Promise<unknown>, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(15);
  }
}

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
  until(cond: () => unknown, what: string, ms = 4000) {
    return eventually(cond, what, ms);
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
const reg = async (p: string) => (await (await fetch(`${hub.url}/v1/registry/${p}`, { headers: OP })).json()) as Record<string, any>;
/** The operator creates wolves (and any domains they need) up front. */
async function register(name: string, domains: string[] = [], host?: string) {
  const r = await fetch(`${hub.url}/v1/registry/wolves`, { method: "POST", headers: OP, body: JSON.stringify({ name, domains, ...(host ? { host } : {}) }) });
  if (!r.ok) throw new Error(`register ${name}: ${r.status} ${await r.text()}`);
}
async function domain(name: string) {
  expect((await fetch(`${hub.url}/v1/registry/domains`, { method: "POST", headers: OP, body: JSON.stringify({ name }) })).ok).toBe(true);
}
const wolfOf = async (name: string) => (await reg("wolves")).wolves.find((w: any) => w.name === name);
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

describe("hubd worker link: upgrade", () => {
  it("authenticates before upgrading: no token 401, the old shared key 401, console token 403", async () => {
    expect(await rejectedWith({})).toBe(401);
    expect(await rejectedWith({ Authorization: "Bearer nope" })).toBe(401);
    expect(await rejectedWith({ "X-API-Key": "legacy-key-0123456789" })).toBe(401);
    expect(await rejectedWith({ Authorization: `Bearer ${(await mint("console")).token}` })).toBe(403);
  });

  it("an upgrade on any other path is a 404", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${hub.url}/v1/other`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
      req.on("response", (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on("upgrade", () => reject(new Error("upgraded")));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(404);
  });
});

describe("hubd worker link: hello and registration", () => {
  it("registers the host and its pre-registered wolves; welcome carries heartbeat; presence goes online", async () => {
    await register("alpha");
    const seen = watch();
    const { token } = await mint("worker", "box");
    const c = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }] });
    expect(c.frame("welcome")).toMatchObject({ v: LINK_PROTOCOL_VERSION, heartbeatMs: 100, deadAfterMs: 1000, retired: [], rejected: [], domainMismatch: [] });
    expect((await reg("hosts")).hosts.map((h: any) => h.name)).toEqual(["box"]);
    expect((await wolfOf("alpha")).host).toBe("box");
    expect(hub.link.presence("box")).toBe("online");
    expect(seen).toEqual([["box", "online"]]);
  });

  it("GET /v1/wolves returns the librarian/kbReadable the worker reported (old-shape wolves claim nothing; offline claims nothing)", async () => {
    await register("dewey");
    await register("mirror");
    await register("plain");
    const flags = async () => Object.fromEntries(((await (await fetch(`${hub.url}/v1/wolves`, { headers: OP })).json()) as any).wolves.map((w: any) => [w.name, [w.status, w.librarian, w.kbReadable]]));
    const c = await join_((await mint("worker", "box")).token, "box", {
      wolves: [{ name: "dewey", domains: [], librarian: true }, { name: "mirror", domains: [], kbReadable: true }, { name: "plain", domains: [] }],
    });
    expect(await flags()).toEqual({ dewey: ["online", true, true], mirror: ["online", false, true], plain: ["online", false, false] });
    c.send({ t: "wolf.add", wolf: { name: "plain", domains: [], kbReadable: true } }); // a later wolf.add updates the flags
    await c.until(async () => (await flags()).plain[2] === true, "wolf.add flags");
    c.ws.close();
    await c.until(async () => (await flags()).dewey[0] === "offline", "offline");
    expect((await flags()).dewey).toEqual(["offline", false, false]);
  });

  it("an unknown wolf is not created (no name squatting): rejected in welcome, and on wolf.add", async () => {
    await register("alpha");
    const c = await join_((await mint("worker", "box")).token, "box", { wolves: [{ name: "alpha", domains: [] }, { name: "squat", domains: [] }] });
    expect(c.frame("welcome")?.rejected).toEqual(["squat"]);
    c.send({ t: "wolf.add", wolf: { name: "squat2", domains: [] } });
    await c.until(() => c.frames.some((f) => f.t === "error" && f.code === "rejected"), "wolf.add rejected");
    expect((await reg("wolves")).wolves.map((w: any) => w.name)).toEqual(["alpha"]);
  });

  it("two hosts claim one wolf: the second is refused, the wolf stays on the first (even while the first is asleep)", async () => {
    await register("alpha");
    const a = await join_((await mint("worker", "box")).token, "box", { laptop: true, wolves: [{ name: "alpha", domains: [] }] });
    a.send({ t: "sleep" });
    await a.until(() => hub.link.presence("box") === "asleep", "asleep");
    const b = await join_((await mint("worker", "evil")).token, "evil", { wolves: [{ name: "alpha", domains: [] }] });
    expect(b.frame("welcome")?.rejected).toEqual(["alpha"]);
    b.send({ t: "wolf.add", wolf: { name: "alpha", domains: [] } });
    await b.until(() => b.frames.some((f) => f.t === "error" && f.code === "rejected"), "refused");
    expect((await wolfOf("alpha")).host).toBe("box");
    expect(hub.link.sendToWolf("alpha", { t: "ping", n: 1 })).toBe(true); // routed to box, not evil
    await a.until(() => a.frames.some((f) => f.t === "ping" && f.n === 1), "ping reached box");
    expect(b.frames.some((f) => f.t === "ping" && f.n === 1)).toBe(false);
  });

  it("the registry owns domains: a reported domain is not granted, an empty report does not wipe them, mismatches are listed", async () => {
    await domain("wolfpack");
    await domain("snapjack");
    await register("alpha", ["wolfpack"]);
    await register("beta", ["wolfpack"]);
    const c = await join_((await mint("worker", "box")).token, "box", { wolves: [{ name: "alpha", domains: ["wolfpack", "snapjack"] }, { name: "beta", domains: [] }] });
    const mm = c.frame("welcome")!.domainMismatch;
    expect(mm).toEqual([
      { wolf: "alpha", reported: ["snapjack", "wolfpack"], granted: ["wolfpack"] },
      { wolf: "beta", reported: [], granted: ["wolfpack"] },
    ]);
    expect((await wolfOf("alpha")).domains).toEqual(["wolfpack"]);
    expect((await wolfOf("beta")).domains).toEqual(["wolfpack"]);
    const subs = (await reg("subscriptions")).subscriptions;
    expect(subs.filter((s: any) => s.domain === "snapjack")).toEqual([]);
    c.send({ t: "wolf.add", wolf: { name: "alpha", domains: ["snapjack"] } });
    await sleep(100);
    expect((await wolfOf("alpha")).domains).toEqual(["wolfpack"]);
  });

  it("wolf.remove clears the host (entry kept); omitted wolves in a later hello are cleared, not deleted", async () => {
    await register("alpha");
    await register("gamma");
    const { token } = await mint("worker", "box");
    const c = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }] });
    c.send({ t: "wolf.add", wolf: { name: "gamma", domains: [] } });
    await eventually(async () => (await wolfOf("gamma")).host === "box", "gamma added");
    c.send({ t: "wolf.remove", name: "gamma" });
    await eventually(async () => (await wolfOf("gamma")).host === undefined, "gamma cleared");
    c.ws.terminate();
    const d = await join_(token, "box", { wolves: [] });
    await eventually(async () => (await wolfOf("alpha")).host === undefined, "alpha cleared by omission");
    expect(await wolfOf("alpha")).toBeDefined();
    d.ws.terminate();
  });

  it("a retired wolf is never resurrected and is listed in welcome.retired", async () => {
    await register("alpha");
    const { token } = await mint("worker", "box");
    const c = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }] });
    c.ws.terminate();
    expect((await fetch(`${hub.url}/v1/registry/wolves/alpha/retire`, { method: "POST", headers: OP })).status).toBe(200);
    const d = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }] });
    expect(d.frame("welcome")?.retired).toEqual(["alpha"]);
    expect((await wolfOf("alpha")).status).toBe("retired");
  });

  it("a failing registration leaves the existing connection untouched (no zombie replace)", async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    await register("alpha");
    const { token } = await mint("worker", "box");
    const a = await join_(token, "box"); // box online, alpha unowned
    chmodSync(dirname(registryFile(dir)), 0o500); // registry writes now fail
    const b = await connect(token);
    b.send(hello("box", { wolves: [{ name: "alpha", domains: [] }] })); // would change the registry
    await b.until(() => b.closed !== undefined, "b dropped");
    expect(b.frames.some((f) => f.t === "error" && f.code === "internal")).toBe(true);
    expect(b.closed).toBe(1011);
    expect(a.closed).toBeUndefined();
    expect(hub.link.presence("box")).toBe("online");
  });
});

describe("hubd worker link: handshake rules", () => {
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

  it("a future hello shape with an incompatible version still gets 4001", async () => {
    const c = await connect((await mint("worker", "box")).token);
    c.send({ t: "hello", v: 7, hostId: "box", wolves: "a different shape now" });
    await c.until(() => c.closed !== undefined, "close");
    expect(c.closed).toBe(4001);
    expect(c.frame("error")?.code).toBe("version_mismatch");
  });

  it("a hello over the wolf cap is a bad_frame, not fatal", async () => {
    const c = await connect((await mint("worker", "box")).token);
    c.send(hello("box", { wolves: Array.from({ length: 257 }, (_, i) => ({ name: `w${i}`, domains: [] })) }));
    await c.until(() => c.frame("error"), "error");
    expect(c.frame("error")?.code).toBe("bad_frame");
    expect(c.closed).toBeUndefined();
  });

  it("a big frame before the hello closes 1009; after the hello larger frames are accepted", async () => {
    const a = await connect((await mint("worker", "box")).token);
    a.send(JSON.stringify({ t: "hello", pad: "x".repeat(100_000) }));
    await a.until(() => a.closed !== undefined, "close");
    expect(a.closed).toBe(1009);
    const b = await join_((await mint("worker", "box2")).token, "box2");
    b.send(JSON.stringify({ t: "chunk", id: "w-1", data: "x".repeat(100_000), seq: 0 })); // a valid relay frame, ignored
    b.send({ t: "ping", n: 5 });
    await b.until(() => b.frames.some((f) => f.t === "pong" && f.n === 5), "still alive after a 100KB frame");
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
});

describe("hubd worker link: presence", () => {
  it("the hub pings; steady traffic keeps the link alive, silence past deadAfter drops it to offline", async () => {
    const seen = watch();
    const c = await join_((await mint("worker", "box")).token, "box");
    await c.until(() => c.frame("ping"), "hub ping");
    const keep = setInterval(() => c.send({ t: "pong", n: 0 }), 100);
    await sleep(1600); // well past deadAfter (1000ms): only the traffic keeps it up
    expect(hub.link.presence("box")).toBe("online");
    clearInterval(keep);
    await c.until(() => c.closed !== undefined, "dead drop", 3000);
    expect(hub.link.presence("box")).toBe("offline");
    expect(seen.at(-1)).toEqual(["box", "offline"]);
  });

  it("a clean close is asleep for a laptop and offline otherwise; a sleep frame is asleep even after an unclean drop", async () => {
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

  it("ping/pong does not undo asleep; asleep turns offline after asleepOfflineMs; a new hello is online again", async () => {
    const { token } = await mint("worker", "box");
    const c = await join_(token, "box");
    c.send({ t: "sleep" });
    await c.until(() => hub.link.presence("box") === "asleep", "asleep");
    c.send({ t: "ping", n: 1 });
    c.send({ t: "pong", n: 0 });
    await c.until(() => c.frames.some((f) => f.t === "pong"), "pong");
    expect(hub.link.presence("box")).toBe("asleep");
    await eventually(() => hub.link.presence("box") === "offline", "asleep -> offline (600ms in this test)", 3000);
    c.ws.terminate();
    const d = await join_(token, "box");
    expect(hub.link.presence("box")).toBe("online");
    d.ws.terminate();
  });

  it("work frames after a sleep frame bring the host back online; an active link is not flipped offline by the asleep timer", async () => {
    await register("alpha");
    const { token } = await mint("worker", "box");
    const c = await join_(token, "box", { wolves: [{ name: "alpha", domains: [] }] });
    c.send({ t: "sleep" });
    await c.until(() => hub.link.presence("box") === "asleep", "asleep");
    c.send({ t: "wolf.add", wolf: { name: "alpha", domains: [] } });
    await c.until(() => hub.link.presence("box") === "online", "online after wolf.add");
    // Asleep again, but the link keeps sending non-ping frames: the timer (600ms) must not take it offline.
    c.send({ t: "sleep" });
    await c.until(() => hub.link.presence("box") === "asleep", "asleep again");
    const keep = setInterval(() => c.send({ t: "wolf.remove", name: "nobody" }), 100);
    await sleep(1000); // past asleepOfflineMs
    clearInterval(keep);
    expect(hub.link.presence("box")).not.toBe("offline");
    expect(c.closed).toBeUndefined();
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
    await eventually(() => hub.link.presence("box") === "offline", "offline");
  });

  it("close() ends open links", async () => {
    const c = await join_((await mint("worker", "box")).token, "box");
    hubClosed = true;
    await hub.close();
    await c.until(() => c.closed !== undefined, "closed");
  });
});
