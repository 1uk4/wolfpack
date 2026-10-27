/**
 * The read-only tools a subagent profile can list: `ls`, `grep`, `find` and `guarded_bash`. pi-durable ships none of
 * them, so ls is a small in-process version on the call's execution environment and grep/find search in a worker thread
 * under a hard deadline (so they respect the conversation's cwd, a worktree included, and cannot block wolfd). All cap
 * their output and say when a cap or the deadline stopped a search. `guarded_bash` is the durable `bash` tool behind the
 * same read-only command guard the terminal pi uses (@wolfpack/agents command-guard, shared with extensions/wolfpack-subagents).
 */
import { Worker } from "node:worker_threads";
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import type { Extension } from "@earendil-works/pi-durable";
import { checkReadOnlyCommand } from "@wolfpack/agents";

export const READONLY_TOOL_NAMES = ["ls", "grep", "find", "guarded_bash"] as const;

const MAX_BYTES = 50 * 1024;
const MAX_LINE = 500;
const MAX_FILE_BYTES = 1024 * 1024;
/** Only this much of each line is tested against the pattern, so a long line cannot make a regex crawl. */
const MAX_TESTED_CHARS = 2000;
export const MAX_VISITED = 20_000;
export const DEADLINE_MS = 10_000;

/** `**`, `*` and `?` globs. A pattern without `/` matches the file name only (basenames); otherwise the path relative to the search root. A leading `./` is ignored. */
export function globToRegExp(glob: string): RegExp {
  glob = glob.replace(/^(\.\/)+/, "");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });

/** Join lines up to the byte budget; says so when it stops early. */
function capLines(lines: string[], note: string): string {
  const out: string[] = [];
  let bytes = 0;
  for (const l of lines) {
    bytes += Buffer.byteLength(l) + 1;
    if (bytes > MAX_BYTES) {
      out.push(`[output truncated at ${MAX_BYTES / 1024}KB; ${note}]`);
      break;
    }
    out.push(l);
  }
  return out.join("\n");
}

/**
 * The search worker (plain CJS source, run with `eval: true` so it works from a bundle too). It walks and searches
 * off the main thread, which the caller terminates at a hard deadline, so a catastrophic regex or a huge tree cannot
 * block wolfd. Symlinks are never followed: a symlinked directory is not entered, and grep skips symlinked files.
 * Posts `{hit}` per result and `{done, visited, stopped}` at the end.
 */
const SEARCH_WORKER = `
const { parentPort, workerData: w } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const globRe = w.glob ? new RegExp(w.glob.source, w.glob.flags) : undefined;
const nameOf = (rel) => (w.glob && w.glob.pattern.includes("/") ? rel : rel.slice(rel.lastIndexOf("/") + 1));
const re = w.mode === "grep" ? new RegExp(w.regex.source, w.regex.flags) : undefined;
let visited = 0, hits = 0, stopped = null;
const hit = (t) => { hits++; parentPort.postMessage({ hit: t }); };
function grepFile(abs, label) {
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (!st.isFile() || st.size > w.maxFileBytes) return;
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return; }
  if (buf.includes(0)) return;
  const lines = buf.toString("utf8").split("\\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\\r$/, "");
    if (!re.test(l.length > w.maxTested ? l.slice(0, w.maxTested) : l)) continue;
    if (hits >= w.limit) { stopped = "limit"; return; }
    hit(label + ":" + (i + 1) + ": " + (l.length > w.maxLine ? l.slice(0, w.maxLine) + "…" : l));
  }
}
function walk(dir, prefix) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    if (stopped) return;
    if (++visited > w.maxVisited) { stopped = "visited"; return; }
    const rel = prefix + e.name;
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      walk(path.join(dir, e.name), rel + "/");
      continue;
    }
    if (globRe && !globRe.test(nameOf(rel))) continue;
    if (w.mode === "find") {
      if (hits >= w.limit) { stopped = "limit"; return; }
      hit(rel);
    } else if (e.isFile()) grepFile(path.join(dir, e.name), rel);
  }
}
const st = fs.statSync(w.root);
if (st.isDirectory()) walk(w.root, "");
else if (w.mode === "grep") grepFile(w.root, w.label);
parentPort.postMessage({ done: true, visited, stopped });
`;

interface SearchSpec {
  mode: "grep" | "find";
  root: string;
  label?: string;
  limit: number;
  regex?: { source: string; flags: string };
  glob?: { source: string; flags: string; pattern: string };
}

interface SearchResult {
  lines: string[];
  visited: number;
  /** Why the search ended early, as a note for the model. */
  note?: string;
}

/** Run a search in a worker thread with a hard deadline. */
export function runSearch(spec: SearchSpec, opts: { deadlineMs?: number; maxVisited?: number } = {}): Promise<SearchResult> {
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const maxVisited = opts.maxVisited ?? MAX_VISITED;
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let visited = 0;
    let settled = false;
    const worker = new Worker(SEARCH_WORKER, {
      eval: true,
      workerData: { ...spec, maxVisited, maxFileBytes: MAX_FILE_BYTES, maxTested: MAX_TESTED_CHARS, maxLine: MAX_LINE },
    });
    const finish = (r: SearchResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    const timer = setTimeout(
      () => finish({ lines, visited, note: `[search stopped after ${deadlineMs / 1000}s deadline with ${lines.length} results so far; narrow the pattern, path or glob]` }),
      deadlineMs,
    );
    worker.on("message", (m: { hit?: string; done?: boolean; visited?: number; stopped?: string | null }) => {
      if (m.hit !== undefined) lines.push(m.hit);
      else if (m.done) {
        visited = m.visited ?? 0;
        const note =
          m.stopped === "visited"
            ? `[search stopped after ${maxVisited} entries; narrow the path or glob]`
            : m.stopped === "limit"
              ? `[limit of ${spec.limit} ${spec.mode === "grep" ? "matches" : "results"} reached; narrow the pattern, path or glob]`
              : undefined;
        finish({ lines, visited, ...(note ? { note } : {}) });
      }
    });
    worker.on("error", (e) => finish(e instanceof Error ? e : new Error(String(e))));
    worker.on("exit", (code) => finish(new Error(`search worker exited with code ${code}`)));
  });
}

const absDir = async (env: ExecutionEnv, path: string | undefined, context: never) => getOrThrow(await env.absolutePath(path || ".", context));

const lsTool = defineTool({
  name: "ls",
  description: `List a directory's entries (directories end in "/"), sorted, including dotfiles. Defaults to the working directory. Output is capped at 500 entries or ${MAX_BYTES / 1024}KB.`,
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of entries (default 500)" })),
  }),
  async execute(args, api, context) {
    const env = api.env;
    if (!env) throw new Error("No execution environment is configured");
    const dir = await absDir(env, args.path, context as never);
    const info = getOrThrow(await env.fileInfo(dir, context));
    if (info.kind !== "directory") throw new Error(`Not a directory: ${args.path ?? "."}`);
    const entries = getOrThrow(await env.listDir(dir, context)).sort((a, b) => a.name.localeCompare(b.name));
    const limit = Math.max(1, Math.floor(args.limit ?? 500));
    const lines = entries.slice(0, limit).map((e) => (e.kind === "directory" ? `${e.name}/` : e.name));
    if (entries.length > limit) lines.push(`[${entries.length - limit} more entries; raise limit or list a subdirectory]`);
    return text(capLines(lines, "list a subdirectory") || "(empty directory)");
  },
});

const findTool = defineTool({
  name: "find",
  description: `Find files by glob pattern (e.g. '*.ts', 'src/**/*.test.ts'); returns paths relative to the search directory. A pattern without '/' matches file names (basenames) at any depth. Skips .git and node_modules and does not follow symlinked directories. Output is capped at 1000 results or ${MAX_BYTES / 1024}KB; a search stops after ${MAX_VISITED} entries or ${DEADLINE_MS / 1000}s and says so.`,
  parameters: Type.Object({
    pattern: Type.String({ description: "Glob pattern to match files (a pattern without '/' matches the file name)" }),
    path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default 1000)" })),
  }),
  async execute(args, api, context) {
    const env = api.env;
    if (!env) throw new Error("No execution environment is configured");
    const root = await absDir(env, args.path, context as never);
    const glob = args.pattern.replace(/^(\.\/)+/, "");
    const re = globToRegExp(glob);
    const limit = Math.max(1, Math.floor(args.limit ?? 1000));
    const r = await runSearch({ mode: "find", root, limit, glob: { source: re.source, flags: re.flags, pattern: glob } });
    const lines = r.note ? [...r.lines, r.note] : r.lines;
    return text(capLines(lines, "narrow the pattern or path") || "No files found matching pattern");
  },
});

const grepTool = defineTool({
  name: "grep",
  description: `Search file contents for a regex (or literal) pattern; returns 'path:line: text' matches. Skips .git, node_modules, binary files, symlinked files and files over 1MB; only the first ${MAX_TESTED_CHARS} chars of a line are searched. Output is capped at 100 matches or ${MAX_BYTES / 1024}KB, lines at ${MAX_LINE} chars; a search stops after ${MAX_VISITED} entries or ${DEADLINE_MS / 1000}s and says so.`,
  parameters: Type.Object({
    pattern: Type.String({ description: "Search pattern (regex, or a literal string with literal: true)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. '*.ts' or 'src/**/*.ts' (no '/' matches file names)" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default false)" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string (default false)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches (default 100)" })),
  }),
  async execute(args, api, context) {
    const env = api.env;
    if (!env) throw new Error("No execution environment is configured");
    const root = await absDir(env, args.path, context as never);
    const src = args.literal ? args.pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") : args.pattern;
    const flags = args.ignoreCase ? "i" : "";
    try {
      new RegExp(src, flags);
    } catch (e) {
      throw new Error(`Invalid pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
    const glob = args.glob?.replace(/^(\.\/)+/, "");
    const globRe = glob ? globToRegExp(glob) : undefined;
    const limit = Math.max(1, Math.floor(args.limit ?? 100));
    const r = await runSearch({
      mode: "grep",
      root,
      label: args.path ?? ".",
      limit,
      regex: { source: src, flags },
      ...(globRe && glob ? { glob: { source: globRe.source, flags: globRe.flags, pattern: glob } } : {}),
    });
    const lines = r.note ? [...r.lines, r.note] : r.lines;
    return text(capLines(lines, "narrow the pattern, path or glob") || "No matches found");
  },
});

/** The durable `bash` tool under another name, refusing any command the read-only guard blocks before it runs. */
const guardedBash = (() => {
  const bash = createBashTool({
    prepare: (execution) => {
      const blocked = checkReadOnlyCommand(execution.command);
      if (blocked) throw new Error(blocked);
    },
  });
  return {
    ...bash,
    name: "guarded_bash",
    description:
      "Execute a read-only bash command. Writes, deletes, redirects to files (except /dev/null, and /tmp/ locally), service/package/git/network changes are blocked, including inside ssh '...', bash -c, sudo and $(...). " +
      bash.description,
  };
})();

const ALL_TOOLS = [lsTool, grepTool, findTool, guardedBash];

/** `ls`, `grep`, `find` and `guarded_bash` as one extension. */
export const ReadOnlyTools = defineExtension({ name: "wolfd-readonly-tools", tools: ALL_TOOLS }) as unknown as Extension;

/**
 * The same extension without any tool whose name another installed extension already defines (a wolf's own `grep`
 * wins); each skipped name goes to `onError`. Undefined when nothing is left.
 */
export function readOnlyToolsExcluding(taken: ReadonlySet<string>, onError: (message: string) => void): Extension | undefined {
  const tools = ALL_TOOLS.filter((t) => {
    if (!taken.has(t.name)) return true;
    onError(`read-only tool "${t.name}" not registered: another extension already defines it`);
    return false;
  });
  if (tools.length === ALL_TOOLS.length) return ReadOnlyTools;
  return tools.length ? (defineExtension({ name: "wolfd-readonly-tools", tools }) as unknown as Extension) : undefined;
}
