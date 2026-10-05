/**
 * wolfpack logs <wolf> [--follow] [--lines N] [--host <host>]
 *
 * Works for local (tail log files) and remote (agent) wolves via WolfBackend.
 */

import { resolveBackend } from "../backend/index.js";
import { c } from "../render.js";

export async function wolfLogs(
  nameOrId: string,
  opts: { host?: string; follow?: boolean; lines?: number },
): Promise<void> {
  const lines = opts.lines ?? 100;

  try {
    const backend = resolveBackend(opts.host);

    if (opts.follow && backend.follow) {
      console.log(c.dim(`Streaming logs for ${nameOrId}... (Ctrl-C to stop)`));
      await backend.follow(nameOrId, (line) => console.log(line), lines);
      return;
    }

    if (opts.follow && !backend.follow) {
      console.log(c.dim(`(follow not supported for ${backend.host}; showing last ${lines})`));
    }

    const out = await backend.logs(nameOrId, { lines });
    for (const line of out) {
      if (line) console.log(line);
    }
  } catch (err) {
    console.error(c.red(`Failed: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}
