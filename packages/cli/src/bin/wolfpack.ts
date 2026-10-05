#!/usr/bin/env node
/**
 * wolfpack CLI — entry point.
 */

import { hostAdd } from "../commands/host-add.js";
import { hostList } from "../commands/host-list.js";
import { hostStatus } from "../commands/host-status.js";
import { wolfAdd } from "../commands/wolf-add.js";
import { wolfList } from "../commands/wolf-list.js";
import { wolfStatus } from "../commands/wolf-status.js";
import { wolfLogs } from "../commands/wolf-logs.js";
import { wolfRestart } from "../commands/wolf-restart.js";
import { wolfConfig } from "../commands/wolf-config.js";

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const HELP = `${c.bold("wolfpack")} — manage the pack

${c.bold("HOST")}
  host add <name> --ip <ip>       Bootstrap a VPS and install agent
  host list                       Show registered hosts
  host status [name]              Host health + wolf overview

${c.bold("WOLVES")}
  add wolf <name> [--host <h>]    Create a wolf (local or remote)
  list [--json]                   Show all wolves across hosts
  status <wolf> [--host <h>]      Wolf service state
  logs <wolf> [-f] [--lines N]    Tail wolf logs
  restart <wolf> [--host <h>]     Restart wolf
  config <wolf> --set key=value   Update wolf config

${c.bold("FLAGS")}
  --host <name>       Target host (default from config)
  --json              Machine-readable output
  -f, --follow        Stream logs in real-time
  --lines <n>         Number of log lines (default 100)
`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "-f" || arg === "--follow") {
      flags.follow = true;
    } else if (arg === "--host" && argv[i + 1]) {
      flags.host = argv[++i]!;
    } else if (arg === "--ip" && argv[i + 1]) {
      flags.ip = argv[++i]!;
    } else if (arg === "--port" && argv[i + 1]) {
      flags.port = argv[++i]!;
    } else if (arg === "--lines" && argv[i + 1]) {
      flags.lines = argv[++i]!;
    } else if (arg === "--runtime" && argv[i + 1]) {
      flags.runtime = argv[++i]!;
    } else if (arg === "--model" && argv[i + 1]) {
      flags.model = argv[++i]!;
    } else if (arg === "--role" && argv[i + 1]) {
      flags.role = argv[++i]!;
    } else if (arg === "--set") {
      // Collect all --set values
      if (!flags._sets) flags._sets = "";
      if (argv[i + 1]) flags._sets += (flags._sets ? "," : "") + argv[++i]!;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const sub = positional[1];

  try {
    switch (cmd) {
      case "host":
        switch (sub) {
          case "add":
            if (!positional[2] || !flags.ip) {
              console.error("Usage: wolfpack host add <name> --ip <ip>");
              process.exit(1);
            }
            await hostAdd(positional[2], {
              ip: flags.ip as string,
              port: flags.port ? parseInt(flags.port as string) : undefined,
            });
            break;
          case "list":
            hostList();
            break;
          case "status":
            await hostStatus(positional[2]);
            break;
          default:
            console.error("Usage: wolfpack host <add|list|status>");
            process.exit(1);
        }
        break;

      case "add":
        if (sub !== "wolf" || !positional[2]) {
          console.error("Usage: wolfpack add wolf <name> [--host <host>]");
          process.exit(1);
        }
        await wolfAdd(positional[2], {
          host: flags.host as string | undefined,
          runtime: flags.runtime as string | undefined,
          model: flags.model as string | undefined,
          role: flags.role as string | undefined,
        });
        break;

      case "list":
        await wolfList({ json: flags.json as boolean | undefined });
        break;

      case "status":
        if (!positional[1]) {
          console.error("Usage: wolfpack status <wolf> [--host <host>]");
          process.exit(1);
        }
        await wolfStatus(positional[1], {
          host: flags.host as string | undefined,
        });
        break;

      case "logs":
        if (!positional[1]) {
          console.error("Usage: wolfpack logs <wolf> [-f] [--lines N]");
          process.exit(1);
        }
        await wolfLogs(positional[1], {
          host: flags.host as string | undefined,
          follow: flags.follow as boolean | undefined,
          lines: flags.lines ? parseInt(flags.lines as string) : undefined,
        });
        break;

      case "restart":
        if (!positional[1]) {
          console.error("Usage: wolfpack restart <wolf> [--host <host>]");
          process.exit(1);
        }
        await wolfRestart(positional[1], {
          host: flags.host as string | undefined,
        });
        break;

      case "config":
        if (!positional[1]) {
          console.error("Usage: wolfpack config <wolf> --set key=value");
          process.exit(1);
        }
        await wolfConfig(positional[1], {
          host: flags.host as string | undefined,
          set: flags._sets ? (flags._sets as string).split(",") : undefined,
        });
        break;

      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        break;

      default:
        console.error(c.red(`Unknown command: ${cmd}`));
        process.stdout.write(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(c.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

main();
