/**
 * wolfpack logs <wolf> [--follow] [--lines N] [--host <host>]
 */

import { AgentClient } from "../agent-client.js";
import { loadConfig, getHost } from "../config.js";
import { c } from "../render.js";

export async function wolfLogs(
  nameOrId: string,
  opts: { host?: string; follow?: boolean; lines?: number },
): Promise<void> {
  const config = loadConfig();
  const host = getHost(config, opts.host);

  if (!host) {
    console.error(c.red("No host specified and no default host set."));
    process.exit(1);
  }

  const client = new AgentClient(host);
  const lines = opts.lines ?? 100;

  try {
    if (opts.follow) {
      console.log(c.dim(`Streaming logs for ${nameOrId}... (Ctrl-C to stop)`));
      await client.streamLogs(nameOrId, (line) => {
        console.log(line);
      }, lines);
    } else {
      const result = (await client.logs(nameOrId, lines)) as {
        wolf: string;
        lines: string[];
      };
      for (const line of result.lines) {
        if (line) console.log(line);
      }
    }
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}
