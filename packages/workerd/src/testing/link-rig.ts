/** In-process link harness: a real hubd (port 0, small timers), a real workerd with the fake wolf, and an HttpConsoleClient. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";
import { HttpConsoleClient } from "@wolfpack/client";
import { createHubServer, createTokenStore, type HubServer } from "@wolfpack/hubd";
import { ACTOR_HEADER, LINK_PROTOCOL_VERSION, type LinkFrame, type LinkPresence, parseLinkFrame } from "@wolfpack/protocol";
import { runWorkerd, type RunningWorkerd } from "../run.js";
import { FAKE_COMMAND, makeWolves, until } from "./helpers.js";

export interface LinkRig {
  hub: HubServer;
  workerd: RunningWorkerd;
  client: HttpConsoleClient;
  hostId: string;
  token: string;
  tokenId: string;
  dataDir: string;
  wolvesDir: string;
  store: ReturnType<typeof createTokenStore>;
  presence(): LinkPresence;
  waitPresence(p: LinkPresence, ms?: number): Promise<void>;
  registry(c: "hosts" | "wolves"): Promise<any[]>;
  /** Operator-register a wolf (no host). */
  registerWolf(name: string): Promise<void>;
  /** Poll until `cond` holds (default 5s). */
  eventually(cond: () => boolean | Promise<boolean>, what: string, ms?: number): Promise<void>;
  /** Mint another worker token for `hostId` (default: the rig's host). */
  mintWorker(hostId?: string): { token: string; tokenId: string };
  /** A bare WebSocket speaking raw frames (for impersonating a second worker or a version-skewed one). */
  rawLink(token: string): Promise<RawLink>;
  /** Librarian-ops dirs: the hub's inbox + receipts roots, and the worker's receipts root (kbOps) and outbox dir. */
  inboxRoot: string;
  receiptsRoot: string;
  kbOps: string;
  outboxDir: string;
  /** Close the hub and start a new one on the SAME data dir and port (workerd reconnects by itself). */
  restartHub(): Promise<void>;
  stopHub(): Promise<void>;
  startHub(): Promise<void>;
  /** Close workerd and start a new one with the same outbox/config (a worker restart). */
  restartWorkerd(): Promise<void>;
  close(): Promise<void>;
}
export interface RawLink {
  ws: WsClient;
  frames: LinkFrame[];
  closed?: number;
  send(f: unknown): void;
  hello(over?: Record<string, unknown>): void;
  until(cond: () => unknown, what: string): Promise<void>;
}

export interface LinkRigOptions {
  wolves?: string[];
  laptop?: boolean;
  hostId?: string;
  hubTimers?: { heartbeatMs: number; deadAfterMs: number; helloTimeoutMs: number; asleepOfflineMs?: number };
  /** Extra wolf names the operator registers up front (e.g. ones added at runtime). */
  preRegister?: string[];
  /** Start workerd with no hub config (pair later). */
  noHub?: boolean;
  /** Extra createHubServer options (limits, poll intervals). */
  hubOptions?: Partial<Parameters<typeof createHubServer>[0]>;
  ackTimeoutMs?: number;
}

const KEY = "rig-legacy-key-0123456789";

export async function startLinkRig(o: LinkRigOptions = {}): Promise<LinkRig> {
  const hostId = o.hostId ?? "box";
  const dataDir = mkdtempSync(join(tmpdir(), "link-rig-hub-"));
  const ops = mkdtempSync(join(tmpdir(), "link-rig-ops-"));
  const inboxRoot = join(ops, "hub", "inbox");
  const receiptsRoot = join(ops, "hub", "receipts");
  const kbOps = join(ops, "worker", "librarian");
  const outboxDir = join(ops, "worker", "outbox");
  mkdirSync(receiptsRoot, { recursive: true });
  const hubOpts = { dataDir, apiKey: KEY, port: 0, authPollMs: 30, inboxRoot, receiptsRoot, receiptPollMs: 40, receiptAckTimeoutMs: 300, linkTimers: o.hubTimers ?? { heartbeatMs: 100, deadAfterMs: 1000, helloTimeoutMs: 500, asleepOfflineMs: 60_000 }, ...o.hubOptions };
  const hub = await createHubServer(hubOpts);
  const hubPort = hub.port;
  const store = createTokenStore(dataDir);
  const mintWorker = (h = hostId) => {
    const { code } = store.mintPairingCode({ kind: "worker", hostId: h });
    return store.redeem(code, "rig", "worker", h);
  };
  const op = { "X-API-Key": KEY, "Content-Type": "application/json", [ACTOR_HEADER]: JSON.stringify({ id: "op", kind: "operator" }) };
  await fetch(`${hub.url}/v1/registry/domains`, { method: "POST", headers: op, body: JSON.stringify({ name: "wolfpack" }) });
  const { token, tokenId } = mintWorker();
  const wolfNames = o.wolves ?? ["alpha"];
  const { root } = makeWolves(...wolfNames);
  // The operator pre-registers wolves; a worker cannot create them.
  const registerWolf = async (name: string) => {
    const r = await fetch(`${hub.url}/v1/registry/wolves`, { method: "POST", headers: op, body: JSON.stringify({ name, domains: [] }) });
    if (!r.ok) throw new Error(`pre-register ${name} failed: ${r.status}`);
  };
  for (const n of [...wolfNames, ...(o.preRegister ?? [])]) await registerWolf(n);
  const startWorkerd = (url: string) =>
    runWorkerd({
      wolvesDir: root,
      port: 0,
      command: FAKE_COMMAND,
      laptop: o.laptop,
      hub: o.noHub ? false : { hubUrl: url, token, hostId },
      linkOptions: { baseMs: 20, capMs: 200, rand: () => 0.5 },
      wake: { intervalMs: 3_600_000, netPollMs: 3_600_000 },
      kbOps,
      outboxDir,
      ackTimeoutMs: o.ackTimeoutMs ?? 400,
      log: () => {},
    });
  const workerd = await startWorkerd(hub.url);
  const client = new HttpConsoleClient({ baseUrl: workerd.url, hub: { baseUrl: hub.url, token } });
  const raws: WsClient[] = [];
  const rig: LinkRig = {
    hub,
    workerd,
    client,
    hostId,
    token,
    tokenId,
    dataDir,
    wolvesDir: root,
    store,
    presence: () => rig.hub.link.presence(hostId),
    waitPresence: (p, ms = 8000) => until(() => rig.hub.link.presence(hostId) === p, ms, `presence ${p} (is ${rig.hub.link.presence(hostId)})`),
    async registry(c) {
      const r = await fetch(`${hub.url}/v1/registry/${c}`, { headers: { "X-API-Key": KEY } });
      return ((await r.json()) as Record<string, any[]>)[c]!;
    },
    mintWorker,
    registerWolf,
    inboxRoot,
    receiptsRoot,
    kbOps,
    outboxDir,
    async stopHub() {
      await rig.hub.close();
    },
    async startHub() {
      rig.hub = await createHubServer({ ...hubOpts, port: hubPort });
    },
    async restartHub() {
      await rig.stopHub();
      await rig.startHub();
    },
    async restartWorkerd() {
      await rig.workerd.close();
      rig.workerd = await startWorkerd(rig.hub.url);
    },
    async eventually(cond, what, ms = 5000) {
      const end = Date.now() + ms;
      while (!(await cond())) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async rawLink(tok) {
      const ws = new WsClient(hub.url.replace("http", "ws") + "/v1/link", { headers: { Authorization: `Bearer ${tok}` } });
      raws.push(ws);
      await new Promise<void>((res, rej) => (ws.once("open", () => res()), ws.once("error", rej)));
      const raw: RawLink = {
        ws,
        frames: [],
        send: (f) => ws.send(JSON.stringify(f)),
        hello: (over = {}) => raw.send({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId, laptop: false, wolves: [], kbRevisions: {}, ...over }),
        until: (cond, what) => until(() => !!cond(), 5000, what),
      };
      ws.on("message", (d) => {
        const p = parseLinkFrame(d.toString());
        if (p.ok) raw.frames.push(p.frame);
      });
      ws.on("close", (c) => (raw.closed = c));
      return raw;
    },
    async close() {
      for (const w of raws) w.terminate();
      await rig.workerd.close();
      await rig.hub.close().catch(() => {});
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(ops, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
  return rig;
}
