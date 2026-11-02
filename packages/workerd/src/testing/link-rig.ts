/** In-process link harness: a real hubd (port 0, small timers), a real workerd with the fake wolf, and an HttpConsoleClient. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket as WsClient } from "ws";
import { HttpConsoleClient } from "@wolfpack/client";
import { createHubServer, createTokenStore, type HubServer } from "@wolfpack/hubd";
import { LINK_PROTOCOL_VERSION, type LinkFrame, type LinkPresence, parseLinkFrame } from "@wolfpack/protocol";
import type { KbSyncOptions } from "../kb-sync.js";
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
  /** Operator request headers: a minted console token (`Authorization: Bearer`). */
  operator: Record<string, string>;
  /** A bare WebSocket speaking raw frames (for impersonating a second worker or a version-skewed one). */
  rawLink(token: string): Promise<RawLink>;
  /** workerd log lines. */
  logs: string[];
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
  /** Where workerd mirrors the hub KB. */
  kbMirrorDir: string;
  /** Write a file into the hub's KB domain folder like Dewey does (backdated), then scan so it becomes a revision. */
  kbWrite(domain: string, path: string, text: string): Promise<void>;
  kbRemove(domain: string, path: string): Promise<void>;
  /** Operator: set the registry's granted domains for a wolf. */
  grant(wolf: string, domains: string[]): Promise<void>;
  /** A mirrored file's text, or undefined. */
  mirrored(domain: string, path: string): string | undefined;
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
  /** How often workerd scans the kb inbox lanes (default 40ms). */
  feedIntervalMs?: number;
  /** false = start workerd with the inbox feed off. */
  feed?: boolean;
  /** Pass as workerd's hubInboxRoot; "hub" = the rig hub's inbox root. */
  hubInboxRoot?: string;
  linkOptions?: { retryBaseMs?: number; foreignRetries?: number; sendWindow?: number };
  /** Registry domains created up front (the registry must know a domain before a wolf can be granted it). */
  kbDomains?: string[];
  /** Registry-granted domains per wolf (operator side). */
  grants?: Record<string, string[]>;
  /** `domains:` written into each wolf's wolf.yaml (what the worker reports). Default: the grants. */
  wolfDomains?: Record<string, string[]>;
  /** KB sync timing seams. */
  kbSync?: Partial<Omit<KbSyncOptions, "hubUrl" | "token" | "mirrorDir">>;
  /** Reuse a mirror dir (restart tests). */
  kbMirrorDir?: string;
}

export async function startLinkRig(o: LinkRigOptions = {}): Promise<LinkRig> {
  const hostId = o.hostId ?? "box";
  const dataDir = mkdtempSync(join(tmpdir(), "link-rig-hub-"));
  const ops = mkdtempSync(join(tmpdir(), "link-rig-ops-"));
  const inboxRoot = join(ops, "hub", "inbox");
  const receiptsRoot = join(ops, "hub", "receipts");
  const kbOps = join(ops, "worker", "librarian");
  const outboxDir = join(ops, "worker", "outbox");
  mkdirSync(receiptsRoot, { recursive: true });
  const hubOpts = { dataDir, port: 0, authPollMs: 30, kbPollMs: 0, kbSettleMs: -1, inboxRoot, receiptsRoot, receiptPollMs: 40, receiptAckTimeoutMs: 300, linkTimers: o.hubTimers ?? { heartbeatMs: 100, deadAfterMs: 1000, helloTimeoutMs: 500, asleepOfflineMs: 60_000 }, ...o.hubOptions };
  const hub = await createHubServer(hubOpts);
  const hubPort = hub.port;
  const store = createTokenStore(dataDir);
  const mintWorker = (h = hostId) => {
    const { code } = store.mintPairingCode({ kind: "worker", hostId: h });
    return store.redeem(code, "rig", "worker", h);
  };
  const operator = { Authorization: `Bearer ${store.redeem(store.mintPairingCode({ kind: "console" }).code, "rig-operator", "console").token}` };
  const op = { ...operator, "Content-Type": "application/json" };
  await fetch(`${hub.url}/v1/registry/domains`, { method: "POST", headers: op, body: JSON.stringify({ name: "wolfpack" }) });
  for (const name of o.kbDomains ?? []) await fetch(`${hub.url}/v1/registry/domains`, { method: "POST", headers: op, body: JSON.stringify({ name }) });
  const { token, tokenId } = mintWorker();
  const wolfNames = o.wolves ?? ["alpha"];
  const { root } = makeWolves(...wolfNames);
  const kbMirrorDir = o.kbMirrorDir ?? mkdtempSync(join(tmpdir(), "link-rig-mirror-"));
  for (const n of wolfNames) {
    const ds = o.wolfDomains?.[n] ?? o.grants?.[n] ?? [];
    if (ds.length) writeFileSync(join(root, n, "wolf.yaml"), `name: ${n}\ndomains: [${ds.join(", ")}]\nserve:\n  socket: ${join(root, `${n}.sock`)}\n`);
  }
  // The operator pre-registers wolves; a worker cannot create them.
  const registerWolf = async (name: string) => {
    const r = await fetch(`${hub.url}/v1/registry/wolves`, { method: "POST", headers: op, body: JSON.stringify({ name, domains: [] }) });
    if (!r.ok) throw new Error(`pre-register ${name} failed: ${r.status}`);
  };
  for (const n of [...wolfNames, ...(o.preRegister ?? [])]) await registerWolf(n);
  const grant = async (wolf: string, domains: string[]) => {
    const r = await fetch(`${hub.url}/v1/registry/wolves/${wolf}`, { method: "PATCH", headers: op, body: JSON.stringify({ domains }) });
    if (!r.ok) throw new Error(`grant ${wolf} failed: ${r.status} ${await r.text()}`);
  };
  for (const [w, ds] of Object.entries(o.grants ?? {})) await grant(w, ds);
  const kbFile = (d: string, p: string) => join(dataDir, "kb", "base", "domains", d, ...p.split("/"));
  let bump = 0;
  const logs: string[] = [];
  const startWorkerd = (url: string) =>
    runWorkerd({
      wolvesDir: root,
      port: 0,
      command: FAKE_COMMAND,
      laptop: o.laptop,
      hub: o.noHub ? false : { hubUrl: url, token, hostId },
      linkOptions: { baseMs: 20, capMs: 200, rand: () => 0.5, retryBaseMs: 20, ...o.linkOptions },
      kbMirrorDir,
      kbSync: { baseMs: 20, capMs: 200, pollMs: 0, ...o.kbSync },
      wake: { intervalMs: 3_600_000, netPollMs: 3_600_000 },
      kbOps,
      outboxDir,
      feedIntervalMs: o.feedIntervalMs ?? 40,
      feed: o.feed,
      hubInboxRoot: o.hubInboxRoot === "hub" ? inboxRoot : o.hubInboxRoot,
      ackTimeoutMs: o.ackTimeoutMs ?? 400,
      log: (m) => void logs.push(m),
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
      const r = await fetch(`${hub.url}/v1/registry/${c}`, { headers: operator });
      return ((await r.json()) as Record<string, any[]>)[c]!;
    },
    mintWorker,
    operator,
    registerWolf,
    logs,
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
    kbMirrorDir,
    grant,
    async kbWrite(d, p, text) {
      const f = kbFile(d, p);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
      const t = (Date.now() - 3_600_000 + ++bump * 1000) / 1000;
      utimesSync(f, t, t);
      await hub.scanKb({ settle: false });
    },
    async kbRemove(d, p) {
      rmSync(kbFile(d, p), { force: true });
      await hub.scanKb({ settle: false });
    },
    mirrored(d, p) {
      try {
        return readFileSync(join(kbMirrorDir, d, ...p.split("/")), "utf8");
      } catch {
        return undefined;
      }
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
      if (!o.kbMirrorDir) rmSync(kbMirrorDir, { recursive: true, force: true });
    },
  };
  return rig;
}
