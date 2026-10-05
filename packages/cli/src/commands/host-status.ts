/**
 * wolfpack host status <name> — health of a host via agent API
 */

import { AgentClient } from "../agent-client.js";
import { loadConfig, getHost } from "../config.js";
import { c } from "../render.js";

export async function hostStatus(name?: string): Promise<void> {
  const config = loadConfig();
  const hostName = name ?? config.defaultHost;

  if (!hostName) {
    console.error("No host specified and no default host set.");
    process.exit(1);
  }

  const host = getHost(config, hostName);
  if (!host) {
    console.error(c.red(`Host '${hostName}' not found.`));
    process.exit(1);
  }

  const client = new AgentClient(host);

  try {
    const ping = await client.ping();
    console.log(c.green(`✓ ${hostName} — agent v${ping.version}`));

    const health = (await client.health()) as Record<string, unknown>;
    console.log();
    console.log(`  Hostname: ${health.hostname}`);
    console.log(`  Uptime:   ${health.uptime}`);

    const mem = health.memory as Record<string, number>;
    const disk = health.disk as Record<string, unknown>;
    console.log(`  Memory:   ${mem.percent}%`);
    console.log(`  Disk:     ${disk.percent}%`);

    const wolves = (health.wolves as Array<Record<string, unknown>>) ?? [];
    console.log(`  Wolves:   ${wolves.length}`);

    for (const w of wolves) {
      const marker = w.active ? c.green("🟢") : c.red("🔴");
      console.log(`    ${marker} ${w.name} (${w.id}) — ${w.serviceState}`);
    }
  } catch (err) {
    console.error(c.red(`Failed to reach agent on ${hostName}: ${err}`));
    process.exit(1);
  }
}
