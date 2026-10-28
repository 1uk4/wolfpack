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
import { wolfModels } from "../commands/wolf-models.js";
import { usageCmd } from "../commands/usage.js";
import { workDoctor } from "../commands/work-doctor.js";
import { workBackfillFeatureStages } from "../commands/work-backfill.js";
import { wolfLaunch } from "../commands/wolf-launch.js";
import { wolfSync } from "../commands/wolf-sync.js";
import { domainCmd } from "../commands/domain.js";
import { meshCmd } from "../commands/mesh.js";
import { kbCmd } from "../commands/kb.js";
import { sandboxCmd } from "../commands/sandbox.js";
import { setupCmd } from "../commands/setup.js";

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

const HELP = `${c.bold("wolfpack")} — wolf management CLI

${c.bold("COMMANDS")}
  setup                           First-time setup (hub + librarian + pack models)
  add wolf <name>                 Create a new wolf (interactive wizard)
  add domain <name>               Declare a new knowledge domain
  launch <wolf> [dir] [--session <id>]  Run a wolf locally (resume a pi session)
  sync <wolf>                     Deploy wolf to host (bundle + mesh)
  list                            Show all wolves grouped by host
  status <wolf>                   Wolf health and service state
  logs <wolf>                     View wolf logs
  models [wolf]                   Resolved model per use (tier, model, thinking, source)
  usage [wolf]                    Model calls, tokens and cost (--since 7d, --by wolf|model|use|day)
  work backfill-feature-stages    Move features whose tasks all shipped to shipped (--dry-run, --domain d)
  work doctor                     Read-only work-item hygiene check (--domain d, --json)
  config [wolf]                   Configure wolf (domains, extensions, models); no wolf = pack models

${c.bold("FLAGS")}
  --host <name>       Target host (default from config)
  --json              Machine-readable output
  -f, --follow        Stream logs in real-time
  --lines <n>         Number of log lines (default 100)
  -y, --yes           Non-interactive: accept defaults

  ${c.dim("Run wolfpack --help-all for the full command reference.")}
`;

const HELP_ALL = `${c.bold("wolfpack")} — full command reference

${c.bold("WORKFLOW COMMANDS")}
  setup                           First-time setup (hub + librarian + pack models)
  add wolf <name>                 Create a new wolf (interactive wizard)
  add domain <name>               Declare a new knowledge domain
  launch <wolf> [dir] [--session <id>]  Run a wolf locally (resume a pi session)
  sync <wolf> [--host <h>]        Deploy wolf to host (bundle + mesh)
  sync --all                      Sync every wolf on every host
  list [--json]                   Show all wolves grouped by host
  status <wolf> [--host <h>]      Wolf health and service state
  logs <wolf> [-f] [--lines N]    View wolf logs
  models [wolf] [--host <h>] [--json]
                                  Resolved model table per wolf (all wolves if none)
  usage [wolf] [--since 7d|30d|24h|YYYY-MM-DD|all] [--by wolf|model|billing|source|use|day] [--json] [--no-ingest]
                                  Model calls, tokens and cost for all wolves (ingests, then reads the ledger)
                                  --by use: main / subagent[:<agent>] / step:<step>; the ledger keeps old
                                  events as ingested, so only new ones carry the agent name
  usage context [--since 7d] [--json]
                                  Which tools' output lands in the main agent's context (live sessions)
  usage ingest                    Append new calls from local logs to ~/.wolfpack/usage
  usage install-schedule          Hourly ingest via launchd (uninstall-schedule removes it)
  config <wolf> [--set key=val]   Configure wolf (interactive or scripted)
                                    models: --set transport=api --set models.fast.model=<id>
  config [--set models.<k>=val]   Pack models: tiers, thinking, local/VPS transports

${c.bold("HOST (advanced)")}
  host add <name> [--ip <ip>]     Interactive VPS setup + agent deploy
  host list                       Show registered hosts
  host status [name]              Host health + wolf overview
  host sync [name]                Wire Syncthing den mirrors (VPS \u2192 ~/wolves)
  host redeploy [name] [--rotate-key]  Re-provision + redeploy (preserves API key by default)

${c.bold("DOMAIN (advanced)")}
  domain list                     Declared domains + subscribers + entry counts
  domain add <name>               Declare a new domain (--label, --description)
  domain show <name>              Domain metadata + subscribers
  domain rm <name>                Remove a domain declaration (guarded)
  domain subscribe <wolf> <name>  Attach a domain to a wolf
  domain unsubscribe <wolf> <name>  Detach a domain from a wolf
  domain wolves <name>            Manage a domain's subscribers (picker)

${c.bold("SANDBOX (advanced)")}
  sandbox snapshot <wolf> --dev-root <dir> (--from <dir> | --host <h> --wolf-id <id> --yes) [--force] [--include-sessions] [--no-install-extensions]
  sandbox install-extensions <dev-root> [--extensions k1,k2]   (rebuild current bundles into the dev den)
                                  Copy a host's work ledger, KB lanes and the wolf's den into a dev root;
                                  run the wolf against it with \`sandbox: true\` in wolf.yaml

${c.bold("MESH (advanced)")}
  mesh                            Reconcile Syncthing fabric to match config
  mesh --check                    Report mesh drift without changes

${c.bold("OTHER")}
  restart <wolf> [--host <h>]     Restart wolf service

${c.bold("ADD WOLF FLAGS")}
  --host <h>          Target host (or pick during wizard)
  --runtime <r>       pi (default) | pi-durable
  --domains a,b       Subscribe to these domains (skip picker)
  --profile <p>       worker (local) | assistant (24/7 VPS, +telegram)
  --ext a,b           Attach these extensions (skip picker)
  --telegram-token <t>  Telegram bot token (assistant profile)
  --telegram-owner <id> Telegram owner user id
  -y, --yes           Non-interactive: accept defaults

${c.bold("GLOBAL FLAGS")}
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
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help-all") {
      flags.helpAll = true;
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
    } else if (arg === "--session" && argv[i + 1]) {
      flags.session = argv[++i]!;
    } else if (arg === "--domain" && argv[i + 1]) {
      flags.domain = argv[++i]!;
    } else if (arg === "--since" && argv[i + 1]) {
      flags.since = argv[++i]!;
    } else if (arg === "--by" && argv[i + 1]) {
      flags.by = argv[++i]!;
    } else if (arg === "--no-ingest") {
      flags.noIngest = true;
    } else if (arg === "--set" && argv[i + 1]) {
      sets.push(argv[++i]!);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      // Not a flag this CLI knows. Pass-through commands (kb) forward these to
      // the remote tool; dropping them silently once turned `kb reorg --dry-run`
      // into a real reorg.
      passthrough.push(arg);
    }
  }

  return { positional, flags, sets, passthrough };
}

async function main(): Promise<void> {
  const { positional, flags, sets, passthrough } = parseArgs(process.argv.slice(2));
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
            await hostRedeploy(positional[2], {
              rotateKey: Boolean(flags["rotate-key"]) || Boolean(flags.rotateKey),
            });
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

      case "sandbox":
        await sandboxCmd(process.argv.slice(3));
        break;

      case "kb":
        await kbCmd([...positional.slice(1), ...passthrough]);
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
          console.error("Usage: wolfpack launch <wolf> [project-dir] [--session <id>]");
          process.exit(1);
        }
        await wolfLaunch(positional[1], {
          host: flags.host as string | undefined,
          dir: positional[2],
          session: flags.session as string | undefined,
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

      case "models":
        await wolfModels(positional[1], {
          host: flags.host as string | undefined,
          json: flags.json as boolean | undefined,
        });
        break;

      case "usage":
        await usageCmd(positional[1], {
          since: flags.since as string | undefined,
          by: flags.by as string | undefined,
          json: flags.json as boolean | undefined,
          noIngest: flags.noIngest as boolean | undefined,
        });
        break;

      case "work":
        if (sub === "backfill-feature-stages") {
          await workBackfillFeatureStages({ dryRun: passthrough.includes("--dry-run"), domain: flags.domain as string | undefined });
          break;
        }
        if (sub !== "doctor") throw new Error("Usage: wolfpack work doctor [--domain d] [--json] | work backfill-feature-stages [--dry-run]");
        await workDoctor({ domain: flags.domain as string | undefined, json: flags.json as boolean | undefined });
        break;

      case "config":
        await wolfConfig(positional[1], {
          host: flags.host as string | undefined,
          set: sets.length ? sets : undefined,
        });
        break;

      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(flags.helpAll ? HELP_ALL : HELP);
        break;

      case "--help-all":
        process.stdout.write(HELP_ALL);
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
