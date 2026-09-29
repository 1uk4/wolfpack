import { loadWolves } from "@wolfpack/core";
import { c, table } from "../render.ts";

export function listCommand(opts: { json?: boolean }): void {
  const wolves = loadWolves();

  if (opts.json) {
    process.stdout.write(JSON.stringify(wolves, null, 2) + "\n");
    return;
  }

  if (wolves.length === 0) {
    console.log("No wolves in inventory.");
    return;
  }

  const rows = wolves.map((w) => [
    c.bold(w.name),
    w.runtime === "pi" ? c.cyan("pi") : "claude",
    w.host ?? c.dim("—"),
    w.user,
    c.dim(w.group),
  ]);

  console.log(table(["NAME", "RUNTIME", "HOST", "USER", "GROUP"], rows));
  console.log(c.dim(`\n${wolves.length} wolf${wolves.length === 1 ? "" : "ves"}.`));
}
