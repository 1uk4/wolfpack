/**
 * wolfpack list — show all wolves across every backend (local + each host).
 */

import { allBackends } from "../backend/index.js";
import { c, table } from "../render.js";

export async function wolfList(opts: { json?: boolean }): Promise<void> {
  type Row = {
    name: string;
    id: string;
    host: string;
    runtime: string;
    status: string;
  };

  const rows: Row[] = [];

  await Promise.all(
    allBackends().map(async (backend) => {
      try {
        const wolves = await backend.list();
        for (const w of wolves) {
          rows.push({
            name: w.name,
            id: w.id,
            host: w.host,
            runtime: w.runtime,
            status: w.status,
          });
        }
      } catch {
        // Local backend never throws here; a remote host may be unreachable.
        if (backend.host !== "local") {
          rows.push({
            name: c.dim("(unreachable)"),
            id: "",
            host: backend.host,
            runtime: "",
            status: c.red("agent down"),
          });
        }
      }
    }),
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }

  if (rows.length === 0) {
    console.log("No wolves found. Run `wolfpack add wolf <name>` to create one.");
    return;
  }

  const statusColor = (s: string) =>
    s === "active" || s === "live"
      ? c.green(`🟢 ${s}`)
      : s === "—"
        ? c.dim(s)
        : c.red(`🔴 ${s}`);

  const tableRows = rows.map((r) => [
    c.bold(r.name),
    c.dim(r.id),
    r.host,
    r.runtime === "pi" ? c.cyan("pi") : r.runtime,
    statusColor(r.status),
  ]);

  console.log(table(["NAME", "ID", "HOST", "RUNTIME", "STATUS"], tableRows));
  console.log(c.dim(`\n${rows.length} wolf(s)`));
}
