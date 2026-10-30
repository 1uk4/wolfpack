/** Grants pushes with a fake registry: a throwing registry sends nothing, per-change diffing, pruning on disconnect. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LINK_PROTOCOL_VERSION, parseLinkFrame, type LinkFrame } from "@wolfpack/protocol";
import { createLink } from "./link.js";
import type { Registry } from "./registry.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((c) => c()));

function setup() {
  let wolves: unknown[] = [{ name: "w", host: "h", domains: ["alpha"] }];
  let throwing = false;
  let listener: (() => void) | undefined;
  let listCalls = 0;
  const registry = {
    list: () => {
      listCalls++;
      if (throwing) throw new Error("registry down");
      return wolves;
    },
    onChange: (l: () => void) => ((listener = l), () => void (listener = undefined)),
    applyHello: async () => ({ retired: [], rejected: [], domainMismatch: [] }),
    addWolf: async () => "ok",
    removeWolf: async () => {},
    get: () => ({}),
  } as unknown as Registry;
  const link = createLink({ authenticate: () => ({ kind: "worker", hostId: "h", tokenId: "t" }) as never, registry, log: () => {} });
  const srv: Server = createServer();
  srv.on("upgrade", (req, sock, head) => link.handleUpgrade(req, sock, head));
  cleanup.push(() => (link.closeAll(), srv.close()));
  return {
    link,
    srv,
    set: (w: unknown[]) => (wolves = w),
    setThrowing: (v: boolean) => (throwing = v),
    fire: () => listener?.(),
    calls: () => listCalls,
  };
}
async function connect(srv: Server) {
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const ws = new WebSocket(`ws://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/link`);
  const frames: LinkFrame[] = [];
  ws.on("message", (d) => {
    const p = parseLinkFrame(d.toString());
    if (p.ok) frames.push(p.frame);
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId: "h", laptop: false, wolves: [], kbRevisions: {} }));
  cleanup.push(() => ws.terminate());
  return { ws, frames };
}
const until = async (c: () => boolean) => {
  for (let i = 0; i < 100 && !c(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(c()).toBe(true);
};

describe("grants pushes", () => {
  it("welcome carries the union; a change pushes once, with one registry read", async () => {
    const s = setup();
    const { frames } = await connect(s.srv);
    await until(() => frames.some((f) => f.t === "welcome"));
    expect(frames.find((f) => f.t === "welcome")).toMatchObject({ grantedDomains: ["alpha"] });
    s.set([{ name: "w", host: "h", domains: ["alpha", "beta"] }]);
    const before = s.calls();
    s.fire();
    expect(s.calls() - before).toBe(1);
    s.fire(); // unchanged union: nothing more
    await until(() => frames.some((f) => f.t === "grants"));
    expect(frames.filter((f) => f.t === "grants")).toEqual([{ t: "grants", domains: ["alpha", "beta"] }]);
  });

  it("a throwing registry sends no grants (and no empty welcome grant)", async () => {
    const s = setup();
    s.setThrowing(true);
    const { frames } = await connect(s.srv);
    await until(() => frames.some((f) => f.t === "welcome"));
    expect((frames.find((f) => f.t === "welcome") as { grantedDomains?: unknown }).grantedDomains).toBeUndefined();
    s.fire();
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.some((f) => f.t === "grants")).toBe(false);
    // recovery: the next successful change still sends (nothing was cached as [])
    s.setThrowing(false);
    s.fire();
    await until(() => frames.some((f) => f.t === "grants"));
    expect(frames.find((f) => f.t === "grants")).toEqual({ t: "grants", domains: ["alpha"] });
  });

  it("sentGrants is pruned on disconnect: a reconnect with the same union still gets the welcome set", async () => {
    const s = setup();
    const a = await connect(s.srv);
    await until(() => a.frames.some((f) => f.t === "welcome"));
    a.ws.close();
    await until(() => s.link.presence("h") === "offline");
    const port = (s.srv.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/link`);
    const frames: LinkFrame[] = [];
    ws.on("message", (d) => {
      const p = parseLinkFrame(d.toString());
      if (p.ok) frames.push(p.frame);
    });
    cleanup.push(() => ws.terminate());
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId: "h", laptop: false, wolves: [], kbRevisions: {} }));
    await until(() => frames.some((f) => f.t === "welcome"));
    s.set([{ name: "w", host: "h", domains: ["beta"] }]);
    s.fire();
    await until(() => frames.some((f) => f.t === "grants"));
  });
});
