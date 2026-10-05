/**
 * wolfpack host redeploy [name]
 *
 * Re-provision an already-registered host: re-runs prerequisites (idempotent)
 * and redeploys the agent, picking up deployer changes (e.g. the Syncthing
 * service + baked API key). Regenerates the agent API key and updates config.
 *
 * Unlike `host add`, this operates on an existing host and keeps its SSH config.
 */

import { loadConfig, saveConfig, getHost } from "../config.js";
import { c } from "../render.js";
import { deployAgent } from "../deployer.js";

export async function hostRedeploy(name?: string): Promise<void> {
  const config = loadConfig();
  const hostName = name ?? config.defaultHost;
  const host = hostName ? getHost(config, hostName) : undefined;

  if (!hostName || !host) {
    console.error(c.red("No host specified and no default host set."));
    console.error(c.dim("Usage: wolfpack host redeploy <name>"));
    process.exit(1);
  }

  console.log(c.bold(`\n🔁 Redeploying ${hostName} (${host.ssh.user}@${host.address})`));

  try {
    await deployAgent(hostName, host); // mutates host.apiKey
  } catch (err) {
    console.error(c.red(`\n✗ Redeploy failed:`));
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  config.hosts[hostName] = host;
  saveConfig(config);

  console.log(c.green(`\n✓ ${hostName} redeployed`));
  console.log(c.dim("  Agent API key rotated; config updated."));
  console.log();
  console.log(c.bold("Next:"));
  console.log(`  ${c.cyan(`wolfpack host status ${hostName}`)}   Verify Syncthing now reports folders`);
  console.log(`  ${c.cyan(`wolfpack host sync ${hostName}`)}     Re-apply den mirrors (reconcile)`);
}
