#!/usr/bin/env bun
import { listCommand } from "./commands/list.ts";
import { statusCommand } from "./commands/status.ts";
import { c } from "./render.ts";

const HELP = `${c.bold("wolfpack")} — Mac-side control for the pack

${c.bold("Usage:")}
  wolfpack <command> [args] [--json]

${c.bold("Commands:")}
  list                 List every wolf in inventory (claude + pi)
  status [name]        Live health of one wolf, or all (ssh: service, tmux, uptime)
  help                 Show this help

${c.dim("Flags:")}
  --json               Machine-readable output

${c.dim("More commands (add, up, logs, restart, attach…) are coming.")}
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
