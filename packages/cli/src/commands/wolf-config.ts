/**
 * wolfpack config <wolf> --set key=value [--host <host>]
 */

import { AgentClient } from "../agent-client.js";
import { loadConfig, getHost } from "../config.js";
import { c } from "../render.js";

export async function wolfConfig(
  nameOrId: string,
  opts: { host?: string; set?: string[] },
): Promise<void> {
  const config = loadConfig();
  const host = getHost(config, opts.host);

  if (!host) {
    console.error(c.red("No host specified and no default host set."));
    process.exit(1);
  }

  if (!opts.set || opts.set.length === 0) {
    // Show current config
    const client = new AgentClient(host);
    try {
      const status = await client.wolfStatus(nameOrId);
      console.log(JSON.stringify(status, null, 2));
    } catch (err) {
      console.error(c.red(`Failed: ${err}`));
      process.exit(1);
    }
    return;
  }

  // Parse key=value pairs
  const updates: Record<string, unknown> = {};
  for (const kv of opts.set) {
    const eq = kv.indexOf("=");
    if (eq < 0) {
      console.error(c.red(`Invalid format: ${kv} (expected key=value)`));
      process.exit(1);
    }
    const key = kv.slice(0, eq);
    const val = kv.slice(eq + 1);

    // Handle arrays (comma-separated)
    if (key === "domains" || key === "extensions") {
      updates[key] = val.split(",").map((s) => s.trim());
    } else {
      updates[key] = val;
    }
  }

  const client = new AgentClient(host);

  try {
    console.log(`Updating ${nameOrId} config...`);
    const result = (await client.updateWolfConfig(nameOrId, updates)) as {
      wolf: Record<string, unknown>;
    };
    console.log(c.green(`✓ Config updated and wolf restarted`));
    console.log(c.dim(JSON.stringify(result.wolf, null, 2)));
  } catch (err) {
    console.error(c.red(`Failed: ${err}`));
    process.exit(1);
  }
}
