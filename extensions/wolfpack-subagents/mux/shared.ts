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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      const screen = await backend.readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
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
