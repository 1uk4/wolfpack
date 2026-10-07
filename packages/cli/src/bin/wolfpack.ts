#!/usr/bin/env node
/**
 * wolfpack CLI — entry point.
 */

import { hostAdd } from "../commands/host-add.js";
import { hostList } from "../commands/host-list.js";
import { hostStatus } from "../commands/host-status.js";
import { hostSync } from "../commands/host-sync.js";
import { hostRedeploy } from "../commands/host-redeploy.js";
import { wolfAdd } from "../commands/wolf-add.js";
import { wolfList } from "../commands/wolf-list.js";
import { wolfStatus } from "../commands/wolf-status.js";
import { wolfLogs } from "../commands/wolf-logs.js";
import { wolfRestart } from "../commands/wolf-restart.js";
import { wolfConfig } from "../commands/wolf-config.js";
import { wolfLaunch } from "../commands/wolf-launch.js";
import { wolfSync } from "../commands/wolf-sync.js";
import { domainCmd } from "../commands/domain.js";
import { meshCmd } from "../commands/mesh.js";
import { setupCmd } from "../commands/setup.js";

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const HELP = `${c.bold("wolfpack")} — manage the pack

${c.bold("SETUP")}
  setup                           Establish the hub + librarian (required roles)

${c.bold("HOST")}
  host add <name> [--ip <ip>]     Interactive VPS setup + agent deploy
  host list                       Show registered hosts
  host status [name]              Host health + wolf overview
  host sync [name]                Wire Syncthing den mirrors (VPS → ~/wolves)
  host redeploy [name]            Re-provision + redeploy agent on an existing host

${c.bold("WOLVES")}
  add wolf <name> [--host <h>]    Create a PI wolf (local or remote, interactive)
  launch <wolf> [dir]             Run Pi as the wolf in a project dir (default: cwd)
  list [--json]                   Show all wolves across hosts
  status <wolf> [--host <h>]      Wolf service state
  logs <wolf> [-f] [--lines N]    Tail wolf logs
  restart <wolf> [--host <h>]     Restart wolf
  config <wolf> [--set key=val]   View/update wolf config (interactive if no --set)
  sync <wolf> [--host <h>]        Rebuild + push identity bundle (propagate exts)
  sync --all                      Sync every wolf on every host

${c.bold("DOMAINS")}
  domain list                     Declared domains + subscribers + entry counts
  domain add <name>               Declare a new domain (--label, --description)
  domain show <name>              Domain metadata + subscribers
  domain rm <name>                Remove a domain declaration (guarded)
  domain subscribe <wolf> <name>    Attach a domain to a wolf
  domain subscribe <name>           Pick wolves to (un)subscribe (existing domain)
  domain wolves <name>              Same picker \u2014 manage a domain's subscribers
  domain unsubscribe <wolf> <name>  Detach a domain from a wolf

${c.bold("MESH")}
  mesh                            Reconcile Syncthing fabric to match config
  mesh --check                    Report mesh drift (missing/stale) \u2014 no change

${c.bold("ADD WOLF FLAGS")}
  --domains a,b       Subscribe the new wolf to these domains (skip picker)
  --profile <p>       worker (local) | assistant (24/7 VPS, +telegram)
  --ext a,b           Attach these extensions (skip picker)
  --telegram-token <t>  Telegram bot token (assistant profile)
  --telegram-owner <id> Telegram owner user id
  -y, --yes           Non-interactive: accept profile defaults
  --model <m>         Model id

${c.bold("FLAGS")}
  --host <name>       Target host (default from config)
  --json              Machine-readable output
  -f, --follow        Stream logs in real-time
  --lines <n>         Number of log lines (default 100)
`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  // Collected --set key=value pairs (kept as a list so values may contain commas)
  const sets: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--all") {
      flags.all = true;
    } else if (arg === "--check") {
      flags.check = true;
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
    } else if (arg === "--model" && argv[i + 1]) {
      flags.model = argv[++i]!;
    } else if (arg === "--ext" && argv[i + 1]) {
      flags.ext = argv[++i]!;
    } else if (arg === "--profile" && argv[i + 1]) {
      flags.profile = argv[++i]!;
    } else if (arg === "--telegram-token" && argv[i + 1]) {
      flags.telegramToken = argv[++i]!;
    } else if (arg === "--telegram-owner" && argv[i + 1]) {
      flags.telegramOwner = argv[++i]!;
    } else if (arg === "-y" || arg === "--yes") {
      flags.yes = true;
    } else if (arg === "--role" && argv[i + 1]) {
      flags.role = argv[++i]!;
    } else if (arg === "--label" && argv[i + 1]) {
      flags.label = argv[++i]!;
    } else if (arg === "--description" && argv[i + 1]) {
      flags.description = argv[++i]!;
    } else if (arg === "--domains" && argv[i + 1]) {
      flags.domains = argv[++i]!;
    } else if (arg === "--set" && argv[i + 1]) {
      sets.push(argv[++i]!);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  return { positional, flags, sets };
}

async function main(): Promise<void> {
  const { positional, flags, sets } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const sub = positional[1];

  try {
    switch (cmd) {
      case "host":
        switch (sub) {
          case "add":
            if (!positional[2]) {
              console.error("Usage: wolfpack host add <name> [--ip <ip>]");
              process.exit(1);
            }
            await hostAdd(positional[2], {
              ip: flags.ip as string | undefined,
              port: flags.port ? parseInt(flags.port as string) : undefined,
            });
            break;
          case "list":
            hostList();
            break;
          case "status":
            await hostStatus(positional[2]);
            break;
          case "sync":
            await hostSync(positional[2]);
            break;
          case "redeploy":
            await hostRedeploy(positional[2]);
            break;
          default:
            console.error("Usage: wolfpack host <add|list|status|sync|redeploy>");
            process.exit(1);
        }
        break;

      case "setup":
        await setupCmd({ yes: flags.yes as boolean | undefined });
        break;

      case "mesh":
        await meshCmd({
          check: flags.check as boolean | undefined,
          yes: flags.yes as boolean | undefined,
        });
        break;

      case "domain":
        await domainCmd(positional.slice(1), {
          label: flags.label as string | undefined,
          description: flags.description as string | undefined,
          yes: flags.yes as boolean | undefined,
        });
        break;

      case "add":
        if (sub !== "wolf" || !positional[2]) {
          console.error("Usage: wolfpack add wolf <name> [--host <host>]");
          process.exit(1);
        }
        await wolfAdd(positional[2], {
          host: flags.host as string | undefined,
          model: flags.model as string | undefined,
          role: flags.role as string | undefined,
          profile: flags.profile as string | undefined,
          yes: flags.yes as boolean | undefined,
          telegramToken: flags.telegramToken as string | undefined,
          telegramOwner: flags.telegramOwner
            ? parseInt(flags.telegramOwner as string, 10)
            : undefined,
          extensions: flags.ext
            ? (flags.ext as string).split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
          domains: flags.domains
            ? (flags.domains as string).split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
        });
        break;

      case "launch":
        if (!positional[1]) {
          console.error("Usage: wolfpack launch <wolf> [project-dir]");
          process.exit(1);
        }
        await wolfLaunch(positional[1], {
          host: flags.host as string | undefined,
          dir: positional[2],
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

      case "sync":
        await wolfSync(positional[1], {
          host: flags.host as string | undefined,
          all: flags.all as boolean | undefined,
        });
        break;

      case "config":
        if (!positional[1]) {
          console.error("Usage: wolfpack config <wolf> --set key=value");
          process.exit(1);
        }
        await wolfConfig(positional[1], {
          host: flags.host as string | undefined,
          set: sets.length ? sets : undefined,
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
