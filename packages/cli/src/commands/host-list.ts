/**
 * wolfpack host list — show registered hosts
 */

import { loadConfig } from "../config.js";
import { c, table } from "../render.js";

export function hostList(): void {
  const config = loadConfig();
  const entries = Object.entries(config.hosts);

  if (entries.length === 0) {
    console.log("No hosts registered. Run `wolfpack host add <name> --ip <ip>` to add one.");
    return;
  }

  const rows = entries.map(([name, host]) => {
    const isDefault = name === config.defaultHost;
    const label = isDefault ? `${c.bold(name)} ${c.cyan("(default)")}` : name;
    return [label, host.address, String(host.port)];
  });

  console.log(table(["HOST", "ADDRESS", "PORT"], rows));
}
