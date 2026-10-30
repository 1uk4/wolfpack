import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { HubLink, linkBackoff } from "./link.js";
import { insecureHubWarning, loadHubConfig, pairWithHub } from "./hub-config.js";
import { startWakeMonitor } from "./wake.js";
import { makeWolves, until } from "./testing/helpers.js";
import { startLinkRig, type LinkRig } from "./testing/link-rig.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function rig(o: Parameters<typeof startLinkRig>[0] = {}): Promise<LinkRig> {
  const r = await startLinkRig(o);
  cleanup.push(() => r.close());
  return r;
}
const names = async (r: LinkRig) => (await r.registry("wolves")).map((w) => [w.name, w.host ?? null]);

describe("worker link (hubd + workerd + fake wolf)", () => {
  it("registers the host and its pre-registered wolves and goes online; the wolf stays reachable through workerd", async () => {
    const r = await rig({ wolves: ["alpha", "beta"] });
    await r.waitPresence("online");
    expect((await r.registry("hosts")).map((h) => h.name)).toEqual(["box"]);
    expect(await names(r)).toEqual([["alpha", "box"], ["beta", "box"]]);
    expect(r.workerd.link!.status().state).toBe("online");
    await r.workerd.supervisor.whenSettled();
    expect((await r.client.listWolves()).map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("a retired wolf is not resurrected on reconnect and stays retired", async () => {
    const r = await rig({ wolves: ["alpha"] });
    await r.waitPresence("online");
    expect((await fetch(`${r.hub.url}/v1/registry/wolves/alpha/retire`, { method: "POST", headers: r.operator })).status).toBe(200);
    r.workerd.link!.kick();
    await r.eventually(async () => r.presence() === "online" && (await r.registry("wolves"))[0].status === "retired", "reconnected, still retired");
  });

  it("an unregistered wolf is not created (name squatting) and a wolf of another host is refused (hijack)", async () => {
    const r = await rig({ wolves: ["alpha"], noHub: true });
    const a = await r.rawLink(r.token);
    a.hello({ wolves: [{ name: "alpha", domains: [] }, { name: "squat", domains: [] }] });
    await a.until(() => a.frames.some((f) => f.t === "welcome"), "welcome a");
    expect((a.frames.find((f) => f.t === "welcome") as any).rejected).toEqual(["squat"]);
    expect(await names(r)).toEqual([["alpha", "box"]]); // squat not created
    // A second host claims alpha: refused, alpha stays on box.
    const other = r.mintWorker("evil");
    const b = await r.rawLink(other.token);
    b.hello({ hostId: "evil", wolves: [{ name: "alpha", domains: [] }] });
    await b.until(() => b.frames.some((f) => f.t === "welcome"), "welcome b");
    expect((b.frames.find((f) => f.t === "welcome") as any).rejected).toEqual(["alpha"]);
    b.send({ t: "wolf.add", wolf: { name: "alpha", domains: [] } });
    await b.until(() => b.frames.some((f) => f.t === "error" && (f as any).code === "rejected"), "wolf.add refused");
    expect(await names(r)).toEqual([["alpha", "box"]]);
  });

  it("a major version mismatch is rejected (4001); the worker reports hub incompatible, stays incompatible and keeps retrying", async () => {
    const r = await rig({ noHub: true });
    const Skewed = class extends WebSocket {
      override send(d: any, ...rest: any[]) {
        return (super.send as any)(typeof d === "string" ? d.replace(/"v":1/, '"v":2') : d, ...rest);
      }
    };
    const logs: string[] = [];
    const link = new HubLink({ hubUrl: r.hub.url, token: r.token, hostId: r.hostId, wolves: () => [], WebSocketImpl: Skewed as typeof WebSocket, baseMs: 10, capMs: 40, log: (m) => logs.push(m) });
    cleanup.push(() => link.stop());
    link.start();
    await until(() => link.status().attempts >= 3, 5000, "backing off");
    expect(link.status().state).toBe("incompatible");
    expect(link.status().detail).toBe("hub incompatible");
    expect(logs.some((l) => l.includes("hub incompatible"))).toBe(true);
    expect(r.presence()).toBe("offline");
  });

  it("silence past the dead-after window turns presence offline", async () => {
    const r = await rig({ noHub: true });
    const raw = await r.rawLink(r.token);
    raw.hello();
    await raw.until(() => raw.frames.some((f) => f.t === "welcome"), "welcome");
    await until(() => raw.closed !== undefined, 5000, "dropped for silence");
    expect(r.presence()).toBe("offline");
  });

  it("a laptop's clean shutdown shows asleep; a non-laptop shows offline", async () => {
    const lap = await rig({ laptop: true, hostId: "lap" });
    await lap.waitPresence("online");
    await lap.workerd.close();
    await lap.waitPresence("asleep");
    const srv = await rig({ laptop: false, hostId: "srv" });
    await srv.waitPresence("online");
    await srv.workerd.close();
    await srv.waitPresence("offline");
  });

  it("wolves added or removed at runtime are registered / cleared", async () => {
    const r = await rig({ wolves: ["alpha"], preRegister: ["gamma"] });
    await r.waitPresence("online");
    const extra = makeWolves("gamma");
    cleanup.push(() => rmSync(extra.root, { recursive: true, force: true }));
    r.workerd.supervisor.addWolf(extra.wolves[0]!);
    await r.eventually(async () => JSON.stringify(await names(r)) === JSON.stringify([["alpha", "box"], ["gamma", "box"]]), "gamma registered");
    await r.workerd.supervisor.removeWolf("gamma");
    await r.eventually(async () => JSON.stringify(await names(r)) === JSON.stringify([["alpha", "box"], ["gamma", null]]), "gamma cleared");
  });

  it("wolves added between the hello snapshot and the welcome are sent after the welcome", async () => {
    const r = await rig({ noHub: true, wolves: ["alpha"], preRegister: ["gamma"] });
    let calls = 0;
    const link = new HubLink({
      hubUrl: r.hub.url, token: r.token, hostId: r.hostId,
      wolves: () => (++calls === 1 ? [{ name: "alpha", domains: [] }] : [{ name: "alpha", domains: [] }, { name: "gamma", domains: [] }]),
    });
    cleanup.push(() => link.stop());
    link.start();
    await r.eventually(async () => JSON.stringify(await names(r)) === JSON.stringify([["alpha", "box"], ["gamma", "box"]]), "gamma synced after welcome");
  });

  it("the newest connection from a host wins (4409 to the old one)", async () => {
    const r = await rig({ noHub: true });
    const a = await r.rawLink(r.token);
    a.hello();
    await a.until(() => a.frames.some((f) => f.t === "welcome"), "welcome");
    const b = await r.rawLink(r.mintWorker().token);
    b.hello();
    await b.until(() => b.frames.some((f) => f.t === "welcome"), "welcome b");
    await a.until(() => a.closed === 4409, "a replaced");
    expect(r.presence()).toBe("online");
  });

  it("a replaced worker goes to the 'replaced' state and retries slowly instead of fighting", async () => {
    const r = await rig({ noHub: true });
    const link = new HubLink({ hubUrl: r.hub.url, token: r.token, hostId: r.hostId, wolves: () => [], baseMs: 20, capMs: 30_000 });
    cleanup.push(() => link.stop());
    link.start();
    await r.waitPresence("online");
    const b = await r.rawLink(r.mintWorker().token);
    b.hello();
    await until(() => link.status().state === "replaced", 5000, "replaced state");
    expect(link.status().nextRetryInMs!).toBeGreaterThan(10_000);
    link.kick(); // a wake must not start the fight again
    expect(link.status().state).toBe("replaced");
    expect(r.presence()).toBe("online");
  });

  it("revoking the token drops the link; the worker stays 'unauthorized' with the re-pair detail across retries", async () => {
    const r = await rig();
    await r.waitPresence("online");
    r.store.revoke(r.tokenId);
    await r.waitPresence("offline");
    await until(() => r.workerd.link!.status().state === "unauthorized", 5000, "unauthorized state");
    r.workerd.link!.kick(); // retry: refused with 401 at the upgrade
    await until(() => r.workerd.link!.status().attempts >= 1 && r.workerd.link!.status().nextRetryInMs !== null, 5000, "retry refused and rescheduled");
    expect(r.workerd.link!.status().state).toBe("unauthorized");
    expect(r.workerd.link!.status().detail).toMatch(/re-pair/);
    expect(r.workerd.link!.status().nextRetryInMs!).toBeGreaterThan(100); // the rig caps at 200ms: retries sit at the cap, not the 20ms base
  });

  it("kick() reconnects at once, skipping a long backoff", async () => {
    const r = await rig({ noHub: true });
    let first: WebSocket | undefined;
    const Capture = class extends WebSocket {
      constructor(...a: ConstructorParameters<typeof WebSocket>) {
        super(...a);
        first ??= this;
      }
    };
    const link = new HubLink({ hubUrl: r.hub.url, token: r.token, hostId: r.hostId, wolves: () => [], WebSocketImpl: Capture as typeof WebSocket, baseMs: 30_000, capMs: 60_000, rand: () => 0.5 });
    cleanup.push(() => link.stop());
    link.start();
    await r.waitPresence("online");
    first!.terminate(); // an unclean drop: the link schedules a 30s backoff
    await until(() => link.status().state === "backoff", 3000, "backoff scheduled");
    expect(link.status().nextRetryInMs!).toBeGreaterThan(20_000);
    link.kick();
    await until(() => link.status().state === "online", 5000, "online again after kick");
  });

  it("a hub that never answers the upgrade hits the connect timeout; one that never sends welcome hits the welcome timeout", async () => {
    const blackhole: Server = createServer(() => {});
    blackhole.on("upgrade", () => {}); // accept the upgrade request and never answer
    await new Promise<void>((res) => blackhole.listen(0, "127.0.0.1", res));
    const socks = new Set<import("node:net").Socket>();
    blackhole.on("connection", (sk) => socks.add(sk));
    cleanup.push(() => new Promise<void>((res) => (blackhole.close(() => res()), socks.forEach((sk) => sk.destroy()))));
    const l1 = new HubLink({ hubUrl: `http://127.0.0.1:${(blackhole.address() as any).port}`, token: "x", hostId: "box", wolves: () => [], connectTimeoutMs: 100, baseMs: 10, capMs: 20 });
    cleanup.push(() => l1.stop());
    l1.start();
    await until(() => l1.status().attempts >= 2, 5000, "connect timeouts");

    const mute = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((res) => mute.once("listening", res));
    cleanup.push(() => new Promise<void>((res) => (mute.clients.forEach((c) => c.terminate()), mute.close(() => res()))));
    const l2 = new HubLink({ hubUrl: `http://127.0.0.1:${(mute.address() as any).port}`, token: "x", hostId: "box", wolves: () => [], welcomeTimeoutMs: 100, baseMs: 10, capMs: 20 });
    cleanup.push(() => l2.stop());
    l2.start();
    await until(() => l2.status().attempts >= 2, 5000, "welcome timeouts");
  });

  it("pair: trades a code for a worker token, stores hub.json 0600 with the host id", async () => {
    const r = await rig({ noHub: true });
    const dir = mkdtempSync(join(tmpdir(), "workerd-pair-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { code } = r.store.mintPairingCode({ kind: "worker", hostId: "newbox" });
    const cfg = await pairWithHub(r.hub.url + "/", code, { dir: join(dir, "cfg"), label: "test-laptop" });
    expect(cfg).toMatchObject({ hubUrl: r.hub.url, hostId: "newbox" });
    expect(loadHubConfig(join(dir, "cfg"))).toEqual(cfg);
    expect(statSync(join(dir, "cfg", "hub.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cfg")).mode & 0o777).toBe(0o700);
    await expect(pairWithHub(r.hub.url, code, { dir })).rejects.toThrow(/pairing failed \(401\)/); // single use
    const link = new HubLink({ ...cfg, wolves: () => [] });
    cleanup.push(() => link.stop());
    link.start();
    await until(() => r.hub.link.presence("newbox") === "online", 5000, "paired link online");
  });

  it("loadHubConfig: missing = unpaired; any other read problem throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "workerd-cfg-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(loadHubConfig(dir)).toBeUndefined();
    mkdirSync(join(dir, "hub.json")); // unreadable as a file (EISDIR): not "unpaired"
    expect(() => loadHubConfig(dir)).toThrow(/cannot read/);
  });

  it("warns about plain http to a non-loopback host only", () => {
    expect(insecureHubWarning("http://hub.example.com:3000")).toMatch(/plain http/);
    expect(insecureHubWarning("http://127.0.0.1:3000")).toBeUndefined();
    expect(insecureHubWarning("http://localhost:3000")).toBeUndefined();
    expect(insecureHubWarning("https://hub.example.com")).toBeUndefined();
  });
});

describe("backoff and wake", () => {
  it("backoff doubles from 1s to a 60s cap with +-20% jitter, never above the cap", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => linkBackoff(n, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(linkBackoff(3, () => 0)).toBe(3200);
    expect(linkBackoff(3, () => 1)).toBe(4800);
    expect(linkBackoff(20, () => 1)).toBe(60000);
  });

  it("wake monitor fires on a wall-clock gap > 15s and on an interface change", () => {
    let t = 1_000_000;
    let net = "a";
    const seen: string[] = [];
    const m = startWakeMonitor({ onWake: (r) => seen.push(r), now: () => t, netHash: () => net, intervalMs: 3_600_000, netPollMs: 3_600_000 });
    t += 5000;
    m.tick();
    expect(seen).toEqual([]);
    t += 60_000;
    m.tick();
    expect(seen).toEqual(["wake"]);
    m.poll();
    expect(seen).toEqual(["wake"]);
    net = "b";
    m.poll();
    expect(seen).toEqual(["wake", "network"]);
    m.stop();
  });
});
