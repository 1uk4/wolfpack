/**
 * wolfpack list — show all wolves (local + remote)
 */

import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { AgentClient } from "../agent-client.js";
import { loadConfig } from "../config.js";
import { c, table } from "../render.js";

export async function wolfList(opts: { json?: boolean }): Promise<void> {
  const config = loadConfig();

  type WolfRow = {
    name: string;
    id: string;
    host: string;
    runtime: string;
    status: string;
  };

  const rows: WolfRow[] = [];

  // Local wolves
  if (fs.existsSync(config.wolfsDir)) {
    const dirs = fs.readdirSync(config.wolfsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const yamlPath = path.join(config.wolfsDir, dir.name, "wolf.yaml");
      if (!fs.existsSync(yamlPath)) continue;

      try {
        const raw = fs.readFileSync(yamlPath, "utf8");
        const wolf = yamlParse(raw) as { id: string; name: string; runtime: string };
        rows.push({
          name: wolf.name,
          id: wolf.id,
          host: "local",
          runtime: wolf.runtime,
          status: c.dim("—"),
        });
      } catch {
        // Skip malformed configs
      }
    }
  }

  // Remote wolves from each host
  for (const [hostName, hostEntry] of Object.entries(config.hosts)) {
    try {
      const client = new AgentClient(hostEntry);
      const result = (await client.listWolves()) as {
        wolves: Array<{
          id: string;
          name: string;
          runtime: string;
          active: boolean;
          serviceState: string;
        }>;
      };
      for (const w of result.wolves) {
        rows.push({
          name: w.name,
          id: w.id,
          host: hostName,
          runtime: w.runtime,
          status: w.active ? c.green("🟢 active") : c.red("🔴 " + w.serviceState),
        });
      }
    } catch {
      rows.push({
        name: c.dim("(unreachable)"),
        id: "",
        host: hostName,
        runtime: "",
        status: c.red("🔴 agent down"),
      });
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }

  if (rows.length === 0) {
    console.log("No wolves found. Run `wolfpack add wolf <name>` to create one.");
    return;
  }

  const tableRows = rows.map((r) => [
    c.bold(r.name),
    c.dim(r.id),
    r.host,
    r.runtime === "pi" ? c.cyan("pi") : r.runtime,
    r.status,
  ]);

  console.log(table(["NAME", "ID", "HOST", "RUNTIME", "STATUS"], tableRows));
  console.log(c.dim(`\n${rows.length} wolf(s)`));
}
