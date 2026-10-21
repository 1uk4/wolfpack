/**
 * Background "surface": runs the same generated launch script a pane would,
 * but as a detached child process with stdout/stderr going to a log file.
 *
 * It is shaped like a MuxBackend so the engine's launch / poll / close flow is
 * identical for pane and background agents. A non-TTY pi runs in print mode
 * (one prompt, then exit), which is exactly the autonomous run a background
 * agent needs; the `__SUBAGENT_DONE_<n>__` line the script echoes lands in the
 * log, so the generic exit poller finds it through readScreenAsync.
 *
 * Surface ids are `bg:<n>`; mux/index.ts routes by that prefix.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MuxBackend } from "./shared.ts";

export const BACKGROUND_PREFIX = "bg:";

interface BackgroundJob {
  child?: ChildProcess;
  logPath?: string;
}

const jobs = new Map<string, BackgroundJob>();
let counter = 0;

export function isBackgroundSurface(surface: string): boolean {
  return surface.startsWith(BACKGROUND_PREFIX);
}

/** Command sendLongCommandWith types: `bash '<script>'`. */
function scriptFromCommand(command: string): string {
  const m = command.match(/^bash '((?:[^']|'\\'')*)'$/);
  if (!m) throw new Error("Background launch expects a `bash <script>` command.");
  return m[1].replace(/'\\''/g, "'");
}

function tailLines(text: string, lines: number): string {
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function readLog(logPath: string | undefined, lines: number): string {
  if (!logPath) return "";
  try {
    // Only the last ~64KB matters for the sentinel / crash summary.
    const size = statSync(logPath).size;
    const buf = readFileSync(logPath);
    return tailLines(buf.subarray(Math.max(0, size - 65536)).toString("utf-8"), lines);
  } catch {
    return "";
  }
}

export const backgroundBackend: MuxBackend = {
  name: "background",
  isAvailable: () => true,
  setupHint: () => "Background agents need no multiplexer.",
  createSurface(): string {
    const surface = `${BACKGROUND_PREFIX}${++counter}`;
    jobs.set(surface, {});
    return surface;
  },
  sendCommand(surface, command) {
    const job = jobs.get(surface);
    if (!job) throw new Error(`Unknown background surface ${surface}.`);
    if (job.child) {
      throw new Error("This agent runs in the background and can't be steered mid-run.");
    }
    const script = scriptFromCommand(command);
    const logPath = script.endsWith(".sh")
      ? script.replace(/\.sh$/, ".log")
      : join(tmpdir(), "pi-subagent-scripts", `bg-${Date.now()}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    const fd = openSync(logPath, "a");
    try {
      // detached: own session/process group, no controlling TTY, survives
      // whatever the parent's terminal does. stdin is closed so pi picks print mode.
      const child = spawn("bash", [script], { detached: true, stdio: ["ignore", fd, fd] });
      child.on("error", () => {});
      child.unref();
      job.child = child;
      job.logPath = logPath;
    } finally {
      closeSync(fd);
    }
  },
  readScreen: (surface, lines = 200) => readLog(jobs.get(surface)?.logPath, lines),
  async readScreenAsync(surface, lines = 200) {
    return readLog(jobs.get(surface)?.logPath, lines);
  },
  closeSurface(surface) {
    const job = jobs.get(surface);
    jobs.delete(surface);
    const pid = job?.child?.pid;
    if (!pid || job?.child?.exitCode !== null || job?.child?.signalCode) return;
    // Kill the whole group (bash script + pi + its tool children).
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 5000).unref();
  },
};
