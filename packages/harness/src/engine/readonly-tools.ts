/**
 * The read-only tools a subagent profile can list: `ls`, `grep`, `find` and `guarded_bash`. pi-durable ships none of
 * them, so ls/grep/find are small in-process versions that walk the call's execution environment (so they respect the
 * conversation's cwd, a worktree included) and cap their output. `guarded_bash` is the durable `bash` tool behind the
 * same read-only command guard the terminal pi uses (@wolfpack/agents command-guard, shared with extensions/wolfpack-subagents).
 */
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv, type FileInfo } from "@earendil-works/pi-durable/env";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import type { Extension } from "@earendil-works/pi-durable";
import { checkReadOnlyCommand } from "@wolfpack/agents";

export const READONLY_TOOL_NAMES = ["ls", "grep", "find", "guarded_bash"] as const;

const MAX_BYTES = 50 * 1024;
const MAX_LINE = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_VISITED = 20_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** `**`, `*` and `?` globs. A pattern without `/` matches the file name; otherwise the path relative to the search root. */
export function globToRegExp(glob: string): RegExp {
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

const globMatches = (re: RegExp, glob: string, rel: string) => re.test(glob.includes("/") ? rel : rel.slice(rel.lastIndexOf("/") + 1));

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

interface Entry {
  rel: string;
  info: FileInfo;
}

/** Depth-first walk (sorted), skipping .git and node_modules; stops after MAX_VISITED entries. */
async function* walk(env: ExecutionEnv, root: string, context: never): AsyncGenerator<Entry, boolean> {
  let visited = 0;
  async function* go(dir: string, prefix: string): AsyncGenerator<Entry, boolean> {
    const listed = await env.listDir(dir, context);
    if (!listed.ok) return false;
    for (const info of [...listed.value].sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > MAX_VISITED) return true;
      const rel = prefix + info.name;
      if (info.kind === "directory") {
        if (SKIP_DIRS.has(info.name)) continue;
        yield { rel, info };
        if (yield* go(info.path, `${rel}/`)) return true;
      } else yield { rel, info };
    }
    return false;
  }
  return yield* go(root, "");
}

const dirOf = async (env: ExecutionEnv, path: string | undefined, context: never) => getOrThrow(await env.absolutePath(path || ".", context));

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
    const dir = await dirOf(env, args.path, context as never);
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
  description: `Find files by glob pattern (e.g. '*.ts', 'src/**/*.test.ts'); returns paths relative to the search directory. Skips .git and node_modules. Output is capped at 1000 results or ${MAX_BYTES / 1024}KB.`,
  parameters: Type.Object({
    pattern: Type.String({ description: "Glob pattern to match files (a pattern without '/' matches the file name)" }),
    path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default 1000)" })),
  }),
  async execute(args, api, context) {
    const env = api.env;
    if (!env) throw new Error("No execution environment is configured");
    const root = await dirOf(env, args.path, context as never);
    const re = globToRegExp(args.pattern);
    const limit = Math.max(1, Math.floor(args.limit ?? 1000));
    const hits: string[] = [];
    const it = walk(env, root, context as never);
    let more = false;
    for (let n = await it.next(); !n.done; n = await it.next()) {
      if (n.value.info.kind === "directory" || !globMatches(re, args.pattern, n.value.rel)) continue;
      if (hits.length >= limit) {
        more = true;
        break;
      }
      hits.push(n.value.rel);
    }
    if (more) hits.push(`[limit of ${limit} results reached; narrow the pattern or path]`);
    return text(capLines(hits, "narrow the pattern or path") || "No files found matching pattern");
  },
});

const grepTool = defineTool({
  name: "grep",
  description: `Search file contents for a regex (or literal) pattern; returns 'path:line: text' matches. Skips .git, node_modules, binary files and files over 1MB. Output is capped at 100 matches or ${MAX_BYTES / 1024}KB, lines at ${MAX_LINE} chars.`,
  parameters: Type.Object({
    pattern: Type.String({ description: "Search pattern (regex, or a literal string with literal: true)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. '*.ts' or 'src/**/*.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default false)" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string (default false)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches (default 100)" })),
  }),
  async execute(args, api, context) {
    const env = api.env;
    if (!env) throw new Error("No execution environment is configured");
    const root = await dirOf(env, args.path, context as never);
    const src = args.literal ? args.pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") : args.pattern;
    let re: RegExp;
    try {
      re = new RegExp(src, args.ignoreCase ? "i" : "");
    } catch (e) {
      throw new Error(`Invalid pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
    const globRe = args.glob ? globToRegExp(args.glob) : undefined;
    const limit = Math.max(1, Math.floor(args.limit ?? 100));
    const out: string[] = [];
    let hitLimit = false;

    const searchFile = async (path: string, label: string): Promise<void> => {
      const info = await env.fileInfo(path, context);
      if (!info.ok || info.value.size > MAX_FILE_BYTES) return;
      const content = await env.readTextFile(path, context);
      if (!content.ok || content.value.includes("\0")) return;
      const lines = content.value.split("\n");
      for (let i = 0; i < lines.length && !hitLimit; i++) {
        if (!re.test(lines[i])) continue;
        if (out.length >= limit) {
          hitLimit = true;
          break;
        }
        const l = lines[i].replace(/\r$/, "");
        out.push(`${label}:${i + 1}: ${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l}`);
      }
    };

    const rootInfo = getOrThrow(await env.fileInfo(root, context));
    if (rootInfo.kind !== "directory") await searchFile(root, args.path ?? ".");
    else {
      const it = walk(env, root, context as never);
      for (let n = await it.next(); !n.done && !hitLimit; n = await it.next()) {
        if (n.value.info.kind === "directory") continue;
        if (globRe && !globMatches(globRe, args.glob!, n.value.rel)) continue;
        await searchFile(n.value.info.path, n.value.rel);
      }
    }
    if (hitLimit) out.push(`[limit of ${limit} matches reached; narrow the pattern, path or glob]`);
    return text(capLines(out, "narrow the pattern, path or glob") || "No matches found");
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

/** `ls`, `grep`, `find` and `guarded_bash` as one extension. */
export const ReadOnlyTools = defineExtension({
  name: "wolfd-readonly-tools",
  tools: [lsTool, grepTool, findTool, guardedBash],
}) as unknown as Extension;
