/**
 * wolfpack kb <command> [domain] — proxy KB CLI commands to the librarian's host.
 *
 *   kb status           KB health dashboard
 *   kb reorg <domain>   Reorg sections (incremental)
 *   kb rebuild <domain> Full section tree rebuild (agglomerative clustering)
 *   kb sweep <domain>   Run sweep
 */

import { loadConfig, getHost } from "../config.js";
import { c } from "../render.js";
import { spawn } from "node:child_process";
import { remotePaths } from "../paths.js";
import { sshKeyArgs } from "../ssh-helper.js";

export async function kbCmd(argv: string[]): Promise<void> {
  const config = loadConfig();
  const lib = config.librarian;
  if (!lib) {
    console.error(c.red("No librarian configured. Run wolfpack setup."));
    process.exit(1);
  }

  const host = getHost(config, lib.host);
  if (!host) {
    console.error(c.red(`Librarian host '${lib.host}' not found.`));
    process.exit(1);
  }

  const cmd = argv[0];
  const domain = argv[1];
  // Any remaining args (--dry-run, --resummarize-all, etc.) pass through to
  // the remote CLI so flags actually reach the KB engine.
  const extraFlags = argv.slice(2).join(" ");

  const rp = remotePaths();
  const libId = lib.id ?? "";
  const envSetup = [
    // Start in the wolf's home: sudo keeps root's cwd (/root), which the wolf
    // user can't enter, and the Agent SDK then fails to spawn Claude Code
    // (reported as a misleading "binary failed to launch / libc" error).
    `cd ${rp.home(libId)}`,
    `export KB_BASE=${rp.sharedKbBase}`,
    `export KB_OPS=${rp.sharedKbOps}`,
    `export WOLF_DEN=${rp.den(libId)}`,
    // Usage events from manual runs are attributed to the librarian by name.
    `export WOLF_NAME=$(grep ^WOLF_NAME= ${rp.home(libId)}/.env | cut -d= -f2-)`,
    `export ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY= ${rp.home(libId)}/.env | cut -d= -f2-)`,
    // Max transport: the Agent SDK authenticates with this token.
    `export CLAUDE_CODE_OAUTH_TOKEN=$(grep ^CLAUDE_CODE_OAUTH_TOKEN= ${rp.home(libId)}/.env | cut -d= -f2-)`,
  ].join(" && ");

  const kbCli = "/opt/wolfpack-kb/cli.cjs";

  let remoteCmd: string;
  switch (cmd) {
    case "status":
      remoteCmd = `${envSetup} && node ${kbCli} status`;
      break;
    case "reorg":
      if (!domain) { console.error("Usage: wolfpack kb reorg <domain> [--dry-run] [--resummarize-all]"); process.exit(1); }
      remoteCmd = `${envSetup} && node ${kbCli} reorg ${domain} ${extraFlags}`.trim();
      break;
    case "rebuild":
      if (!domain) { console.error("Usage: wolfpack kb rebuild <domain>"); process.exit(1); }
      remoteCmd = `${envSetup} && node ${kbCli} rebuild ${domain} ${extraFlags}`.trim();
      break;
    case "sweep":
      if (!domain) { console.error("Usage: wolfpack kb sweep <domain>"); process.exit(1); }
      remoteCmd = `${envSetup} && node ${kbCli} sweep ${domain} ${extraFlags}`.trim();
      break;
    default:
      console.error("Usage: wolfpack kb <status|reorg|rebuild|sweep> [domain]");
      process.exit(1);
  }

  console.log(c.dim(`Running on ${lib.host}...`));

  // Run as the librarian wolf's own user, not the SSH user (root): the KB
  // engine writes into the wolf's den (lock, sections, ledger) and its
  // knowledge folder, and root-owned files there block the wolf's own sweep.
  const asWolf = `sudo -u wolf-${lib.id} bash -c '${remoteCmd.replace(/'/g, `'\\''`)}'`;
  const sshKey = host.ssh?.key;
  const sshUser = host.ssh?.user ?? "root";
  const sshArgs = [
    ...(sshKey ? sshKeyArgs(sshKey) : []),
    `${sshUser}@${host.address}`,
    asWolf,
  ];

  const child = spawn("ssh", sshArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
