/**
 * wolfpack sandbox snapshot <wolf> --dev-root <dir> (--from <dir> | --host <h> --wolf-id <id> --yes)
 *                           [--force] [--include-sessions] [--no-install-extensions] [--extensions k1,k2]
 * wolfpack sandbox install-extensions <dev-root> [--extensions k1,k2] [--den-extensions <dir>]
 *
 * Copies a host's work ledger, KB contributions lanes and one wolf's den into a dev root (read-only on the
 * source). A wolf with `sandbox: { root: <dir> }` in wolf.yaml then runs entirely against that copy.
 *
 *   --from <dir>   local source laid out as <dir>/{work,base,ops,den}   (dev / tests). The item .md files are read from
 *                  <dir>/base, or, when that is absent, from <dir>/work/base (where the local work server writes them).
 *   --host <h>     rsync over ssh from a registered host (needs --wolf-id and --yes; touches the network)
 *
 * The snapshot never copies the host's den/extensions/ (a deployed bundle can predate the checkout). Instead CURRENT
 * bundles, built from this checkout the way `wolfpack sync` builds them, are installed into <dev-root>/den/extensions/
 * (default on: keys from --extensions, default "memory"; --no-install-extensions skips it). `install-extensions`
 * does the same on an existing dev root, e.g. after editing an extension. Owner (non-repo) keys are built from
 * <from>/den/extensions (snapshot) or --den-extensions (install-extensions).
 */
import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { takeSnapshot, type SnapshotSource } from "@wolfpack/engine";
import { installDevExtensions } from "../bundle.js";
import { loadConfig, getHost } from "../config.js";
import { remotePathsFrom } from "../paths.js";
import { c } from "../render.js";

const USAGE =
  "Usage: wolfpack sandbox snapshot <wolf> --dev-root <dir> (--from <dir> | --host <h> --wolf-id <id> --yes) [--force] [--include-sessions] [--no-install-extensions] [--extensions k1,k2]\n" +
  "       wolfpack sandbox install-extensions <dev-root> [--extensions k1,k2] [--den-extensions <dir>]";

const DEFAULT_EXTENSION_KEYS = ["memory"];

/** `--from <dir>` -> snapshot source. Item .md files: <dir>/base, else the work server's <dir>/work/base. */
export function localSnapshotSource(from: string): SnapshotSource {
  const base = fs.existsSync(path.join(from, "base")) ? path.join(from, "base") : path.join(from, "work", "base");
  return { workDir: path.join(from, "work"), workBaseDir: base, opsDir: path.join(from, "ops"), denDir: path.join(from, "den") };
}

async function install(devRoot: string, keys: string[], denExtensionsDir?: string): Promise<void> {
  const r = await installDevExtensions(devRoot, keys, denExtensionsDir);
  console.log(`  extensions installed into ${path.join(devRoot, "den", "extensions")}: ${r.included.join(", ") || "none"}`);
  if (r.missing.length) throw new Error(`could not build extension(s): ${r.missing.join(", ")}`);
}

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
      "install-extensions": { type: "boolean" },
      extensions: { type: "string" },
      "den-extensions": { type: "string" },
    },
    allowNegative: true,
  });
  const [sub, wolf] = positionals;
  const fail = (msg: string): never => {
    console.error(c.red(msg));
    process.exit(1);
  };
  const keys = values.extensions ? values.extensions.split(",").map((k) => k.trim()).filter(Boolean) : DEFAULT_EXTENSION_KEYS;
  if (sub === "install-extensions") {
    const root = positionals[1];
    if (!root) return fail(USAGE);
    const devRoot = path.resolve(root);
    if (!fs.existsSync(path.join(devRoot, "snapshot.json"))) return fail(`${devRoot} is not a snapshot (no snapshot.json)`);
    try {
      await install(devRoot, keys, values["den-extensions"] ? path.resolve(values["den-extensions"]) : undefined);
    } catch (err) {
      fail(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (sub !== "snapshot" || !wolf || !values["dev-root"] || !!values.from === !!values.host) fail(USAGE);

  const devRoot = path.resolve(values["dev-root"]!);
  let source: SnapshotSource;
  let sshIdentity: string | undefined;
  if (values.from) {
    source = localSnapshotSource(path.resolve(values.from));
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
    if (values["install-extensions"] !== false) {
      const denExt = values.from ? path.join(path.resolve(values.from), "den", "extensions") : undefined;
      await install(devRoot, keys, denExt);
    }
    console.log(`Use it: add to ${wolf}'s wolf.yaml\n  sandbox:\n    root: ${devRoot}`);
  } catch (err) {
    fail(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
