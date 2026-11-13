import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WolfConfig } from "@wolfpack/engine";
import { UNIX_PREFIX, getJson, probeSocket } from "./socket.js";
import { readKeyFileEnv } from "./key-store.js";
import { wolfTransport } from "./wolf-transport.js";
import type { WolfEntry, WolfRegistry } from "./registry.js";

export type ChildState = "starting" | "online" | "restarting" | "failed" | "stopped";

export interface BackoffOptions {
  /** First restart delay. Doubles per consecutive failure. Default 500. */
  baseMs: number;
  /** Delay cap. Default 30_000. */
  capMs: number;
  /** A child that stays up this long has its consecutive-failure count reset. Default 60_000. */
  healthyResetMs: number;
}

export interface SupervisorOptions {
  wolves: WolfConfig[];
  /**
   * Command (and leading args) that runs wolfd. Default: [node, <resolved @wolfpack/harness dist/bin/wolfd.js>],
   * independent of PATH. `--config <file>` plus `--socket <serve.socket>` (or `--port 0`, see transport) is appended.
   */
  command?: string[];
  /**
   * How children listen. "socket" (default when `command` is not overridden): `--socket <wolf serve.socket>`, a path
   * that is stable across workerd restarts, which is what makes orphan adoption possible. "tcp" (default when
   * `command` is overridden): `--port 0`; such children are unfindable after a workerd crash.
   */
  transport?: "socket" | "tcp";
  backoff?: Partial<BackoffOptions>;
  /**
   * True when each wolf runs as the systemd unit `wolfd@<name>` behind a wrapper (infra/wolves/wolfd-unit.sh). Then a restart must go
   * through the unit: killing the wrapper leaves the unit running, and the re-run `systemctl start` is a no-op. Default: true when
   * `command` names wolfd-unit.sh.
   */
  wolfdUnits?: boolean;
  /** @internal Run `systemctl` with this argv (no shell) and return stdout. Default: execFile. Tests inject a fake; nothing else runs systemctl. */
  systemctl?: (args: string[]) => Promise<string>;
  /** Consecutive failed restarts tolerated before a wolf is marked failed. Default 10. */
  maxRestarts?: number;
  /** SIGTERM → SIGKILL grace on shutdown. Default 5000. */
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
  /** The Pack key file: its keys are merged over `env` for every wolfd spawn, read fresh each time (so a key.set then restart picks up the new key). */
  keyFile?: string;
  /** Surfaced lines, already prefixed with `[name]`. Default: process.stderr. */
  log?: (line: string) => void;
}

export interface ChildStatus {
  name: string;
  state: ChildState;
  pid: number | null;
  url: string | null;
  /** True when this wolfd was found already running on its socket (orphan of a previous workerd) rather than spawned. */
  adopted: boolean;
  /** Total restarts since the supervisor started. */
  restarts: number;
  /** Consecutive failures feeding the backoff. */
  failures: number;
  nextRestartInMs: number | null;
  logFile: string;
}

const SERVING = /serving (https?:\/\/\S+|unix:\S+)/;
const ADOPT_POLL_MS = 1000;

/** The wolfd entry point of the installed @wolfpack/harness, run with the current node (no PATH lookup). */
export function defaultWolfdCommand(): string[] {
  const pkg = createRequire(import.meta.url).resolve("@wolfpack/harness/package.json");
  return [process.execPath, join(dirname(pkg), "dist", "bin", "wolfd.js")];
}

function execSystemctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("systemctl", args, { timeout: 30_000, windowsHide: true }, (err, stdout) => (err ? reject(new Error(`systemctl ${args[0]} failed`)) : resolve(stdout)));
  });
}

class Child {
  state: ChildState = "stopped";
  proc: ChildProcess | null = null;
  url: string | null = null;
  adopted = false;
  adoptTimer: NodeJS.Timeout | null = null;
  restarts = 0;
  failures = 0;
  nextRestartAt: number | null = null;
  startedAt = 0;
  timer: NodeJS.Timeout | null = null;
  healthyTimer: NodeJS.Timeout | null = null;
  readonly logFile: string;
  constructor(readonly config: WolfConfig) {
    this.logFile = join(config.den, "logs", "wolfd.log");
  }
}

export type SupervisorChange = { type: "add"; config: WolfConfig } | { type: "remove"; name: string };

export function backoffDelay(failures: number, b: BackoffOptions): number {
  return Math.min(b.capMs, b.baseMs * 2 ** Math.max(0, failures - 1));
}

/** Runs one wolfd child per wolf; restarts crashes with exponential backoff; implements WolfRegistry for the proxy. */
export class Supervisor implements WolfRegistry {
  private readonly children = new Map<string, Child>();
  private readonly backoff: BackoffOptions;
  private readonly maxRestarts: number;
  private readonly graceMs: number;
  private readonly command: string[];
  private readonly transport: "socket" | "tcp";
  private readonly wolfdUnits: boolean;
  private stopping = false;
  private started = false;
  private readonly listeners = new Set<(e: SupervisorChange) => void>();

  constructor(private readonly opts: SupervisorOptions) {
    this.backoff = { baseMs: 500, capMs: 30_000, healthyResetMs: 60_000, ...opts.backoff };
    this.maxRestarts = opts.maxRestarts ?? 10;
    this.graceMs = opts.graceMs ?? 5000;
    this.command = opts.command ?? defaultWolfdCommand();
    this.transport = opts.transport ?? (opts.command ? "tcp" : "socket");
    this.wolfdUnits = opts.wolfdUnits ?? this.command.some((a) => basename(a) === "wolfd-unit.sh");
    for (const w of opts.wolves) this.children.set(w.identity.name, new Child(w));
  }

  /** Subscribe to wolves added / removed at runtime. Returns an unsubscribe. */
  onChange(l: (e: SupervisorChange) => void): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  private emit(e: SupervisorChange): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* a listener must not break the supervisor */
      }
    }
  }

  /** Add a wolf at runtime (spawned at once when the supervisor is already running). */
  addWolf(config: WolfConfig): void {
    const name = config.identity.name;
    if (this.children.has(name)) throw new Error(`wolf ${name} is already supervised`);
    const c = new Child(config);
    this.children.set(name, c);
    if (this.started && !this.stopping) this.spawnChild(c);
    this.emit({ type: "add", config });
  }

  /** Stop and forget a wolf. */
  async removeWolf(name: string): Promise<void> {
    const c = this.children.get(name);
    if (!c) return;
    this.children.delete(name);
    await this.stopChild(c);
    this.emit({ type: "remove", name });
  }

  start(): void {
    this.started = true;
    for (const c of this.children.values()) this.spawnChild(c);
  }

  /** Resolves once every child is online or failed (or the timeout elapses). */
  async whenSettled(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ([...this.children.values()].every((c) => c.state === "online" || c.state === "failed")) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ---- WolfRegistry
  wolves(): WolfEntry[] {
    return [...this.children.values()].map((c) => ({ name: c.config.identity.name, id: c.config.identity.id, host: hostname() }));
  }
  configs(): WolfConfig[] {
    return [...this.children.values()].map((c) => c.config);
  }
  has(name: string): boolean {
    return this.children.has(name);
  }
  upstream(name: string): string | undefined {
    const c = this.children.get(name);
    return c?.state === "online" && c.url ? c.url : undefined;
  }

  status(): ChildStatus[] {
    return [...this.children.values()].map((c) => ({
      name: c.config.identity.name,
      state: c.state,
      pid: c.proc?.pid ?? null,
      url: c.url,
      adopted: c.adopted,
      restarts: c.restarts,
      failures: c.failures,
      nextRestartInMs: c.nextRestartAt === null ? null : Math.max(0, c.nextRestartAt - Date.now()),
      logFile: c.logFile,
    }));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.children.values()].map((c) => this.stopChild(c)));
  }

  private line(c: Child, text: string): void {
    const name = c.config.identity.name;
    try {
      mkdirSync(join(c.config.den, "logs"), { recursive: true });
      appendFileSync(c.logFile, `${new Date().toISOString()} ${text}\n`);
    } catch {
      /* logging must never take the supervisor down */
    }
    (this.opts.log ?? ((l) => process.stderr.write(`${new Date().toISOString()} ${l}\n`)))(`[${name}] ${text}`);
  }

  private pipeLines(c: Child, stream: NodeJS.ReadableStream, tag: string): void {
    let buf = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        this.handleLine(c, buf.slice(0, i), tag);
        buf = buf.slice(i + 1);
      }
    });
    stream.on("end", () => {
      if (buf) this.handleLine(c, buf, tag);
    });
  }

  private handleLine(c: Child, text: string, tag: string): void {
    this.line(c, tag ? `${tag} ${text}` : text);
    const m = SERVING.exec(text);
    if (m && c.state === "starting") {
      c.url = m[1];
      c.state = "online";
      c.healthyTimer = setTimeout(() => {
        c.failures = 0;
      }, this.backoff.healthyResetMs);
      c.healthyTimer.unref();
    }
  }

  private spawnChild(c: Child): void {
    c.state = "starting";
    c.url = null;
    c.adopted = false;
    c.nextRestartAt = null;
    c.startedAt = Date.now();
    if (this.transport === "socket") {
      void this.adoptOrSpawn(c);
      return;
    }
    this.launch(c, ["--port", "0"]);
  }

  /**
   * Socket mode: a live wolfd already answering on the wolf's socket is an orphan of a previous workerd — adopt it
   * (never a second wolfd on the same den). A socket file nobody answers on is stale: remove it, then spawn.
   */
  private async adoptOrSpawn(c: Child): Promise<void> {
    const sock = c.config.serve.socket;
    if (await probeSocket(sock)) {
      if (this.stopping || c.state !== "starting") return;
      c.adopted = true;
      c.url = UNIX_PREFIX + sock;
      c.state = "online";
      this.line(c, `supervisor: adopted orphan wolfd on ${sock}`);
      this.watchAdopted(c, sock);
      return;
    }
    if (this.stopping) return;
    if (existsSync(sock)) {
      try {
        rmSync(sock, { force: true });
        this.line(c, `supervisor: removed stale socket ${sock}`);
      } catch (e) {
        // A socket in a dir workerd may not write (a per-wolf runtime dir owned by another user): the wolfd that owns it replaces it itself.
        this.line(c, `supervisor: stale socket ${sock} left in place: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.launch(c, ["--socket", sock]);
  }

  /** An adopted wolfd has no process handle; poll it and fall back to the restart path if it stops answering. */
  private watchAdopted(c: Child, sock: string): void {
    c.adoptTimer = setInterval(() => {
      void probeSocket(sock).then((alive) => {
        if (alive || !c.adoptTimer || this.stopping) return;
        clearInterval(c.adoptTimer);
        c.adoptTimer = null;
        c.url = null;
        c.adopted = false;
        this.line(c, "supervisor: adopted wolfd stopped answering");
        this.scheduleRestart(c);
      });
    }, ADOPT_POLL_MS);
    c.adoptTimer.unref();
  }

  /**
   * The Pack key file's env for one wolf. Only API-key wolves get ANTHROPIC_API_KEY: a subscription wolf (and any wolf whose transport
   * cannot be determined, see wolfTransport) never receives the metered key.
   */
  private packKeysFor(config: WolfConfig): Record<string, string> {
    const env = readKeyFileEnv(this.opts.keyFile!);
    if (wolfTransport(config, this.opts.env ?? process.env) !== "api") delete env.ANTHROPIC_API_KEY;
    return env;
  }

  private launch(c: Child, listenArgs: string[]): void {
    const [cmd, ...lead] = this.command;
    const proc = spawn(cmd, [...lead, "--config", c.config.file, ...listenArgs], {
      env: { ...(this.opts.env ?? process.env), ...(this.opts.keyFile ? this.packKeysFor(c.config) : {}), WOLFPACK_SUPERVISED: "workerd" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    c.proc = proc;
    this.line(c, `supervisor: spawned pid ${proc.pid ?? "?"}`);
    this.pipeLines(c, proc.stdout, "");
    this.pipeLines(c, proc.stderr, "");
    proc.on("error", (e) => this.line(c, `supervisor: spawn error: ${e.message}`));
    proc.on("close", (code, signal) => this.onExit(c, proc, code, signal));
  }

  private onExit(c: Child, proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (c.proc !== proc) return;
    c.proc = null;
    c.url = null;
    if (c.healthyTimer) clearTimeout(c.healthyTimer);
    this.line(c, `supervisor: exited code=${code} signal=${signal}`);
    if (this.stopping) {
      c.state = "stopped";
      return;
    }
    this.scheduleRestart(c);
  }

  private scheduleRestart(c: Child): void {
    // A child that was up past the healthy window counts as a fresh failure sequence.
    if (Date.now() - c.startedAt >= this.backoff.healthyResetMs) c.failures = 0;
    c.failures += 1;
    if (c.failures > this.maxRestarts) {
      c.state = "failed";
      this.line(c, `supervisor: giving up after ${this.maxRestarts} consecutive restarts; wolf marked failed`);
      return;
    }
    const delay = backoffDelay(c.failures, this.backoff);
    c.state = "restarting";
    c.nextRestartAt = Date.now() + delay;
    this.line(c, `supervisor: restart #${c.restarts + 1} in ${delay}ms`);
    c.timer = setTimeout(() => {
      c.timer = null;
      c.restarts += 1;
      this.spawnChild(c);
    }, delay);
  }

  /**
   * Restart one wolf's wolfd now (no backoff). Unit-wrapped wolves (and wolfds adopted from such a unit) are restarted with
   * `systemctl restart wolfd@<name>` and count as restarted only if the unit's InvocationID changed; the wrapper is re-run afterwards to
   * keep supervising. Plain children are stopped and spawned again. An adopted wolfd outside a unit cannot be restarted from here.
   */
  async restartWolf(name: string): Promise<{ invocation?: string; unconfirmed?: true }> {
    const c = this.children.get(name);
    if (!c) throw new Error(`no such wolf ${name}`);
    if (this.stopping) throw new Error("workerd is shutting down");
    if (c.adopted && !this.wolfdUnits) throw new Error("this wolfd was adopted from a previous workerd and has no process handle; restart it from its own unit");
    await this.stopChild(c);
    c.failures = 0;
    if (!this.wolfdUnits) {
      this.spawnChild(c);
      return {};
    }
    const unit = `wolfd@${name}.service`;
    const sc = this.opts.systemctl ?? execSystemctl;
    const invocation = async () => (await sc(["show", "-p", "InvocationID", "--value", unit])).trim();
    // Between stopChild above and the respawn in `finally` below, this wolf has no supervision: a crash in that gap is not restarted by us.
    // The window is a couple of systemctl calls long, and the unit itself is restarted by systemd meanwhile.
    try {
      const before = await invocation(); // a failing first read throws here, before anything is restarted
      await sc(["restart", unit]);
      let after: string;
      try {
        after = await invocation();
      } catch {
        return { unconfirmed: true }; // the restart went through; only the confirming read failed
      }
      if (!after || after === before) throw new Error("the wolf did not restart");
      return { invocation: after };
    } finally {
      if (!this.stopping) {
        try {
          this.spawnChild(c); // re-attach the wrapper (its `systemctl start` is a no-op on an active unit)
        } catch (e) {
          // Never let a respawn failure replace the error (or result) of the restart itself.
          this.line(c, `supervisor: could not re-attach after restart: ${String((e as Error)?.message ?? e).split("\n")[0]}`);
        }
      }
    }
  }

  /** Whether a turn is running in this wolf's wolfd (its /v1/wolves status is busy). False when it cannot be read. */
  async wolfBusy(name: string): Promise<boolean> {
    const url = this.children.get(name)?.url;
    if (!url) return false;
    try {
      const b = (await getJson(url, "/v1/wolves", 2000)) as { wolves?: { name?: string; status?: string }[] };
      return (b.wolves ?? []).some((w) => w.name === name && w.status === "busy");
    } catch {
      return false;
    }
  }

  private stopChild(c: Child): Promise<void> {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    if (c.healthyTimer) clearTimeout(c.healthyTimer);
    if (c.adoptTimer) clearInterval(c.adoptTimer);
    c.adoptTimer = null;
    // An adopted wolfd was not started by us and is left running (that is the point of adoption).
    c.adopted = false;
    const proc = c.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      if (c.state !== "failed") c.state = "stopped";
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const kill = setTimeout(() => {
        this.line(c, "supervisor: grace expired, SIGKILL");
        proc.kill("SIGKILL");
      }, this.graceMs);
      proc.once("close", () => {
        clearTimeout(kill);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }
}
