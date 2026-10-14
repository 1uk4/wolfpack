/**
 * wolfpack list — show all wolves grouped by host.
 */

import { allBackends } from "../backend/index.js";
import type { WolfSummary } from "../backend/types.js";
import { stampExtension } from "../bundle.js";
import { c } from "../render.js";

export async function wolfList(opts: { json?: boolean }): Promise<void> {
  const byHost = new Map<string, WolfSummary[]>();

  await Promise.all(
    allBackends().map(async (backend) => {
      try {
        const wolves = await backend.list();
        for (const w of wolves) {
          const group = byHost.get(w.host) ?? [];
          group.push(w);
          byHost.set(w.host, group);
        }
      } catch {
        if (backend.host !== "local") {
          byHost.set(backend.host, [{
            id: "",
            name: "(unreachable)",
            host: backend.host,
            runtime: "",
            status: "agent down",
          }]);
        }
      }
    }),
  );

  if (opts.json) {
    const all = [...byHost.values()].flat();
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    return;
  }

  if (byHost.size === 0) {
    console.log("No wolves found. Run `wolfpack add wolf <name>` to create one.");
    return;
  }

  const cols = process.stdout.columns || 80;
  let total = 0;

  for (const [host, wolves] of byHost) {
    const label = host === "local" ? "Local" : host;
    console.log(`\n  ${c.bold(label)}`);

    for (const w of wolves) {
      total++;
      const status = formatStatus(w.status);
      const rt = formatRuntime(w.runtime);
      const id = w.id ? c.dim(w.id) : "";
      const drift = await checkDrift(w);
      const driftTag = drift.length > 0 ? c.yellow(` [${drift.length} stale]`) : "";

      console.log(`    ${c.bold(w.name.padEnd(12))} ${rt.padEnd(8)} ${status}${driftTag}  ${id}`);

      // Row 2: domains (wrapped if needed)
      const domains = w.domains?.length ? w.domains : [];
      if (domains.length > 0) {
        const indent = "      ";
        const maxWidth = Math.max(40, cols - indent.length - 2);
        const lines = wrapDomains(domains, maxWidth);
        for (const line of lines) {
          console.log(`${indent}${c.dim(line)}`);
        }
      }
    }
  }

  console.log(c.dim(`\n  ${total} wolf(s)\n`));
}

function formatStatus(s: string): string {
  if (s === "active" || s === "live") return c.green(`● ${s}`);
  if (s === "agent down") return c.red(`○ ${s}`);
  return c.dim(`○ ${s}`);
}

function formatRuntime(rt: string): string {
  if (rt === "pi") return c.cyan("pi");
  if (rt === "pi-durable") return c.cyan("pi-dur");
  return rt || "";
}

function wrapDomains(domains: string[], maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const d of domains) {
    const sep = current ? ", " : "";
    if (current && (current + sep + d).length > maxWidth) {
      lines.push(current);
      current = d;
    } else {
      current += sep + d;
    }
  }

  if (current) lines.push(current);
  return lines;
}

async function checkDrift(w: WolfSummary): Promise<string[]> {
  if (!w.bundleHashes) return [];
  const stale: string[] = [];
  for (const [key, deployedHash] of Object.entries(w.bundleHashes)) {
    try {
      const local = await stampExtension(key);
      if (local && local.hash !== deployedHash) {
        stale.push(key);
      }
    } catch {
      // can't stamp — skip
    }
  }
  return stale;
}
