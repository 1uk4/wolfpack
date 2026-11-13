/**
 * One place that says where a pack's runtime state lives and which ports its services use (work-wolfpack-EVlo8t8).
 * Defaults are the owner's dev-stack values; a bundled app sets the env vars below once and every service follows.
 *
 *   WOLFPACK_HOME          pack state dir (config.yaml, .env, workerd/ hub link + kb-mirror)   default ~/.wolfpack
 *   WORKERD_CONFIG_DIR     workerd's own dir                                                   default <home>/workerd
 *   WOLFPACK_WOLVES_ROOT   wolves root (holds local/, librarian/, ...)                         default ~/wolves
 *   WOLFPACK_WOLVES_DIR    the folder that holds the wolf folders (<wolf>/wolf.yaml)           default <wolves root>/local
 *   WOLFPACK_KB_OPS        librarian-ops root (inbox, receipts, contributions)                 default <wolves root>/librarian
 *                          (no implicit move with WOLFPACK_HOME: the bundled app sets this one explicitly)
 *   WOLFPACK_WORKERD_PORT  workerd port (WORKERD_PORT is NOT read here, see workerdPort)       default 7141
 *   WOLFPACK_HUBD_PORT     hubd port                                                           default 3142 (listen) / 3150 (what the console probes)
 * Empty or whitespace-only values count as unset. A non-numeric port throws.
 */
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;
const val = (v: string | undefined): string | undefined => v?.trim() || undefined;
const homeOf = (env: Env): string => val(env.HOME) ?? homedir();

export const DEFAULT_WORKERD_PORT = 7141;
export const DEFAULT_HUBD_PORT = 3142;
export const DEFAULT_CONSOLE_PORT = 3200;
/** The deployed console's loopback origin; workerd probes it to report the machine's console (WOLFPACK_CONSOLE_URL overrides). */
export const DEFAULT_CONSOLE_URL = `http://127.0.0.1:${DEFAULT_CONSOLE_PORT}`;

/** Pack state dir. */
export const packStateDir = (env: Env = process.env): string => val(env.WOLFPACK_HOME) ?? join(homeOf(env), ".wolfpack");
/** workerd's config dir (hub.json, direct-token, kb-mirror/). */
export const workerdConfigDir = (env: Env = process.env): string => val(env.WORKERD_CONFIG_DIR) ?? join(packStateDir(env), "workerd");
/** Wolves root (dev stack: holds local/, librarian/, knowledge/). */
export const wolvesRoot = (env: Env = process.env): string => val(env.WOLFPACK_WOLVES_ROOT) ?? join(homeOf(env), "wolves");
/** The folder holding the `<wolf>/wolf.yaml` dirs that workerd supervises. */
export const wolvesDir = (env: Env = process.env): string => val(env.WOLFPACK_WOLVES_DIR) ?? join(wolvesRoot(env), "local");
/** Librarian-ops root: WOLFPACK_KB_OPS, else `<wolves root>/librarian`. Callers with an older rule (env KB_OPS, an explicit wolves dir) apply it first. */
export const kbOpsDir = (env: Env = process.env): string => val(env.WOLFPACK_KB_OPS) ?? join(wolvesRoot(env), "librarian");
/** Host-wide run dir (wolf sockets, subagent slots). */
export const runDir = (env: Env = process.env): string => join(packStateDir(env), "run");

function port(name: string, raw: string | undefined, fallback: number): number {
  const v = val(raw);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, got "${v}"`);
  return n;
}
/** WOLFPACK_WORKERD_PORT, else 7141. WORKERD_PORT is deliberately not read: it is only the link-only workerd's own variable (workerd cli-args). */
export const workerdPort = (env: Env = process.env): number => port("WOLFPACK_WORKERD_PORT", env.WOLFPACK_WORKERD_PORT, DEFAULT_WORKERD_PORT);
export const hubdPort = (env: Env = process.env, fallback = DEFAULT_HUBD_PORT): number => port("WOLFPACK_HUBD_PORT", env.WOLFPACK_HUBD_PORT, fallback);
