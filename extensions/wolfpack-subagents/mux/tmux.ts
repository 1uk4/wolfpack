/**
 * tmux MuxBackend — splits a pane off the parent pi's pane (`$TMUX_PANE`) so it
 * follows the agent, not the user's focus. Panes are tmux ids (e.g. `%12`).
 * Ported from amosblomqvist/pi-interactive-subagents (tmux.ts).
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { type MuxBackend, hasCommand } from "./shared.ts";

const execFileAsync = promisify(execFile);

/** tmux layout applied after each split/close to keep panes evenly sized. */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

function rebalanceSurfaces(hintPane?: string): void {
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], { encoding: "utf8" });
    } catch {
      // best-effort
    }
  }, 120);
}

function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

function createSurfaceSplit(direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
  if (!isTmuxAvailable()) throw new Error(`tmux is required for subagents. ${tmuxBackend.setupHint()}`);
  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") args.push("-h");
  else args.push("-v");
  if (direction === "left" || direction === "up") args.push("-b");
  if (fromSurface) args.push("-t", fromSurface);
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);
  rebalanceSurfaces(pane);
  return pane;
}

export const tmuxBackend: MuxBackend = {
  name: "tmux",

  isAvailable: isTmuxAvailable,

  setupHint() {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  },

  createSurface(_name: string): string {
    // Right split off the parent pi pane so it follows the agent.
    return createSurfaceSplit("right", process.env.TMUX_PANE);
  },

  sendCommand(surface: string, command: string): void {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
  },

  readScreen(surface: string, lines = 50): string {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
  },

  async readScreenAsync(surface: string, lines = 50): Promise<string> {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  },

  closeSurface(surface: string): void {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    rebalanceSurfaces();
  },
};
