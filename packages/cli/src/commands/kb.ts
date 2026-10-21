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

  const envSetup = [
    "export KB_BASE=/var/wolfpack/kb/base",
    "export KB_OPS=/var/wolfpack/kb/ops",
    `export WOLF_DEN=/home/wolf-${lib.id}/den`,
    `export ANTHROPIC_API_KEY=$(grep ^ANTHROPIC_API_KEY= /home/wolf-${lib.id}/.env | cut -d= -f2-)`,
    // Max transport: the Agent SDK authenticates with this token.
    `export CLAUDE_CODE_OAUTH_TOKEN=$(grep ^CLAUDE_CODE_OAUTH_TOKEN= /home/wolf-${lib.id}/.env | cut -d= -f2-)`,
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
    ...(sshKey ? ["-i", sshKey] : []),
    `${sshUser}@${host.address}`,
    asWolf,
  ];

  const child = spawn("ssh", sshArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
