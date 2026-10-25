import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { WolfConfig } from "@wolfpack/engine";
import { UNIX_PREFIX, probeSocket } from "./socket.js";
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
  /** Consecutive failed restarts tolerated before a wolf is marked failed. Default 10. */
  maxRestarts?: number;
  /** SIGTERM → SIGKILL grace on shutdown. Default 5000. */
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
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
  private stopping = false;

  constructor(private readonly opts: SupervisorOptions) {
    this.backoff = { baseMs: 500, capMs: 30_000, healthyResetMs: 60_000, ...opts.backoff };
    this.maxRestarts = opts.maxRestarts ?? 10;
    this.graceMs = opts.graceMs ?? 5000;
    this.command = opts.command ?? defaultWolfdCommand();
    this.transport = opts.transport ?? (opts.command ? "tcp" : "socket");
    for (const w of opts.wolves) this.children.set(w.identity.name, new Child(w));
  }

  start(): void {
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
    (this.opts.log ?? ((l) => process.stderr.write(`${l}\n`)))(`[${name}] ${text}`);
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
      rmSync(sock, { force: true });
      this.line(c, `supervisor: removed stale socket ${sock}`);
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

  private launch(c: Child, listenArgs: string[]): void {
    const [cmd, ...lead] = this.command;
    const proc = spawn(cmd, [...lead, "--config", c.config.file, ...listenArgs], {
      env: this.opts.env ?? process.env,
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
