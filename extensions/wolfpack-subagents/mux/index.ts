/**
 * Mux dispatch layer — the single surface the subagents engine (../index.ts)
 * imports. It selects ONE backend per process and re-exports the exact set of
 * functions the engine expects, so the rest of the ~5k-line engine is backend-
 * agnostic and unchanged.
 *
 * Backend selection (per wolf) via `WOLFPACK_SUBAGENT_MUX`:
 *   - "herdr"  force Herdr
 *   - "tmux"   force tmux
 *   - "none"   force headless (no panes; isMuxAvailable() === false)
 *   - "auto"   (default) Herdr if HERDR_ENV=1, else tmux if $TMUX, else none
 *
 * So a macOS wolf under Herdr and a Linux wolf under tmux each pick the right
 * multiplexer with no config, and a wolf can be pinned explicitly.
 */
import {
  type MuxBackend,
  type PollResult,
  pollForExitWith,
  sendLongCommandWith,
  shellEscape as sharedShellEscape,
} from "./shared.ts";
import { tmuxBackend } from "./tmux.ts";
import { herdrBackend } from "./herdr.ts";

const noneBackend: MuxBackend = {
  name: "none",
  isAvailable: () => false,
  setupHint: () =>
    "No terminal multiplexer available. Run the wolf inside Herdr (macOS) or tmux (Linux), " +
    "or set WOLFPACK_SUBAGENT_MUX=herdr|tmux.",
  createSurface() {
    throw new Error(`No multiplexer backend available. ${noneBackend.setupHint()}`);
  },
  sendCommand() {
    throw new Error("No multiplexer backend available.");
  },
  readScreen() {
    return "";
  },
  async readScreenAsync() {
    return "";
  },
  closeSurface() {
    /* no-op */
  },
};

function selectBackend(): MuxBackend {
  const pref = (process.env.WOLFPACK_SUBAGENT_MUX ?? "auto").trim().toLowerCase();
  switch (pref) {
    case "tmux":
      return tmuxBackend;
    case "herdr":
      return herdrBackend;
    case "none":
    case "off":
    case "headless":
      return noneBackend;
    default: {
      // auto
      if (herdrBackend.isAvailable()) return herdrBackend;
      if (tmuxBackend.isAvailable()) return tmuxBackend;
      return noneBackend;
    }
  }
}

/** The active backend for this process (env is stable per process). */
const active: MuxBackend = selectBackend();

// ── Re-exports consumed by ../index.ts (the engine) ──

export type { PollResult };

export function isMuxAvailable(): boolean {
  return active.isAvailable();
}

export function muxSetupHint(): string {
  return active.setupHint();
}

export function createSurface(name: string): string {
  return active.createSurface(name);
}

export function sendCommand(surface: string, command: string): void {
  active.sendCommand(surface, command);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  return sendLongCommandWith(active, surface, command, options);
}

export function readScreen(surface: string, lines?: number): string {
  return active.readScreen(surface, lines);
}

export function closeSurface(surface: string): void {
  active.closeSurface(surface);
}

export function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  return pollForExitWith(active, surface, signal, options);
}

export const shellEscape = sharedShellEscape;

/** Which backend is active (for diagnostics/logging). */
export function activeMuxName(): string {
  return active.name;
}
