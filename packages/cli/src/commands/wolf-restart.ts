/**
 * wolfpack restart <wolf> [--host <host>]
 */

import { AgentClient } from "../agent-client.js";
import { loadConfig, getHost } from "../config.js";
import { c } from "../render.js";

export async function wolfRestart(
  nameOrId: string,
  opts: { host?: string },
): Promise<void> {
  const config = loadConfig();
  const host = getHost(config, opts.host);

  if (!host) {
    console.error(c.red("No host specified and no default host set."));
    process.exit(1);
  }

  const client = new AgentClient(host);

  try {
    console.log(`Restarting ${nameOrId}...`);
    const result = (await client.restartWolf(nameOrId)) as { restarted: string };
    console.log(c.green(`✓ ${result.restarted} restarted`));
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}
