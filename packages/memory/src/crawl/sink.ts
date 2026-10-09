/**
 * sink — the development microscope. Every crawl stage writes its output under
 * /tmp/wolfpack-crawl/<session>/ FIRST, before anything reaches the KB, so the
 * pipeline can be observed stage-by-stage while it is being built (spec §4).
 */
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CrawlSink {
  readonly dir: string;
  /** Append a timestamped line to run.log and echo to stderr. */
  log(msg: string): void;
  /** Write a whole file under the session dir (relative path). */
  file(relPath: string, content: string): void;
  /** Append one JSON line to a .jsonl file under the session dir. */
  jsonl(relPath: string, obj: unknown): void;
  /** Run an async op while printing an elapsed-time heartbeat, so a long LLM
   *  call never looks like a hang. Returns the op's result. */
  heartbeat<T>(label: string, op: () => Promise<T>, everyMs?: number): Promise<T>;
}

/** Default observability root. Explicitly /tmp (not os.tmpdir(), which on macOS
 *  is a per-user /var/folders path) so the dev microscope is where you expect. */
export const DEFAULT_SINK_BASE = "/tmp/wolfpack-crawl";

export function createSink(
  sessionId: string,
  base?: string,
  quiet = false
): CrawlSink {
  const dir = join(base ?? DEFAULT_SINK_BASE, sessionId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "run.log");

  return {
    dir,
    log(msg: string): void {
      const line = `${new Date().toISOString()}  ${msg}\n`;
      appendFileSync(logPath, line);
      // The run.log file is the permanent record; the stderr echo is the dev
      // microscope. Quiet mode keeps the file but silences the echo so a TUI
      // caller (e.g. /wolf:crawl-release) can present its own clean closeout.
      if (!quiet) process.stderr.write(`[crawl] ${msg}\n`);
    },
    file(relPath: string, content: string): void {
      const p = join(dir, relPath);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    },
    jsonl(relPath: string, obj: unknown): void {
      const p = join(dir, relPath);
      mkdirSync(join(p, ".."), { recursive: true });
      appendFileSync(p, JSON.stringify(obj) + "\n");
    },
    async heartbeat<T>(label: string, op: () => Promise<T>, everyMs = 5000): Promise<T> {
      const t0 = Date.now();
      const id = setInterval(() => {
        const s = Math.round((Date.now() - t0) / 1000);
        if (!quiet) process.stderr.write(`[crawl]   … ${label} (${s}s)\n`);
      }, everyMs);
      try {
        return await op();
      } finally {
        clearInterval(id);
      }
    },
  };
}
