#!/usr/bin/env bun
import { listCommand } from "./commands/list.ts";
import { logsCommand } from "./commands/logs.ts";
import { restartCommand } from "./commands/restart.ts";
import { runtimeCommand } from "./commands/runtime.ts";
import { statusCommand } from "./commands/status.ts";
import { c } from "./render.ts";

const HELP = `${c.bold("wolfpack")} — Mac-side control for the pack

${c.bold("Usage:")}
  wolfpack <command> [args] [--json]

${c.bold("MONITOR")}
  status [wolf]            live service + tmux state (one wolf, or all)
  list                     wolves in inventory with runtime
  ${c.dim("health          (coming — needs wolf-health probe deployed on hosts)")}

${c.bold("INSPECT")}
  logs <wolf> [lines]      tail journald logs for a wolf (default 50, max 1000)
  ${c.dim("attach <wolf>   (coming — SSH -t to the live tmux session)")}
  ${c.dim("den <wolf>      (coming — print the den path)")}

${c.bold("CONTROL")}
  restart <wolf> [confirm] 2-step restart; asks the wolf to checkpoint first
  runtime [wolf] [target]  show all wolves' runtimes, one wolf's runtime, or
                           switch to <target> (pi|claude) via redeploy.yml
  ${c.dim("add <name>      (coming — wizard to build a new wolf)")}
  ${c.dim("sync            (coming — wire a den/kb to Mac Syncthing)")}
  ${c.dim("rename          (coming — rename a wolf everywhere)")}

${c.bold("Flags:")}
  --json                   machine-readable output (where supported)

${c.dim("On the wolf host itself, /usr/local/bin/wolfpack exposes the full")}
${c.dim("command surface including the interactive ones (attach, add, launch).")}
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("-"));
  const cmd = positional[0];

  switch (cmd) {
    case "list":
      listCommand({ json });
      break;
    case "status":
      await statusCommand(positional[1], { json });
      break;
    case "logs":
      await logsCommand(positional[1], positional[2]);
      break;
    case "restart":
      await restartCommand(positional[1], positional[2]);
      break;
    case "runtime":
      await runtimeCommand({ name: positional[1], target: positional[2], json });
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
