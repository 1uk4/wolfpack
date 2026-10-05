/**
 * wolfpack status <wolf> [--host <host>]
 */

import { AgentClient } from "../agent-client.js";
import { loadConfig, getHost } from "../config.js";
import { c } from "../render.js";

export async function wolfStatus(
  nameOrId: string,
  opts: { host?: string },
): Promise<void> {
  const config = loadConfig();
  const host = getHost(config, opts.host);

  if (!host) {
    console.error(
      c.red("No host specified and no default host set. Use --host <name>."),
    );
    process.exit(1);
  }

  const client = new AgentClient(host);

  try {
    const status = (await client.wolfStatus(nameOrId)) as Record<string, unknown>;
    const active = status.active as boolean;
    const marker = active ? c.green("🟢") : c.red("🔴");

    console.log(`${marker} ${c.bold(status.name as string)} (${status.id})`);
    console.log(`  Runtime:  ${status.runtime}`);
    console.log(`  Service:  ${status.serviceState}`);
    console.log(`  Tmux:     ${status.tmux ? c.green("✓") : c.red("✗")}`);
    if (status.since) console.log(`  Since:    ${status.since}`);
    if (status.error) console.log(`  Error:    ${c.red(status.error as string)}`);
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}
