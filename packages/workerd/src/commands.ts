/**
 * Command channel, machine side: runs the `cmd` frames the hub sends over the link and answers each with one `cmd.result`.
 * `supported()` is what the hello advertises; a command the machine cannot run is simply not advertised (the hub then answers
 * `not_sent_unsupported`). Nothing here persists a command or its result.
 */
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { COMMAND_LOGS_MAX_BYTES, type CommandKind, type CommandResultCode, type LinkCmd, type LinkCmdResult, type LogsData } from "@wolfpack/protocol";

/** Where a service's log lines come from: a systemd unit (Linux) or a log file (a supervised wolf's wolfd log, on any platform). */
export interface LogSource {
  unit?: string;
  file?: string;
}

/** The services `logs.fetch` may read on a machine without any configuration. A fixed allowlist: the name is never used as a path or a unit by itself. */
export const DEFAULT_LOG_UNITS: Readonly<Record<string, string>> = { workerd: "workerd.service", hubd: "hubd.service", console: "console.service" };

export interface CommandRunnerOptions {
  platform?: NodeJS.Platform;
  /** Extra log sources by service name (the supervised wolves' log files). A name equal to a default unit is ignored with a warning. The Mac app keeps no workerd log file of its own, so workerd has no source there. */
  logSources?: () => Record<string, LogSource>;
  /** @internal Run `journalctl` with this argv (no shell). Default: execFile. */
  runJournal?: (argv: string[]) => Promise<string>;
  log?: (m: string) => void;
}

export interface CommandRunner {
  /** The kinds this machine can run right now (advertised in hello). */
  supported(): CommandKind[];
  handle(cmd: LinkCmd): Promise<LinkCmdResult>;
}

/** After a journal buffer overflow, the second try asks for this many lines (or fewer). */
const JOURNAL_RETRY_LINES = 500;

const ok = (id: string, data?: unknown): LinkCmdResult => ({ t: "cmd.result", id, ok: true, ...(data !== undefined ? { data } : {}) });
const fail = (id: string, code: CommandResultCode, message: string): LinkCmdResult => ({ t: "cmd.result", id, ok: false, code, message });

function execJournal(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("journalctl", argv, { maxBuffer: 4 * 1024 * 1024, timeout: 10_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** The last `maxBytes` of a file as text. `cut` is true when the file was bigger than the window (the partial first line is dropped). */
async function readTail(file: string, maxBytes: number): Promise<{ text: string; cut: boolean }> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const cut = size > len;
    let text = buf.toString("utf8");
    if (cut) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return { text, cut };
  } finally {
    await fh.close();
  }
}

/** The last `n` lines of `text` that fit in COMMAND_LOGS_MAX_BYTES; lines are untouched. `truncated` when the byte cap dropped any. One backward pass over the bytes; a single oversized line is cut on a UTF-8 boundary. */
export function capLines(text: string, n: number): LogsData {
  const buf = Buffer.from(text, "utf8");
  let end = buf.length;
  if (end && buf[end - 1] === 10) end--;
  if (end === 0) return { lines: [], truncated: false };
  let start = 0;
  let seen = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (buf[i] === 10 && ++seen === n) {
      start = i + 1;
      break;
    }
  }
  let truncated = false;
  if (end - start > COMMAND_LOGS_MAX_BYTES) {
    truncated = true;
    const cut = end - COMMAND_LOGS_MAX_BYTES;
    const nl = buf.indexOf(10, cut - 1);
    if (nl !== -1 && nl + 1 < end) start = nl + 1;
    else {
      start = cut;
      while (start < end && (buf[start]! & 0xc0) === 0x80) start++; // do not start inside a multi-byte character
    }
  }
  return { lines: buf.subarray(start, end).toString("utf8").split("\n"), truncated };
}

export function createCommandRunner(o: CommandRunnerOptions = {}): CommandRunner {
  const platform = o.platform ?? process.platform;
  const log = o.log ?? (() => {});
  const warnedShadow = new Set<string>();

  async function logsFetch(id: string, args: { service: string; lines: number }): Promise<LinkCmdResult> {
    const extra = o.logSources?.() ?? {};
    const isDefault = Object.hasOwn(DEFAULT_LOG_UNITS, args.service);
    if (isDefault && Object.hasOwn(extra, args.service) && !warnedShadow.has(args.service)) {
      warnedShadow.add(args.service);
      log(`logs.fetch: ignoring a wolf log source named ${args.service}; it would shadow the machine's ${args.service} unit`);
    }
    const src: LogSource | undefined = isDefault ? (platform === "linux" ? { unit: DEFAULT_LOG_UNITS[args.service] } : undefined) : Object.hasOwn(extra, args.service) ? extra[args.service] : undefined;
    if (!src || (!src.file && !(platform === "linux" && src.unit))) return fail(id, "unknown_service", `no log for ${args.service.slice(0, 40)} on this machine`);
    if (src.unit && platform === "linux") {
      const run = o.runJournal ?? execJournal;
      const read = (n: number) => run(["-u", src.unit!, "-n", String(n), "--no-pager"]);
      const overflowed = (e: unknown) => (e as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      try {
        return ok(id, capLines(await read(args.lines), args.lines));
      } catch (e) {
        if (!overflowed(e)) return fail(id, "internal", "could not read the journal");
        // journalctl prints oldest first, so the partial output of an overflow holds the OLDEST lines. Ask again for fewer lines to get the newest.
        const n = Math.min(args.lines, JOURNAL_RETRY_LINES);
        try {
          if (n < args.lines) return ok(id, { ...capLines(await read(n), n), truncated: true });
        } catch (e2) {
          if (!overflowed(e2)) return fail(id, "internal", "could not read the journal");
          e = e2;
        }
        // Last resort: the partial output of the overflow, minus its last line, which the buffer cut off mid-line.
        const partial = (e as { stdout?: unknown }).stdout;
        if (typeof partial !== "string") return fail(id, "internal", "could not read the journal");
        const nl = partial.lastIndexOf("\n");
        return ok(id, { ...capLines(nl === -1 ? "" : partial.slice(0, nl), args.lines), truncated: true });
      }
    }
    try {
      const t = await readTail(src.file!, COMMAND_LOGS_MAX_BYTES * 2);
      const data = capLines(t.text, args.lines);
      return ok(id, { lines: data.lines, truncated: data.truncated || t.cut });
    } catch {
      return fail(id, "internal", "log file not readable"); // fixed text: no path, no errno
    }
  }

  return {
    supported: () => ["logs.fetch"],
    async handle(cmd) {
      try {
        if (cmd.kind === "logs.fetch") return await logsFetch(cmd.id, cmd.args as { service: string; lines: number });
        return fail(cmd.id, "internal", "command not supported on this machine");
      } catch (e) {
        log(`command ${cmd.kind} ${cmd.id} failed: ${(e as Error).message}`);
        return fail(cmd.id, "internal", "the command failed");
      }
    },
  };
}
