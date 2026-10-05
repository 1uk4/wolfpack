/**
 * wolfpack host list — show registered hosts
 */

import { loadConfig, LOCAL_HOST } from "../config.js";
import { c, table } from "../render.js";

export function hostList(): void {
  const config = loadConfig();
  const entries = Object.entries(config.hosts);

  // `local` (this machine) is always a host \u2014 it's where wolves without
  // --host run. Registered VPS hosts follow.
  const rows: string[][] = [
    [`${c.bold(LOCAL_HOST)} ${c.dim("(this machine)")}`, c.dim("\u2014"), c.dim("\u2014"), "pi / terminal"],
  ];

  for (const [name, host] of entries) {
    const isDefault = name === config.defaultHost;
    const label = isDefault ? `${c.bold(name)} ${c.cyan("(default)")}` : name;
    rows.push([label, host.address, String(host.port), "agent"]);
  }

  console.log(table(["HOST", "ADDRESS", "PORT", "VIA"], rows));

  if (entries.length === 0) {
    console.log(
      c.dim("\nNo VPS hosts yet. Add one: wolfpack host add <name> --ip <ip>"),
    );
  }
}
