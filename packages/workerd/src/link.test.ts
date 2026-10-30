import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTOR_HEADER } from "@wolfpack/protocol";
import { HubLink, linkBackoff } from "./link.js";
import { loadHubConfig, pairWithHub } from "./hub-config.js";
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
  it("registers the host and its wolves and goes online; the wolf stays reachable through workerd", async () => {
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
    const op = { "X-API-Key": "rig-legacy-key-0123456789", [ACTOR_HEADER]: JSON.stringify({ id: "op", kind: "operator" }) };
    expect((await fetch(`${r.hub.url}/v1/registry/wolves/alpha/retire`, { method: "POST", headers: op })).status).toBe(200);
    r.workerd.link!.kick();
    await r.waitPresence("online");
    await new Promise((x) => setTimeout(x, 100));
    expect((await r.registry("wolves"))[0]).toMatchObject({ name: "alpha", status: "retired" });
  });

  it("a major version mismatch is rejected (4001) and the worker reports hub incompatible and keeps backing off", async () => {
    const r = await rig({ noHub: true });
    const Skewed = class extends WebSocket {
      override send(d: string) {
        super.send(d.replace(/"v":1/, '"v":2'));
      }
    };
    const logs: string[] = [];
    const link = new HubLink({ hubUrl: r.hub.url, token: r.token, hostId: r.hostId, wolves: () => [], WebSocketImpl: Skewed, baseMs: 10, capMs: 40, log: (m) => logs.push(m) });
    cleanup.push(() => link.stop());
    link.start();
    await until(() => link.status().attempts >= 3, 5000, "backing off");
    expect(link.status().state).toMatch(/incompatible|connecting/);
    expect(link.status().detail).toBe("hub incompatible");
    expect(logs.some((l) => l.includes("hub incompatible"))).toBe(true);
    expect(r.presence()).toBe("offline");
  });

  it("silence past the dead-after window turns presence offline", async () => {
    const r = await rig({ noHub: true });
    const raw = await r.rawLink(r.token);
    raw.hello();
    await raw.until(() => raw.frames.some((f) => f.t === "welcome"), "welcome");
    await r.waitPresence("online");
    await r.waitPresence("offline");
    expect(raw.closed).toBeDefined();
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
    const r = await rig({ wolves: ["alpha"] });
    await r.waitPresence("online");
    const extra = makeWolves("gamma");
    r.workerd.supervisor.addWolf(extra.wolves[0]!);
    await until(() => false || (r.hub.link.presence("box") === "online"), 1000, "online");
    for (let i = 0; i < 100 && !(await names(r)).some(([n]) => n === "gamma"); i++) await new Promise((x) => setTimeout(x, 30));
    expect(await names(r)).toEqual([["alpha", "box"], ["gamma", "box"]]);
    await r.workerd.supervisor.removeWolf("gamma");
    for (let i = 0; i < 100 && (await names(r)).some(([n, h]) => n === "gamma" && h); i++) await new Promise((x) => setTimeout(x, 30));
    expect(await names(r)).toEqual([["alpha", "box"], ["gamma", null]]);
    rmSync(extra.root, { recursive: true, force: true });
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

  it("revoking the token drops the link; the worker reports unauthorized", async () => {
    const r = await rig();
    await r.waitPresence("online");
    r.store.revoke(r.tokenId);
    await r.waitPresence("offline");
    await until(() => r.workerd.link!.status().state === "unauthorized", 5000, "unauthorized state");
    expect(r.workerd.link!.status().detail).toMatch(/re-pair/);
  });

  it("kick() reconnects at once, skipping a long backoff", async () => {
    const r = await rig({ noHub: true });
    const link = new HubLink({ hubUrl: r.hub.url, token: r.token, hostId: r.hostId, wolves: () => [], baseMs: 30_000, capMs: 60_000 });
    cleanup.push(() => link.stop());
    link.start();
    await r.waitPresence("online");
    r.hub.link.closeByHost("box");
    await until(() => link.status().nextRetryInMs !== null, 3000, "backoff scheduled");
    expect(link.status().nextRetryInMs!).toBeGreaterThan(10_000);
    link.kick();
    await r.waitPresence("online");
    expect(link.status().state).toBe("online");
  });

  it("pair: trades a code for a worker token, stores hub.json 0600 with the host id", async () => {
    const r = await rig({ noHub: true });
    const dir = mkdtempSync(join(tmpdir(), "workerd-pair-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { code } = r.store.mintPairingCode({ kind: "worker", hostId: "newbox" });
    const cfg = await pairWithHub(r.hub.url + "/", code, { dir, label: "test-laptop" });
    expect(cfg).toMatchObject({ hubUrl: r.hub.url, hostId: "newbox" });
    expect(loadHubConfig(dir)).toEqual(cfg);
    expect(statSync(join(dir, "hub.json")).mode & 0o777).toBe(0o600);
    await expect(pairWithHub(r.hub.url, code, { dir })).rejects.toThrow(/pairing failed \(401\)/); // single use
    const link = new HubLink({ ...cfg, wolves: () => [] });
    cleanup.push(() => link.stop());
    link.start();
    await until(() => r.hub.link.presence("newbox") === "online", 5000, "paired link online");
  });
});

describe("backoff and wake", () => {
  it("backoff doubles from 1s to a 60s cap with +-20% jitter", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => linkBackoff(n, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(linkBackoff(3, () => 0)).toBe(3200);
    expect(linkBackoff(3, () => 1)).toBe(4800);
    expect(linkBackoff(20, () => 1)).toBe(72000);
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
