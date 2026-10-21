/**
 * On-host path layout for the agent — the single place that knows where a
 * wolf's home and the shared KB live on a VPS. Everything is overridable via
 * env; the defaults are the standard layout.
 *
 *   WOLFPACK_KB_ROOT     shared KB root                  (default /var/wolfpack/kb)
 *   KB_BASE              KB base                         (default <kbRoot>/base)
 *   KB_OPS               librarian ops lanes             (default <kbRoot>/ops)
 *   WORK_LEDGER_DIR      work ledger                     (default <kbRoot>/work)
 *   WOLFPACK_HOME_ROOT   parent of per-wolf homes        (default /home)
 *   WOLFPACK_USER_PREFIX per-wolf unix user prefix       (default wolf-)
 */
import path from "node:path";

type Env = NodeJS.ProcessEnv;

export const kbRoot = (env: Env = process.env) => env.WOLFPACK_KB_ROOT || "/var/wolfpack/kb";
export const kbBase = (env: Env = process.env) => env.KB_BASE || path.join(kbRoot(env), "base");
export const kbOps = (env: Env = process.env) => env.KB_OPS || path.join(kbRoot(env), "ops");
export const workLedgerDir = (env: Env = process.env) =>
  env.WORK_LEDGER_DIR || path.join(kbRoot(env), "work");

export const wolfUser = (id: string, env: Env = process.env) =>
  `${env.WOLFPACK_USER_PREFIX || "wolf-"}${id}`;
export const wolfHome = (id: string, env: Env = process.env) =>
  path.join(env.WOLFPACK_HOME_ROOT || "/home", wolfUser(id, env));
export const wolfDen = (id: string, env: Env = process.env) => path.join(wolfHome(id, env), "den");
