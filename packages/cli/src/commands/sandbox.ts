/**
 * wolfpack sandbox snapshot <wolf> --dev-root <dir> (--from <dir> | --host <h> --wolf-id <id> --yes)
 *                           [--force] [--include-sessions]
 *
 * Copies a host's work ledger, KB contributions lanes and one wolf's den into a dev root (read-only on the
 * source). A wolf with `sandbox: { root: <dir> }` in wolf.yaml then runs entirely against that copy.
 *
 *   --from <dir>   local source laid out as <dir>/{work,base,ops,den}   (dev / tests)
 *   --host <h>     rsync over ssh from a registered host (needs --wolf-id and --yes; touches the network)
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { takeSnapshot, type SnapshotSource } from "@wolfpack/engine";
import { loadConfig, getHost } from "../config.js";
import { remotePathsFrom } from "../paths.js";
import { c } from "../render.js";

const USAGE =
  "Usage: wolfpack sandbox snapshot <wolf> --dev-root <dir> (--from <dir> | --host <h> --wolf-id <id> --yes) [--force] [--include-sessions]";

export async function sandboxCmd(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dev-root": { type: "string" },
      from: { type: "string" },
      host: { type: "string" },
      "wolf-id": { type: "string" },
      force: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "include-sessions": { type: "boolean" },
    },
  });
  const [sub, wolf] = positionals;
  const fail = (msg: string): never => {
    console.error(c.red(msg));
    process.exit(1);
  };
  if (sub !== "snapshot" || !wolf || !values["dev-root"] || !!values.from === !!values.host) fail(USAGE);

  const devRoot = path.resolve(values["dev-root"]!);
  let source: SnapshotSource;
  let sshIdentity: string | undefined;
  if (values.from) {
    const from = path.resolve(values.from);
    source = { workDir: path.join(from, "work"), workBaseDir: path.join(from, "base"), opsDir: path.join(from, "ops"), denDir: path.join(from, "den") };
  } else {
    const config = loadConfig();
    const host = getHost(config, values.host);
    if (!host) return fail(`Host '${values.host}' not found in ~/.wolfpack/config.yaml.`);
    const id = values["wolf-id"];
    if (!id) return fail("--wolf-id is required for a remote snapshot (the host dir is wolf-<id>).");
    if (!values.yes) return fail(`Remote snapshot reads from ${values.host} over ssh (read-only). Re-run with --yes to proceed.`);
    const rp = remotePathsFrom(config);
    const at = `${host.ssh.user}@${host.address}`;
    source = {
      workDir: `${at}:${rp.kbRoot}/work`,
      workBaseDir: `${at}:${rp.sharedKbBase}`,
      opsDir: `${at}:${rp.sharedKbOps}`,
      denDir: `${at}:${rp.den(id)}`,
    };
    sshIdentity = host.ssh.key;
  }

  try {
    const m = takeSnapshot({ source, devRoot, force: values.force, includeSessions: values["include-sessions"], sshIdentity });
    console.log(c.bold(`Snapshot of ${wolf} -> ${devRoot}`));
    console.log(`  ledger events ${m.counts.ledgerEvents}, work items ${m.counts.workItems}, ops files ${m.counts.opsFiles}, den files ${m.counts.denFiles}`);
    console.log(`Use it: add to ${wolf}'s wolf.yaml\n  sandbox:\n    root: ${devRoot}`);
  } catch (err) {
    fail(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
