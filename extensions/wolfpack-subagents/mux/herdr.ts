/**
 * Herdr MuxBackend — drives panes through the `herdr` CLI. A subagent pane is a
 * right split off the calling pi pane (`--current`, resolved via $HERDR_PANE_ID)
 * created with `--no-focus` so it never steals the user's keyboard. Panes are
 * Herdr ids (e.g. `w1:p3`).
 *
 * Herdr distinguishes "pane" (raw terminal) from "agent" (a recognized coding
 * agent). We deliberately use only the `pane` verbs: the subagent is launched
 * as a shell command and its completion is detected via file sidecars + a
 * terminal sentinel, exactly like the tmux path — so Herdr's agent recognition
 * is unnecessary.
 *
 * `pane read --source visible` returns the rendered viewport as PLAIN TEXT
 * (not JSON); `recent`/`recent-unwrapped` can be empty when nothing has
 * scrolled into host scrollback, so `visible` is the reliable sentinel source
 * for print-mode (non-alt-screen) children.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { type MuxBackend, hasCommand } from "./shared.ts";

const execFileAsync = promisify(execFile);

function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) throw new Error(`Herdr is required for subagents. ${herdrBackend.setupHint()}`);
}

/** Parse `herdr pane split` JSON → new pane id. */
function parsePaneId(stdout: string): string {
  const data = JSON.parse(stdout);
  const id = data?.result?.pane?.pane_id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Unexpected herdr pane split output: ${stdout.slice(0, 200)}`);
  }
  return id;
}

export const herdrBackend: MuxBackend = {
  name: "herdr",

  isAvailable: isHerdrAvailable,

  setupHint() {
    return "Run pi inside a Herdr-managed pane (HERDR_ENV=1).";
  },

  createSurface(name: string): string {
    requireHerdr();
    const out = execFileSync(
      "herdr",
      ["pane", "split", "--current", "--direction", "right", "--cwd", process.cwd(), "--no-focus"],
      { encoding: "utf8" },
    );
    const pane = parsePaneId(out);
    // Best-effort: label the pane with the subagent name for a nicer sidebar.
    if (name) {
      try {
        execFileSync("herdr", ["pane", "rename", pane, name], { encoding: "utf8", stdio: "ignore" });
      } catch {
        // cosmetic only
      }
    }
    return pane;
  },

  sendCommand(surface: string, command: string): void {
    requireHerdr();
    // `herdr pane run` atomically sends the command text + Enter.
    execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
  },

  readScreen(surface: string, lines = 50): string {
    requireHerdr();
    return execFileSync(
      "herdr",
      ["pane", "read", surface, "--source", "visible", "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
  },

  async readScreenAsync(surface: string, lines = 50): Promise<string> {
    requireHerdr();
    const { stdout } = await execFileAsync(
      "herdr",
      ["pane", "read", surface, "--source", "visible", "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
    return stdout;
  },

  closeSurface(surface: string): void {
    requireHerdr();
    execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
  },
};
