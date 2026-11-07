import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { git } from "./git.js";

export const INSTALL_TIMEOUT_MS = 5 * 60_000;
export const INSTALL_CONCURRENCY = 2;
const INSTALL_ARGS = ["install", "--frozen-lockfile", "--prefer-offline"];
const TAIL_LINES = 15;

export interface InstallRun {
  cwd: string;
  command: string;
  /** Everything after the command (a prefix such as `pnpm` for corepack, then the install args). */
  args: string[];
  timeoutMs: number;
  /** Where the process output goes (outside the tracked tree). */
  logPath: string;
  env: Record<string, string | undefined>;
  /** Abort kills the whole process group. */
  signal?: AbortSignal;
}
export interface InstallExit {
  code: number | null;
  timedOut: boolean;
  aborted?: boolean;
}
/** Test seam: runs the install process. */
export type InstallRunner = (run: InstallRun) => Promise<InstallExit>;

export type InstallCause = "pnpm-missing" | "lockfile" | "timeout" | "exit" | "error" | "aborted";
export interface InstallResult {
  status: "installed" | "skipped" | "failed";
  reason: string;
  ms: number;
  logPath?: string;
  cause?: InstallCause;
  /** The last lines of the log (secrets redacted), for a failure. */
  tail?: string;
  /** pnpm ran through corepack. */
  viaCorepack?: true;
}

/** A pnpm to run: the binary, and args that go before the install args (`corepack pnpm`). */
export interface PnpmCommand {
  command: string;
  args: string[];
}

export interface InstallLimiter {
  /** Resolves with a release function; rejects when the signal aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void>;
}

/** At most `max` holders at a time, FIFO. */
export function createInstallLimiter(max: number): InstallLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      if (active < max) {
        active++;
        return Promise.resolve(release);
      }
      return new Promise((resolve, reject) => {
        const go = () => { signal?.removeEventListener("abort", onAbort); resolve(release); };
        const onAbort = () => {
          const i = waiting.indexOf(go);
          if (i >= 0) waiting.splice(i, 1);
          reject(new Error("aborted"));
        };
        waiting.push(go);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
const defaultLimiter = createInstallLimiter(INSTALL_CONCURRENCY);

export interface InstallOptions {
  runner?: InstallRunner;
  /** Test seam: the pnpm to run, or null. */
  findPnpm?: () => PnpmCommand | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  limiter?: InstallLimiter;
  /** The environment to derive the child's from (default process.env). */
  env?: Record<string, string | undefined>;
}

function executable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
}

/** pnpm from PATH, then the usual install dirs, then `corepack pnpm` next to node. Null when none. */
export function locatePnpm(o: { path?: string; home?: string; systemDirs?: string[]; execPath?: string } = {}): PnpmCommand | null {
  const home = o.home ?? homedir();
  const dirs = [
    ...(o.path ?? process.env.PATH ?? "").split(delimiter).filter(Boolean),
    ...(o.systemDirs ?? ["/opt/homebrew/bin", "/usr/local/bin"]),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
  ];
  for (const d of dirs) {
    const p = join(d, "pnpm");
    if (executable(p)) return { command: p, args: [] };
  }
  const corepack = join(dirname(o.execPath ?? process.execPath), "corepack");
  return executable(corepack) ? { command: corepack, args: ["pnpm"] } : null;
}

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|_KEY$|^(?:ANTHROPIC|OPENAI)_|^(?:DATABASE_URL|SSH_AUTH_SOCK)$/i;
const KEPT_NAME = /^(?:NPM_TOKEN|NPM_CONFIG_.*)$/i; // (the registry login a private install may need)

/** process.env without WOLFPACK_* keys and anything that looks like a credential (a package script must not see them), plus CI=true. NPM_TOKEN and NPM_CONFIG_* stay. */
export function installEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (KEPT_NAME.test(k) || !(k.startsWith("WOLFPACK_") || SECRET_NAME.test(k))) out[k] = v;
  out.CI = "true";
  return out;
}

/** Run a command, output to a (truncated) log file, no shell; kill its group on timeout or abort. Never rejects. */
export function runInstallProcess(run: InstallRun): Promise<InstallExit> {
  return new Promise((resolve) => {
    if (run.signal?.aborted) return resolve({ code: null, timedOut: false, aborted: true });
    let fd: number | undefined;
    try {
      mkdirSync(dirname(run.logPath), { recursive: true });
      fd = openSync(run.logPath, "w");
    } catch { /* run without a log */ }
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env as NodeJS.ProcessEnv, shell: false, stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"], detached: true });
    const kill = () => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall through */ } }
      child.kill("SIGKILL");
    };
    const onAbort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, run.timeoutMs);
    run.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
      resolve({ code, timedOut, ...(aborted ? { aborted } : {}) });
    };
    child.once("error", () => done(127));
    child.once("close", (code) => done(code));
  });
}

/** Mask secret-looking values in text that is about to be shown to an agent. */
export function redactSecrets(text: string): string {
  return text
    // key=value, key: value, "key": "value" (quoted keys and values, values with spaces) for names that look like credentials
    .replace(/(["']?[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|credential)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@") // user:pass@
    .replace(/\/\/[^/\s:@]+@/g, "//[redacted]@") // token@
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]") // JWT
    .replace(/\b(?:sk|pk|ghp|gho|ghs|ghu|github_pat|npm|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, "[redacted]");
}

function logTail(path: string): string | undefined {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return lines.length > 0 ? redactSecrets(lines.slice(-TAIL_LINES).join("\n")) : undefined;
  } catch { return undefined; }
}

/** Whether a worktree wants an install at all (it has a pnpm-lock.yaml). */
export function wantsInstall(wsPath: string): boolean {
  return existsSync(join(wsPath, "pnpm-lock.yaml"));
}

/**
 * Install a new worktree's dependencies from the shared pnpm store. No pnpm-lock.yaml is a quiet skip; a lockfile with
 * no pnpm, or any failure, is `failed`. Never throws, so the worktree and the agent still start.
 */
export async function installDependencies(wsPath: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const aborted = (logPath?: string): InstallResult => ({ status: "failed", cause: "aborted", reason: "aborted", ms: ms(), ...(logPath ? { logPath } : {}) });
  if (!wantsInstall(wsPath)) return { status: "skipped", reason: "no pnpm-lock.yaml: skipped install", ms: ms() };
  let pnpm: PnpmCommand | null;
  try { pnpm = (opts.findPnpm ?? (() => locatePnpm()))(); } catch { pnpm = null; }
  if (!pnpm) return { status: "failed", cause: "pnpm-missing", reason: "pnpm not found; dependencies not installed", ms: ms() };
  let logPath: string | undefined;
  let release: (() => void) | undefined;
  try {
    release = await (opts.limiter ?? defaultLimiter).acquire(opts.signal);
  } catch {
    return aborted();
  }
  try {
    const g = await git(wsPath, ["rev-parse", "--absolute-git-dir"]);
    logPath = join(g.code === 0 && g.stdout.trim() ? g.stdout.trim() : join(wsPath, ".git"), "pnpm-install.log");
    const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
    const exit = await (opts.runner ?? runInstallProcess)({
      cwd: wsPath, command: pnpm.command, args: [...pnpm.args, ...INSTALL_ARGS], timeoutMs, logPath, env: installEnv(opts.env), ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (exit.aborted || opts.signal?.aborted) return aborted(logPath);
    const tail = logTail(logPath);
    const viaCorepack = basename(pnpm.command) === "corepack";
    const fail = (cause: InstallCause, reason: string): InstallResult => ({ status: "failed", cause, reason, ms: ms(), logPath: logPath!, ...(tail ? { tail } : {}), ...(viaCorepack ? { viaCorepack: true as const } : {}) });
    if (exit.timedOut) return fail("timeout", `timed out after ${Math.round(timeoutMs / 1000)} s`);
    if (exit.code !== 0) return fail(/ERR_PNPM_OUTDATED_LOCKFILE/.test(tail ?? "") ? "lockfile" : "exit", `exit ${exit.code}`);
    return { status: "installed", reason: "", ms: ms(), logPath };
  } catch (e) {
    return { status: "failed", cause: "error", reason: e instanceof Error ? e.message : String(e), ms: ms(), ...(logPath ? { logPath } : {}) };
  } finally {
    release?.();
  }
}

/** What the agent is told: one line, plus the log tail for a failure. */
export function dependenciesLine(r: InstallResult): string {
  if (r.status === "installed") return `Dependencies: installed with pnpm in ${(r.ms / 1000).toFixed(1)} s`;
  if (r.status === "skipped") return `Dependencies: ${r.reason}`;
  if (r.cause === "pnpm-missing") return `Dependencies: ${r.reason}`;
  const advice = r.cause === "lockfile" ? "the lockfile is out of date with package.json" : "run `pnpm install` yourself";
  const head = `Dependencies: install failed (${r.reason}${r.logPath ? `, log: ${r.logPath}` : ""})${r.viaCorepack ? " (via corepack)" : ""}; ${advice}`;
  return r.tail ? `${head}\nLast log lines:\n${r.tail}` : head;
}
