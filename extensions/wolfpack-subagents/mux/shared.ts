/**
 * Shared mux helpers + the backend contract.
 *
 * The subagents engine (index.ts) only ever touches a terminal multiplexer
 * through the small set of functions re-exported by ./index.ts. Those dispatch
 * to a MuxBackend chosen per wolf (tmux on Linux, Herdr on macOS, or none).
 * Everything backend-independent lives here: shell escaping, command
 * availability, the long-command-via-script helper, the PollResult shape, and
 * the generic exit poller (which only needs a backend's async screen read).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ── Backend contract ──

/**
 * A "surface" is one multiplexer pane. Backends create/drive/read/close them;
 * they are addressed by an opaque backend-specific id (tmux `%12`, Herdr
 * `w1:p3`).
 */
export interface MuxBackend {
  /** Stable key: "tmux" | "herdr" | "none". */
  readonly name: string;
  /** True when this backend can actually create panes right now. */
  isAvailable(): boolean;
  /** One-line hint telling the user how to make this backend available. */
  setupHint(): string;
  /** Create a pane for a subagent and return its surface id. */
  createSurface(name: string): string;
  /** Type a command into a pane and submit it (Enter). */
  sendCommand(surface: string, command: string): void;
  /** Read a pane's screen (sync). */
  readScreen(surface: string, lines?: number): string;
  /** Read a pane's screen (async). */
  readScreenAsync(surface: string, lines?: number): Promise<string>;
  /** Close a pane. */
  closeSurface(surface: string): void;
}

// ── Command availability ──

const commandAvailability = new Map<string, boolean>();

export function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) return commandAvailability.get(command)!;
  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }
  commandAvailability.set(command, available);
  return available;
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Wolf environment a subagent must inherit. A subagent pane is a fresh
 * multiplexer shell (it only gets the user's shell profile), not a child of
 * pi, so the env `wolfpack launch` loaded from the wolf's .env (den, KB roots,
 * Work API) never reaches it. ANTHROPIC_API_KEY is never forwarded, and when
 * pi itself has none (launch withholds it from subscription wolves) it is
 * unset in the pane too: the multiplexer server's own env may carry one, and a
 * subagent must not bill the API when its parent doesn't.
 */
const FORWARDED_ENV = /^(WOLF_|KB_|WORK_|WOLFPACK_)/;

/**
 * Snapshot the forwarded wolf env into a private (0600) file and return the
 * shell prefix that loads it. The prefix deletes the file once sourced, so the
 * Work API token is never left on disk; launch scripts themselves are 0755.
 * Returns "" when there is nothing to forward.
 */
export function wolfEnvPrefix(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const lines = Object.entries(env)
    .filter(([k, v]) => FORWARDED_ENV.test(k) && v !== undefined)
    .map(([k, v]) => `export ${k}=${shellEscape(v as string)}`);
  if (env.ANTHROPIC_API_KEY === undefined) lines.push("unset ANTHROPIC_API_KEY");
  if (lines.length === 0) return "";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // mode only applies on create
  const p = shellEscape(path);
  return `. ${p} && rm -f ${p} && `;
}

/**
 * Send a long command to a pane by writing it to a script file first, then
 * running `bash <script>`. Avoids terminal line-wrap corruption when a command
 * exceeds the pane width. Backend-independent: it only needs the backend's
 * sendCommand. Returns the script path.
 */
export function sendLongCommandWith(
  backend: MuxBackend,
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptParts.push(options.scriptPreamble.trimEnd());
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
  backend.sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited. */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error". */
  errorMessage?: string;
}

/** Interpret an `.exit` sidecar payload (written by the child error path). */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * How many trailing screen lines to scan for the done marker. The marker is
 * followed by the shell's timing line and prompt (often multi-line, with blank
 * lines), and narrow panes wrap each of those over several rows, so a tiny
 * window (it used to be 5) misses the marker and the exit is never seen.
 */
export const EXIT_SCAN_LINES = 200;

const DONE_MARKER = /__SUBAGENT_DONE_(\d+)__/g;

/** Last done marker on a screen (the newest run wins), or null. */
export function findDoneMarker(screen: string): number | null {
  let last: number | null = null;
  for (const m of screen.matchAll(DONE_MARKER)) last = parseInt(m[1], 10);
  return last;
}

/**
 * One non-consuming look at whether a subagent has exited: error sidecar,
 * Claude sentinel file, then the done marker on the pane. Returns null when
 * there is no sign of exit. Throws if the pane can't be read and no file
 * evidence exists, so callers can tell "alive" from "unknown".
 */
export async function probeExitWith(
  backend: MuxBackend,
  surface: string,
  options: { sessionFile?: string; sentinelFile?: string },
): Promise<PollResult | null> {
  if (options.sessionFile) {
    try {
      const exitFile = `${options.sessionFile}.exit`;
      if (existsSync(exitFile)) return interpretExitSidecar(JSON.parse(readFileSync(exitFile, "utf-8")));
    } catch {}
  }
  if (options.sentinelFile) {
    try {
      if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
    } catch {}
  }
  const exitCode = findDoneMarker(await backend.readScreenAsync(surface, EXIT_SCAN_LINES));
  return exitCode === null ? null : { reason: "sentinel", exitCode };
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), then the Claude sentinel file, then falls back
 * to scraping the pane for the terminal sentinel (crash detection). The
 * terminal read is the only backend-specific part, so it is injected.
 */
export async function pollForExitWith(
  backend: MuxBackend,
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
      } catch {}
    }

    try {
      const screen = await backend.readScreenAsync(surface, EXIT_SCAN_LINES);
      const exitCode = findDoneMarker(screen);
      if (exitCode !== null) return { reason: "sentinel", exitCode };
    } catch {
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
