import os from "node:os";
import path from "node:path";

/** Where the live wolves live (STACK_WOLVES overrides, for tests/rehearsals). Shared by stack.mjs and dev-stack.mjs. */
export const liveWolvesDir = (env = process.env, home = os.homedir()) => env.STACK_WOLVES || path.join(home, "wolves/local");

/** Pack config dir (secrets in .env): $WOLFPACK_HOME, default ~/.wolfpack. */
export const packHome = (env = process.env, home = os.homedir()) => env.WOLFPACK_HOME || path.join(home, ".wolfpack");
