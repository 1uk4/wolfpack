/**
 * Hub-mirror write guard. A worker's KB mirror (workerd's kb-mirror dir) is read-only: the hub is the only writer. Any code that would
 * write under one must go through the hub instead; this refuses the write.
 *
 * A target is "under a mirror" when its resolved path (symlinks followed, dangling ones too) lies under
 *   (a) the configured workerd mirror dir: WORKERD_KB_MIRROR (absolute, `~` expanded), else <WORKERD_CONFIG_DIR | ~/.wolfpack/workerd>/kb-mirror; or
 *   (b) an ancestor dir holding workerd sync state: `.sync/<domain>.json` that parses as `{epoch: string, rev: number}` (kb-sync.ts DomState).
 *       A bare `.sync/` dir (Resilio, other tools) is NOT a mirror.
 *
 * Opt-out: WOLFPACK_KB_WRITER=1 disables the guard. Hub and agent hosts (hubd, wolfpack-agent), which legitimately write the KB tree, may set it.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** The workerd mirror dir (mirrors packages/workerd: <configDir>/kb-mirror). Throws if WORKERD_KB_MIRROR is not absolute. */
export function workerdMirrorDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WORKERD_KB_MIRROR) {
    const p = expandHome(env.WORKERD_KB_MIRROR);
    if (!isAbsolute(p)) throw new Error(`WORKERD_KB_MIRROR must be an absolute path (got ${JSON.stringify(env.WORKERD_KB_MIRROR)})`);
    return p;
  }
  return join(expandHome(env.WORKERD_CONFIG_DIR || join(homedir(), ".wolfpack", "workerd")), "kb-mirror");
}

/** Fully resolved form of `p`: realpath of the deepest existing part (dangling symlinks followed via readlink) + the not-yet-existing rest. */
function realish(p: string, depth = 0): string {
  if (depth > 40) return resolve(p);
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    let st;
    try { st = lstatSync(cur); } catch { st = undefined; }
    if (st) {
      if (st.isSymbolicLink()) {
        try { cur = realpathSync.native(cur); break; } catch {
          // dangling: follow the link text by hand
          return realish(join(resolve(dirname(cur), readlinkSync(cur)), ...rest), depth + 1);
        }
      }
      try { cur = realpathSync.native(cur); } catch { /* keep */ }
      break;
    }
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(cur.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    cur = up;
  }
  return rest.length ? join(cur, ...rest) : cur;
}

const fold = (s: string): string => (process.platform === "darwin" ? s.toLowerCase() : s);
const within = (child: string, parent: string): boolean => {
  const c = fold(child), p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/** True when `dir/.sync/` holds workerd sync state (`{epoch: string, rev: number}`). */
function hasWorkerdState(dir: string): boolean {
  let names: string[];
  try { names = readdirSync(join(dir, ".sync")); } catch { return false; }
  for (const n of names.filter((x) => x.endsWith(".json")).slice(0, 20)) {
    try {
      const j = JSON.parse(readFileSync(join(dir, ".sync", n), "utf8")) as { epoch?: unknown; rev?: unknown };
      if (typeof j.epoch === "string" && typeof j.rev === "number" && j.rev >= 0) return true;
    } catch { /* not workerd state */ }
  }
  return false;
}

/** The mirror dir that `target` lies under, or undefined (also undefined when WOLFPACK_KB_WRITER=1). */
export function findHubMirror(target: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.WOLFPACK_KB_WRITER === "1") return undefined;
  const real = realish(target);
  const configured = realish(workerdMirrorDir(env));
  if (within(real, configured)) return configured;
  let dir = real;
  for (;;) {
    if (hasWorkerdState(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Throws if `target` is under a hub KB mirror. */
export function assertNotHubMirror(target: string, env: NodeJS.ProcessEnv = process.env): void {
  const mirror = findHubMirror(target, env);
  if (mirror) {
    throw new Error(`refusing to write ${target}: it is under the read-only hub KB mirror ${mirror}. Write via the hub (Work API / hub registry) instead.`);
  }
}
