/**
 * Command channel, machine side: runs the `cmd` frames the hub sends over the link and answers each with one `cmd.result`.
 * `supported()` is what the hello advertises; a command the machine cannot run is simply not advertised (the hub then answers
 * `not_sent_unsupported`). Nothing here persists a command or its result.
 */
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { COMMAND_LOGS_MAX_BYTES, type CommandKind, type CommandResultCode, type LinkCmd, type LinkCmdResult, type LogsData, type RestartData, type RestartedWolf } from "@wolfpack/protocol";

/** Where a service's log lines come from: a systemd unit (Linux) or a log file (a supervised wolf's wolfd log, on any platform). */
export interface LogSource {
  unit?: string;
  file?: string;
}

/** The services `logs.fetch` may read on a machine without any configuration. A fixed allowlist: the name is never used as a path or a unit by itself. */
export const DEFAULT_LOG_UNITS: Readonly<Record<string, string>> = { workerd: "workerd.service", hubd: "hubd.service", console: "console.service" };

/** What wolves.restart needs from the supervisor. Exported so the Keys editor can restart wolves after a key change. */
export interface WolfControl {
  names(): string[];
  /** wasActive: the wolfd is up. midReply: a turn is running in it (restarting would cut a reply off). */
  status(name: string): Promise<{ wasActive: boolean; midReply: boolean }>;
  /** Stop and respawn one wolf's wolfd. Rejects when it cannot. */
  restart(name: string): Promise<void | { unconfirmed?: boolean }>;
}

/** The status read: every named wolf (default all), without restarting anything. */
export async function readWolfStatus(w: Pick<WolfControl, "names" | "status">, names?: string[]): Promise<RestartedWolf[]> {
  return Promise.all((names ?? w.names()).map(async (wolf) => ({ wolf, ...(await w.status(wolf).catch(() => ({ wasActive: false, midReply: false }))) })));
}

/**
 * Read each wolf's status, then restart the named wolves (all when none named) right away. Failures are reported per wolf; the rest still restart.
 * The status snapshot is taken once, before the parallel restarts begin, so `midReply` and `wasActive` describe the state at the start, not at the moment each wolf was cut off.
 */
export async function restartWolves(w: WolfControl, names?: string[]): Promise<{ ok: true; data: RestartData; message?: string } | { ok: false; code: "restart_failed" | "not_found"; message: string; data: RestartData }> {
  const known = new Set(w.names());
  const unknown = (names ?? []).filter((n) => !known.has(n));
  if (unknown.length) return { ok: false, code: "not_found", message: `no such wolf on this machine: ${unknown.map((n) => JSON.stringify(n.slice(0, 40))).join(", ")}`, data: { restarted: [] } };
  const before = await readWolfStatus(w, names);
  const restarted: RestartedWolf[] = [];
  const failed: string[] = [];
  let unconfirmed = false;
  // In parallel: restarting many wolves one by one would pass the hub's 15 s timeout.
  const outcomes = await Promise.allSettled(before.map((s) => w.restart(s.wolf)));
  outcomes.forEach((o, i) => {
    if (o.status === "fulfilled") {
      restarted.push(before[i]!);
      if (o.value && o.value.unconfirmed) unconfirmed = true;
    }
    else failed.push(`${before[i]!.wolf}: ${String((o.reason as Error)?.message ?? o.reason).split("\n")[0]}`);
  });
  return failed.length ? { ok: false, code: "restart_failed", message: `could not restart ${failed.join("; ")}`.slice(0, 1000), data: { restarted } } : { ok: true, data: { restarted }, ...(unconfirmed ? { message: "restarted, but could not confirm" } : {}) };
}

export interface CommandRunnerOptions {
  /** The wolves this workerd supervises. Absent (link-only: it supervises none) = wolves.restart is not advertised. */
  wolves?: WolfControl;
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
    supported: () => ["logs.fetch", ...(o.wolves ? (["wolves.restart"] as const) : [])],
    async handle(cmd) {
      try {
        if (cmd.kind === "logs.fetch") return await logsFetch(cmd.id, cmd.args as { service: string; lines: number });
        if (cmd.kind === "wolves.restart" && o.wolves) {
          const r = await restartWolves(o.wolves, (cmd.args as { wolf?: string }).wolf ? [(cmd.args as { wolf: string }).wolf] : undefined);
          return r.ok ? { ...ok(cmd.id, r.data), ...(r.message ? { message: r.message } : {}) } : { ...fail(cmd.id, r.code, r.message), data: r.data };
        }
        return fail(cmd.id, "internal", "command not supported on this machine");
      } catch (e) {
        log(`command ${cmd.kind} ${cmd.id} failed: ${(e as Error).message}`);
        return fail(cmd.id, "internal", "the command failed");
      }
    },
  };
}
