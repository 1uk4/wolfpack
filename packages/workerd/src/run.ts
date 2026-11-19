import { discoverWolves } from "@wolfpack/engine";
import { DEFAULT_CONSOLE_URL, kbOpsDir, wolvesDir as defaultWolvesDir, workerdPort } from "@wolfpack/protocol/runtime-home";
import { startSharedWorkServer, type SharedWorkServer, type StartWorkServer } from "@wolfpack/harness/sandbox";
import { WorkerdServer, VERSION as WORKERD_VERSION } from "./proxy.js";
import { createInventoryReporter, type InventoryReporter } from "./wolfd-probe.js";
import { machineName, readMachineChannel } from "@wolfpack/protocol/health-lag";
import { HubLink, type LinkStatus } from "./link.js";
import { canRestartSelf, createCommandRunner, restartWolves, type KeyHandler, type WolfControl } from "./commands.js";
import { createKeyStore, readKeyPresence } from "./key-store.js";
import { migrateKeys, type MigrateOptions } from "./key-migrate.js";
import { KeyChecker, type FetchLike } from "@wolfpack/protocol";
import { insecureHubWarning, loadHubConfig, workerdConfigDir, type HubConfig } from "./hub-config.js";
import { feedContributions, feedDisabledReason } from "./feed.js";
import { Outbox, writeReceiptFile } from "./outbox.js";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { startWakeMonitor, type WakeOptions } from "./wake.js";
import { toLinkWolf } from "./link-wolf.js";
import type { LinkWelcome, LinkWolf } from "@wolfpack/protocol";
import { WorkerRelay } from "./relay.js";
import { KbSync, type KbSyncOptions } from "./kb-sync.js";
import { Supervisor, type SupervisorOptions } from "./supervisor.js";
import { ensureDirectToken } from "./direct-token.js";
import { loadOrCreateMachineKey } from "./machine-key.js";
import { apiWolfNames, wolfTransport } from "./wolf-transport.js";

export interface RunWorkerdOptions extends Omit<SupervisorOptions, "wolves"> {
  /** Directory holding `<wolf>/wolf.yaml`. Default: ~/wolves/local. */
  wolvesDir?: string;
  /** Key storage for key.set / key.remove (the Keys task injects it). Absent = those commands are not advertised. */
  keys?: KeyHandler;
  /**
   * The machine's key file (explicit; never inferred). With it, workerd stores keys sent by key.set there and reports key presence.
   * Set only by --key-file / WORKERD_KEY_FILE; there is no default location. Without it key.set/key.remove are not advertised and no Pack keys are reported.
   * sfo-01: the shared /var/lib/workerd-wolves/keys.env (0640, group-readable). Dev stack: set by scripts/dev-stack.mjs inside the sandbox.
   */
  keyFile?: string;
  /** Enable the one-time copy of keys from these explicit sources into the key file (needs keyFile). Absent = migration off. */
  keyMigration?: Pick<MigrateOptions, "wolfEnvFiles" | "serviceEnvFiles" | "authJson">;
  /** Mode of the key file (default 0600; sfo-01 uses 0o640 with a shared group). Env WORKERD_KEY_FILE_MODE (octal). */
  keyFileMode?: number;
  port?: number;
  host?: string;
  only?: string[];
  /** Test seam: how the shared sandbox work server is started (default: the local work server). */
  startWorkServer?: StartWorkServer;
  /** Hub link config. Default: ~/.wolfpack/workerd/hub.json when paired; none = no link. */
  hub?: HubConfig | false;
  /** Config dir for hub.json (default ~/.wolfpack/workerd). */
  configDir?: string;
  /** Laptop flag for presence (clean close = asleep). Default: macOS. */
  laptop?: boolean;
  /** Test seams for the link. */
  linkOptions?: { baseMs?: number; capMs?: number; rand?: () => number; retryBaseMs?: number; foreignRetries?: number; sendWindow?: number };
  wake?: Partial<WakeOptions>;
  /** Librarian-ops root where receipts are written (`<kbOps>/receipts/<wolf>/`). Default env KB_OPS, else `<wolvesDir>/../librarian` for an explicit wolvesDir, else the resolver's kbOpsDir. */
  kbOps?: string;
  /** Contribution outbox directory. Default `<configDir>/outbox`. */
  outboxDir?: string;
  /** Test seam: resend overdue contribution acks after this long, ms. */
  ackTimeoutMs?: number;
  /** Where the hub-synced KB mirror lives (Syncthing no longer carries the KB, only den backups). Default env WORKERD_KB_MIRROR_DIR, else `<configDir>/kb-mirror`. */
  kbMirrorDir?: string;
  /** Make mirror content group-readable (files 0640, dirs 0750; hub.json/outbox/.sync stay private). Env WORKERD_KB_MIRROR_GROUP_READ=1. Default off. */
  kbMirrorGroupRead?: boolean;
  /** Mirror layout: "flat" (default) or "base" (`<mirror>/domains/<d>/`). Env WORKERD_KB_LAYOUT. */
  kbMirrorLayout?: "flat" | "base";
  /** Test seams for the KB sync. */
  kbSync?: Partial<Omit<KbSyncOptions, "hubUrl" | "token" | "mirrorDir">>;
  /** How often the kb inbox lanes are scanned for contributions to send over the link, ms (default 5000). */
  feedIntervalMs?: number;
  /** The hub's inbox root when hubd runs on this host (default env HUBD_INBOX_ROOT). The feed is skipped when kbOps/inbox is that dir. */
  hubInboxRoot?: string;
  /** Turn the inbox feed off. Also env WORKERD_FEED=0. A workerd that shares a host (and lanes) with hubd, e.g. on sfo-01 hosting a wolf, MUST set it. */
  feed?: boolean;
  /**
   * Link-only mode (env WORKERD_LINK_ONLY=1): open the hub link and the KB sync, announce `announce` to the hub, and supervise NOTHING:
   * no wolf discovery, no wolfd spawned, no work server. For a host whose wolves run from their own units (sfo-01 hosting Hal).
   */
  linkOnly?: boolean;
  /** Link-only: the wolf names announced in hello (env WORKERD_ANNOUNCE, comma separated). Domains are sent empty: the hub registry is the source. */
  announce?: string[];
}

/** Link-only may only listen on loopback. */
export const isLoopbackHost = (h: string): boolean => h === "127.0.0.1" || h === "::1" || h === "localhost";

/** Parse WORKERD_LINK_ONLY (1/true/yes/on). */
export const envLinkOnly = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes|on)$/i.test(env.WORKERD_LINK_ONLY ?? "");
export const envAnnounce = (env: NodeJS.ProcessEnv = process.env): string[] => (env.WORKERD_ANNOUNCE ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** WORKERD_KB_MIRROR_DIR (trimmed, empty = unset) and WORKERD_KB_MIRROR_GROUP_READ (ONLY the exact value "1" enables it; setup.sh checks the same). */
export const envKbMirror = (env: NodeJS.ProcessEnv = process.env): { dir?: string; groupRead: boolean } => ({
  dir: env.WORKERD_KB_MIRROR_DIR?.trim() || undefined,
  groupRead: (env.WORKERD_KB_MIRROR_GROUP_READ ?? "").trim() === "1",
});

/**
 * Why group-read mirror modes must NOT be used for this mirror dir, or undefined when fine. Refuses when the mirror equals, contains or sits
 * inside the private config dir (hub.json), equals/contains/sits inside the outbox, or when hub.json / outbox/ exist inside the mirror.
 */
export function groupReadConflict(mirrorDir: string, configDir: string, outboxDir: string): string | undefined {
  // Symlinks are resolved where the path exists, so a mirror dir that is a symlink into the config dir is caught.
  const real = (p: string): string => {
    // Not-yet-existing paths: resolve the nearest existing ancestor (macOS /var -> /private/var) and re-append the rest.
    let cur = resolve(p);
    const rest: string[] = [];
    for (;;) {
      try {
        return join(realpathSync(cur), ...rest);
      } catch {
        const up = dirname(cur);
        if (up === cur) return resolve(p);
        rest.unshift(cur.slice(up.length + 1));
        cur = up;
      }
    }
  };
  const m = real(mirrorDir);
  const inside = (a: string, b: string): boolean => {
    const r = relative(b, a);
    return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
  };
  for (const [name, p] of [["config dir", configDir], ["outbox", outboxDir]] as const) {
    const q = real(p);
    if (inside(m, q) || inside(q, m)) return `the mirror dir ${m} equals, contains or is inside the ${name} ${q}`;
  }
  for (const n of ["hub.json", "outbox"]) if (existsSync(join(m, n))) return `${join(m, n)} exists inside the mirror dir`;
  return undefined;
}

/** A WORKERD_KB_MIRROR_GROUP_READ value that is neither "1" (on) nor "0"/empty (off): returned so the caller can warn that it is treated as OFF. */
export const badGroupReadValue = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const v = (env.WORKERD_KB_MIRROR_GROUP_READ ?? "").trim();
  return v === "" || v === "0" || v === "1" ? undefined : v;
};

export interface RunningWorkerd {
  url: string;
  supervisor: Supervisor;
  /** The hub link, when paired. */
  link?: HubLink;
  /** The hub KB mirror sync, when paired. */
  kbSync?: KbSync;
  server: WorkerdServer;
  /** Discovery problems (broken wolf.yaml files), already logged. */
  errors: string[];
  close(): Promise<void>;
}

/** Where receipts and contributions live: opts.kbOps > env KB_OPS > env WOLFPACK_KB_OPS > `<explicit wolvesDir>/../librarian` > the resolver default (`<wolves root>/librarian`). */
export function resolveKbOps(opts: Pick<RunWorkerdOptions, "kbOps" | "wolvesDir">, env: Record<string, string | undefined> = process.env): string {
  return opts.kbOps ?? (env.KB_OPS?.trim() || env.WOLFPACK_KB_OPS?.trim() || (opts.wolvesDir ? join(dirname(opts.wolvesDir), "librarian") : kbOpsDir(env)));
}

export async function runWorkerd(opts: RunWorkerdOptions = {}): Promise<RunningWorkerd> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${new Date().toISOString()} ${l}\n`));
  const root = opts.wolvesDir ?? defaultWolvesDir();
  const linkOnly = opts.linkOnly ?? envLinkOnly();
  const announce = linkOnly ? [...new Set(opts.announce ?? envAnnounce())] : [];
  if (linkOnly) {
    if (!announce.length) throw new Error("link-only mode needs at least one announced wolf (--announce <name> or WORKERD_ANNOUNCE)");
    if (opts.hub === false) throw new Error("link-only mode needs a hub link");
    const lh = opts.host ?? process.env.WORKERD_HOST;
    if (lh && !isLoopbackHost(lh)) throw new Error(`link-only mode only listens on loopback (127.0.0.1, ::1, localhost), not ${JSON.stringify(lh)}`);
    if (opts.only?.length) throw new Error("link-only mode supervises nothing: `only` is not allowed");
    if (opts.command) throw new Error("link-only mode spawns nothing: `command` (--wolfd) is not allowed");
    log(`[workerd] link-only: supervising no wolves; announcing ${announce.join(", ")}`);
  }
  const found = linkOnly ? { wolves: [], errors: [] } : discoverWolves(root);
  const errors = found.errors.map((e) => e.message);
  for (const e of errors) log(`[workerd] skipping wolf: ${e}`);
  const wolves = found.wolves.map((l) => l.config).filter((w) => !opts.only?.length || opts.only.includes(w.identity.name));
  // Wolves that share a sandbox root share ONE ledger copy, so exactly one work server writes it, and it must outlive any
  // single wolf (a restarting wolf must not take the ledger down): workerd owns it, wolfd processes attach via the run file.
  const workServers: SharedWorkServer[] = [];
  for (const sandboxRoot of new Set(wolves.flatMap((w) => (w.sandbox ? [w.sandbox.root] : [])))) {
    try {
      const srv = await startSharedWorkServer(sandboxRoot, { startWorkServer: opts.startWorkServer });
      workServers.push(srv);
      log(`[workerd] sandbox ${sandboxRoot}: work server ${srv.url} (the only ledger writer)`);
    } catch (e) {
      // The wolves of this root will refuse to start with the same reason; say it once here.
      log(`[workerd] sandbox ${sandboxRoot}: no shared work server: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Link-only never spawns; a placeholder command also keeps the Supervisor from resolving @wolfpack/harness (absent in the single-file bundle).
  const supervisor = new Supervisor({ ...opts, ...(linkOnly ? { command: ["/bin/false"] } : {}), wolves, log });
  if (linkOnly) {
    // Unreachable by construction: nothing in workerd calls these in link-only, and a stray call must throw rather than spawn.
    const refuse = (): never => {
      throw new Error("link-only: spawning wolves is disabled");
    };
    supervisor.start = refuse;
    supervisor.addWolf = refuse;
  }
  const hubCfg = opts.hub === false ? undefined : (opts.hub ?? loadHubConfig(opts.configDir));
  const linkWolf = (c: Parameters<typeof toLinkWolf>[0]): LinkWolf => toLinkWolf(c, opts.env ?? process.env); // link-only announces below claim nothing
  const wolfNames = (): string[] => (linkOnly ? announce : supervisor.configs().map((c) => c.identity.name));
  let link: HubLink | undefined;
  let kbSync: KbSync | undefined;
  let inventory: InventoryReporter | undefined;
  let wake: { stop(): void } | undefined;
  let serverUrl = "";
  const relay = new WorkerRelay({ baseUrl: () => serverUrl, send: (f, written) => link?.sendFrame(f, written) ?? false });
  let feed: ReturnType<typeof setInterval> | undefined;
  if (hubCfg) {
    const warning = insecureHubWarning(hubCfg.hubUrl);
    if (warning) log(`[workerd] ${warning}`);
    const kbOps = resolveKbOps(opts);
    const outboxPath = opts.outboxDir ?? join(opts.configDir ?? workerdConfigDir(), "outbox");
    const outbox = new Outbox(outboxPath);
    // The subscribed set is ONLY what the hub registry grants this host (welcome.grantedDomains / grants frames); wolf.yaml domains are
    // never consulted, and nothing syncs before the first welcome.
    const rawLayout = opts.kbMirrorLayout ?? process.env.WORKERD_KB_LAYOUT ?? "flat";
    if (rawLayout !== "flat" && rawLayout !== "base") throw new Error(`invalid WORKERD_KB_LAYOUT ${JSON.stringify(rawLayout)} (expected flat or base)`);
    const kbLayout: "flat" | "base" = rawLayout;
    const envMirror = envKbMirror();
    const badGr = badGroupReadValue();
    if (badGr !== undefined) log(`[workerd] WARNING WORKERD_KB_MIRROR_GROUP_READ=${JSON.stringify(badGr.slice(0, 20))} is not "1" or "0": group-read is OFF`);
    const configDir = opts.configDir ?? workerdConfigDir();
    const mirrorDir = opts.kbMirrorDir ?? envMirror.dir ?? join(configDir, "kb-mirror");
    const groupRead = opts.kbMirrorGroupRead ?? envMirror.groupRead;
    if (groupRead) {
      const why = groupReadConflict(mirrorDir, configDir, outboxPath);
      if (why) throw new Error(`group-read KB mirror refused: ${why} (it would expose hub.json or the outbox)`);
    }
    kbSync = new KbSync({
      hubUrl: hubCfg.hubUrl,
      token: hubCfg.token,
      mirrorDir,
      groupRead,
      layout: kbLayout,
      log,
      ...opts.kbSync,
    });
    // Inventory (work-wolfpack-ZproKxi): report only when the hub's welcome advertised it, so an old hub never sees an unknown frame.
    let inventoryOn = false;
    inventory = createInventoryReporter({
      hostId: hubCfg.hostId,
      machine: machineName(),
      // The console on this machine (its /api/health `self` part is reported as a console entry). WOLFPACK_CONSOLE_URL overrides; the default is the deployed console's loopback port.
      consoleUrl: (opts.env ?? process.env).WOLFPACK_CONSOLE_URL?.trim() || DEFAULT_CONSOLE_URL,
      ...(WORKERD_VERSION ? { version: WORKERD_VERSION } : {}),
      channel: () => readMachineChannel(),
      children: () => supervisor.status(),
      send: (entries) => link!.sendFrame({ t: "report", entries }),
      enabled: () => inventoryOn,
      busy: (n) => supervisor.wolfBusy(n),
      transport: (n) => {
        const c = supervisor.configs().find((x) => x.identity.name === n);
        return c ? wolfTransport(c, opts.env ?? process.env) : "subscription";
      },
      // Key presence (masks only, never values) so the Pack's Keys grid can show it.
      ...(opts.keyFile ? { keys: () => readKeyPresence(opts.keyFile!, opts.env ?? process.env) } : {}),
    });
    // The machine key is created on first start; the public half goes in every hello.
    const cfgDir = opts.configDir ?? workerdConfigDir();
    // A corrupt or unreadable machine-key.pem is never regenerated (that would silently change the machine's identity): log it and
    // run without a pubkey and without key.set / key.remove.
    let machineKey: Awaited<ReturnType<typeof loadOrCreateMachineKey>> | undefined;
    try {
      machineKey = await loadOrCreateMachineKey(cfgDir);
    } catch (e) {
      log(`[workerd] machine key unusable (${(e as Error).message.split("\n")[0]}); key.set and key.remove are off and no public key is sent. Fix or remove machine-key.pem by hand.`);
    }
    const wolfControl: WolfControl = {
      names: () => supervisor.configs().map((c) => c.identity.name),
      status: async (n) => ({ wasActive: supervisor.status().some((s) => s.name === n && s.state === "online"), midReply: await supervisor.wolfBusy(n) }),
      restart: async (n) => ((await supervisor.restartWolf(n)).unconfirmed ? { unconfirmed: true } : undefined),
    };
    // One-time copy of existing keys into the Pack file. Off unless explicitly enabled; sources are only read.
    if (opts.keyMigration && opts.keyFile) {
      const m = migrateKeys({ ...opts.keyMigration, enabled: true, keyFile: opts.keyFile, marker: join(cfgDir, "keys-migrated.json"), mode: opts.keyFileMode });
      if (m.ran) log(`[workerd] key migration ran; copied slots: ${m.copied.join(", ") || "none"}`);
    }
    // An explicit keys handler wins; otherwise an explicit keyFile gets the file store. Neither = key.set/remove are not advertised.
    const keys: KeyHandler | undefined =
      opts.keys ??
      (opts.keyFile && machineKey
        ? createKeyStore({
            file: opts.keyFile,
            seenFile: join(cfgDir, "key-seen.json"),
            privateKeyPkcs8: machineKey.privateKeyPkcs8,
            checker: new KeyChecker({ fetch: globalThis.fetch as unknown as FetchLike }),
            mode: opts.keyFileMode,
            // Only the Anthropic key feeds the wolves; Deepgram feeds the console, which reads the file itself.
            // Only API-key wolves ever received the key, so only they restart; a subscription wolf is never touched.
            restartWolvesUsing: async (slot) => (slot === "anthropic" && !linkOnly ? ((await restartWolves(wolfControl, apiWolfNames(supervisor.configs(), opts.env ?? process.env))).data.restarted) : []),
          })
        : undefined);
    const commands = createCommandRunner({
      log,
      // Each supervised wolf's wolfd log is readable by the wolf's name (never by path: the hub only names a service).
      logSources: () => Object.fromEntries(supervisor.status().map((c) => [c.name, { file: c.logFile }])),
      ...(keys ? { keys, hostId: hubCfg.hostId } : {}),
      ...(canRestartSelf() ? { restartSelf: { stop: () => shutdown(), exit: (code: number) => process.exit(code) } } : {}),
      // Link-only supervises no wolves (they run from their own units), so there is nothing to restart: wolves.restart is not advertised.
      ...(linkOnly
        ? {}
        : { wolves: wolfControl }),
    });
    link = new HubLink({
      ...hubCfg,
      commands: () => commands.supported(),
      pubkey: () => machineKey?.publicKey,
      onCommand: (c) => commands.handle(c),
      onCommandSent: (c, r) => commands.afterSend(c, r),
      kbRevisions: () => kbSync!.revisions(),
      onWelcome: (w) => {
        kbSync!.applyWelcome(w.grantedDomains);
        inventoryOn = w.inventory === true;
        void inventory?.report();
      },
      onGrants: (d) => kbSync!.setGranted(d),
      onKbChanged: (d, rev, epoch) => kbSync!.notify(d, rev, epoch),
      outbox,
      ackTimeoutMs: opts.ackTimeoutMs,
      onReceipt: (r) => {
        if (!wolfNames().includes(r.wolf)) return log(`[workerd] receipt for ${JSON.stringify(r.wolf.slice(0, 64))} ignored: not a wolf on this host`);
        writeReceiptFile(kbOps, r.wolf, r.name, r.content);
      },
      laptop: opts.laptop,
      wolves: () => (linkOnly ? announce.map((name): LinkWolf => ({ name, domains: [] })) : supervisor.configs().map(linkWolf)),
      log,
      onRelay: (f) => (f.t === "req" ? relay.handle(f) : f.t === "cancel" ? relay.cancel(f.id) : relay.hubPause(f.id, f.t === "pause")),
      onLinkDown: () => {
        inventoryOn = false;
        relay.abortAll();
      },
      onRetired: (names) => log(`[workerd] hub retired wolves: ${names.join(", ")}`),
      ...opts.linkOptions,
    });
    supervisor.onChange((e) => {
      if (e.type === "add") link!.wolfAdded(linkWolf(e.config));
      else link!.wolfRemoved(e.name);
      void inventory?.report();
    });
    kbSync.start();
    // Link-only: the feed is OFF unless explicitly enabled (opts.feed === true or WORKERD_FEED=1/true/on/yes).
    const feedExplicit = opts.feed === true || /^(1|true|on|yes)$/i.test((process.env.WORKERD_FEED ?? "").trim());
    const off = opts.feed === false ? "disabled by options" : linkOnly && !feedExplicit ? "link-only default (set WORKERD_FEED=1 to enable)" : feedDisabledReason(kbOps, process.env, opts.hubInboxRoot);
    if (off) log(`[workerd] contribution feed off: ${off}`);
    else {
      const warned = new Set<string>();
      const feedOnce = () => void feedContributions(kbOps, wolfNames(), { contribute: (w, c, id) => link!.contribute(w, c, id) }, log, warned);
      feedOnce();
      feed = setInterval(feedOnce, opts.feedIntervalMs ?? 5000);
      feed.unref();
    }
    wake = startWakeMonitor({ ...opts.wake, onWake: (reason) => (log(`[workerd] ${reason}: reconnecting hub link`), link!.kick()) });
  }
  // The direct console path (work-wolfpack-Fy45EOA): a supervising workerd creates its local token now, so a console on this machine can
  // read it before the hub ever goes down. Only with a hub (it is the hub's fallback); link-only supervises no wolves, so it has nothing to serve.
  let directToken: (() => string) | undefined;
  if (!linkOnly && hubCfg) {
    const dir = opts.configDir ?? workerdConfigDir();
    try {
      ensureDirectToken(dir, log);
      directToken = () => ensureDirectToken(dir, log);
    } catch (e) {
      log(`[workerd] direct console path off: cannot create its token (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const server = new WorkerdServer({
    registry: supervisor,
    ...(directToken ? { directToken } : {}),
    health: () => ({ ok: true, wolves: supervisor.status(), ...(kbSync ? { kb: kbSync.status() } : {}), ...(link ? { hub: link.status() satisfies LinkStatus } : {}), ...(link && hubCfg ? { hubHostId: hubCfg.hostId } : {}) }), // hubHostId: matches this workerd to its entry in hubd's /healthz hosts
  });
  const url = await server.listen(opts.port ?? workerdPort(), opts.host ?? (linkOnly ? (process.env.WORKERD_HOST || "127.0.0.1") : undefined));
  serverUrl = url;
  if (!linkOnly) supervisor.start(); // link-only: never spawn
  link?.start();
  /** The normal stop sequence; also what workerd.restart runs before it exits 75. */
  let stopping: Promise<void> | undefined;
  /** Memoized: close(), a SIGTERM and workerd.restart may all ask for it; the sequence runs once and every caller awaits the same run. */
  const shutdown = (): Promise<void> => (stopping ??= doShutdown());
  async function doShutdown(): Promise<void> {
    wake?.stop();
    inventory?.stop();
    kbSync?.stop();
    if (feed) clearInterval(feed);
    await link?.stop();
    await server.close();
    await supervisor.stop();
    for (const w of workServers) await w.close().catch(() => {});
  }
  return {
    url,
    supervisor,
    link,
    kbSync,
    server,
    errors,
    close: shutdown,
  };
}
