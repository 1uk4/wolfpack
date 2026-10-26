/**
 * wolfpack sandbox snapshot <wolf> --dev-root <dir> (--from <dir> | --host <h> --wolf-id <id> --yes | <mixed>)
 *                           [--force] [--include-sessions] [--no-install-extensions] [--extensions k1,k2]
 * wolfpack sandbox install-extensions <dev-root> [--extensions k1,k2] [--den-extensions <dir>] [--wolf <name>]
 * wolfpack sandbox add-wolf <dev-root> <wolf> [--extensions k1,k2] [--den-extensions <dir>]
 *
 * MIXED sources (the production-like dev sandbox): local den + local KB copy + the work ledger from a host.
 *   --den <dir>                local den to copy (read-only source)
 *   --kb-base <dir>            local KB base to COPY into <dev-root>/kb-base (read-only source; KB_BASE then points there)
 *   --ops <dir> [--ops-lane a,b]  local KB ops lanes to copy (default: none, empty lanes)
 *   --ledger-from-host <h>     work ledger + work item .md files from host <h>: the ONLY remote part (needs --yes).
 *                              rsync, remote path as SOURCE only, no --delete, explicit include/exclude filters; the
 *                              remote ledger is hashed (read-only `sha256sum`) before and after and must equal the copy.
 *   --work-from <dir>          the same ledger/items from a local dir <dir>/{ledger/work-events.jsonl,base} instead (tests, stand-ins)
 *   --shared                   den goes to <dev-root>/dens/<wolf> (several wolves share the root)
 *   --refresh-work             re-pull ONLY ledger + items into an existing root (old ones are moved aside, never deleted)
 *   --dry-run                  rsync -n: list what the remote part would copy; nothing is written, no hash is taken
 *   --print-plan               print the exact remote commands and exit; contacts nothing
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
 * (default on; --no-install-extensions skips it). Keys: --extensions, else the source wolf's own `extensions:` list
 * (<from>/wolf.yaml or --wolf-yaml <file>), else "memory". With --host the source wolf.yaml is not read, so pass
 * --extensions or --wolf-yaml explicitly; den extensions that were dropped and not reinstalled are warned about for
 * local --from sources only (a remote den is not listed). `install-extensions`
 * does the same on an existing dev root, e.g. after editing an extension. Owner (non-repo) keys are built from
 * <from>/den/extensions (snapshot) or --den-extensions (install-extensions).
 */
import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dryRunRemote, loadWolfConfig, remotePlan, takeSnapshot, wolfDenDir, type SnapshotSource } from "@wolfpack/engine";
import { installDevExtensions } from "../bundle.js";
import { getExtension } from "../extensions.js";
import { loadConfig, getHost, type CliConfig } from "../config.js";
import { remotePathsFrom } from "../paths.js";
import { c } from "../render.js";

const USAGE =
  "Usage: wolfpack sandbox snapshot <wolf> --dev-root <dir> (--from <dir> | --host <h> --wolf-id <id> --yes | --den <dir> [--kb-base <dir>] [--ops <dir> [--ops-lane a,b]] (--ledger-from-host <h> --yes | --work-from <dir>) [--shared] [--refresh-work] [--dry-run] [--print-plan]) [--force] [--include-sessions] [--no-install-extensions] [--extensions k1,k2] [--wolf-yaml <file>]\n" +
  "       wolfpack sandbox install-extensions <dev-root> [--extensions k1,k2] [--den-extensions <dir>] [--wolf <name>]\n" +
  "       wolfpack sandbox add-wolf <dev-root> <wolf> [--extensions k1,k2] [--den-extensions <dir>]";

const DEFAULT_EXTENSION_KEYS = ["memory"];

/** Does `base` hold at least one `domains/<d>/work/*.md` item file? */
function hasWorkItems(base: string): boolean {
  const domains = path.join(base, "domains");
  if (!fs.existsSync(domains)) return false;
  return fs.readdirSync(domains).some((d) => {
    const w = path.join(domains, d, "work");
    return fs.existsSync(w) && fs.readdirSync(w).some((f) => f.endsWith(".md"));
  });
}

/**
 * `--from <dir>` -> snapshot source. Item .md files come from whichever of <dir>/base and the work server's
 * <dir>/work/base actually holds work items, preferring <dir>/base when both do (neither: <dir>/base).
 */
export function localSnapshotSource(from: string): SnapshotSource {
  const direct = path.join(from, "base");
  const served = path.join(from, "work", "base");
  const base = hasWorkItems(direct) || !hasWorkItems(served) ? direct : served;
  return { workDir: path.join(from, "work"), workBaseDir: base, opsDir: path.join(from, "ops"), denDir: path.join(from, "den") };
}

/** Extension keys: explicit list, else the source wolf's `extensions:` (when its wolf.yaml is known), else memory. */
export function resolveExtensionKeys(explicit: string | undefined, wolfYaml: string | undefined): { keys: string[]; from: string } {
  if (explicit) return { keys: explicit.split(",").map((k) => k.trim()).filter(Boolean), from: "--extensions" };
  if (wolfYaml && fs.existsSync(wolfYaml)) {
    try {
      const keys = loadWolfConfig(wolfYaml).config.extensions;
      if (keys.length > 0) return { keys, from: wolfYaml };
    } catch {
      /* unreadable wolf.yaml: fall back */
    }
  }
  return { keys: DEFAULT_EXTENSION_KEYS, from: "default" };
}

/** Folder paths Syncthing syncs, from its config.xml. ONLY the `path` attributes of <folder> elements are read. */
export function syncthingFolderPaths(configXml: string): string[] {
  const out: string[] = [];
  for (const m of configXml.matchAll(/<folder\b[^>]*?\spath="([^"]*)"/g)) out.push(m[1].replace(/^~(?=\/|$)/, os.homedir()));
  return out;
}

/**
 * Where a sandbox must never live (or contain): the live KB, the librarian lanes, local wolf homes, host mirrors
 * (under the wolves root) and every Syncthing-synced folder.
 */
export function protectedRoots(config: Pick<CliConfig, "wolvesRoot">, syncthingConfig = path.join(os.homedir(), "Library", "Application Support", "Syncthing", "config.xml")): string[] {
  const roots = ["knowledge", "librarian", "local", "sfo-01"].map((d) => path.join(config.wolvesRoot, d));
  try {
    roots.push(...syncthingFolderPaths(fs.readFileSync(syncthingConfig, "utf8")));
  } catch {
    /* no Syncthing config here */
  }
  return roots;
}

/**
 * `--den/--kb-base/--ops/--work-from|--ledger-from-host` -> snapshot source: the ledger + item files come from a host
 * (the only remote part, filtered to exactly those) or a local dir; den, KB copy and ops are always local.
 */
export function mixedSnapshotSource(v: {
  den?: string; kbBase?: string; ops?: string; opsLane?: string; workFrom?: string; ledgerRemote?: { at: string; kbRoot: string; sharedKbBase: string };
}): SnapshotSource {
  const workPart: Pick<SnapshotSource, "workDir" | "workBaseDir"> = v.ledgerRemote
    ? { workDir: `${v.ledgerRemote.at}:${v.ledgerRemote.kbRoot}/work`, workBaseDir: `${v.ledgerRemote.at}:${v.ledgerRemote.sharedKbBase}` }
    : { workDir: v.workFrom!, ...(hasWorkItems(path.join(v.workFrom!, "base")) ? { workBaseDir: path.join(v.workFrom!, "base") } : {}) };
  return {
    ...workPart,
    ...(v.ops ? { opsDir: v.ops } : {}),
    ...(v.ops && v.opsLane ? { opsLanes: v.opsLane.split(",").map((l) => l.trim()).filter(Boolean) } : {}),
    denDir: v.den!,
    ...(v.kbBase ? { kbBaseDir: v.kbBase } : {}),
  };
}

async function install(devRoot: string, keys: string[], denExtensionsDir?: string, wolf?: string): Promise<string[]> {
  const r = await installDevExtensions(devRoot, keys, denExtensionsDir, wolf);
  console.log(`  extensions installed into ${path.join(wolf ? wolfDenDir(devRoot, wolf) : path.join(devRoot, "den"), "extensions")}: ${r.included.join(", ") || "none"}`);
  if (r.missing.length) throw new Error(`could not build extension(s): ${r.missing.join(", ")}`);
  return r.included.map((k) => getExtension(k)?.dir ?? k);
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
      "wolf-yaml": { type: "string" },
      wolf: { type: "string" },
      den: { type: "string" },
      "kb-base": { type: "string" },
      ops: { type: "string" },
      "ops-lane": { type: "string" },
      "work-from": { type: "string" },
      "ledger-from-host": { type: "string" },
      shared: { type: "boolean" },
      "refresh-work": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "print-plan": { type: "boolean" },
    },
    allowNegative: true,
  });
  const [sub, wolf] = positionals;
  const fail = (msg: string): never => {
    console.error(c.red(msg));
    process.exit(1);
  };
  if (sub === "install-extensions") {
    const root = positionals[1];
    if (!root) return fail(USAGE);
    const devRoot = path.resolve(root);
    if (!fs.existsSync(path.join(devRoot, "snapshot.json"))) return fail(`${devRoot} is not a snapshot (no snapshot.json)`);
    try {
      const { keys } = resolveExtensionKeys(values.extensions, values["wolf-yaml"] ? path.resolve(values["wolf-yaml"]) : undefined);
      await install(devRoot, keys, values["den-extensions"] ? path.resolve(values["den-extensions"]) : undefined, values.wolf);
    } catch (err) {
      fail(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (sub === "add-wolf") {
    // A new wolf in an existing shared sandbox: its own empty den + the current extension bundles. Nothing else changes.
    const [, root, name] = positionals;
    if (!root || !name) return fail(USAGE);
    const devRoot = path.resolve(root);
    if (!fs.existsSync(path.join(devRoot, "snapshot.json"))) return fail(`${devRoot} is not a snapshot (no snapshot.json)`);
    try {
      const den = wolfDenDir(devRoot, name);
      fs.mkdirSync(den, { recursive: true });
      const { keys } = resolveExtensionKeys(values.extensions, values["wolf-yaml"] ? path.resolve(values["wolf-yaml"]) : undefined);
      await install(devRoot, keys, values["den-extensions"] ? path.resolve(values["den-extensions"]) : undefined, name);
      console.log(`  ${name}: den ${den}`);
    } catch (err) {
      fail(`add-wolf failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  const mixed = !!values.den || !!values["work-from"] || !!values["ledger-from-host"];
  const refresh = !!values["refresh-work"];
  if (sub !== "snapshot" || !wolf || !values["dev-root"] || (mixed ? !!values.from || !!values.host : !!values.from === !!values.host)) fail(USAGE);
  if (mixed && (!!values["work-from"] === !!values["ledger-from-host"] || (!values.den && !refresh))) return fail(`Mixed snapshot needs --den and exactly one of --work-from / --ledger-from-host.\n${USAGE}`);

  const devRoot = path.resolve(values["dev-root"]!);
  let source: SnapshotSource;
  let sshIdentity: string | undefined;
  if (mixed) {
    const config = loadConfig();
    const rp = remotePathsFrom(config);
    let ledgerRemote: { at: string; kbRoot: string; sharedKbBase: string } | undefined;
    if (values["ledger-from-host"]) {
      const host = getHost(config, values["ledger-from-host"]);
      if (!host) return fail(`Host '${values["ledger-from-host"]}' not found in ~/.wolfpack/config.yaml.`);
      ledgerRemote = { at: `${host.ssh.user}@${host.address}`, kbRoot: rp.kbRoot, sharedKbBase: rp.sharedKbBase };
      sshIdentity = host.ssh.key;
    }
    const abs = (p?: string) => (p ? path.resolve(p) : undefined);
    source = mixedSnapshotSource({ den: abs(values.den) ?? "", kbBase: abs(values["kb-base"]), ops: abs(values.ops), opsLane: values["ops-lane"], workFrom: abs(values["work-from"]), ledgerRemote });
    if (values["print-plan"]) {
      for (const step of remotePlan(source, sshIdentity)) console.log(`${step.label}:\n  ${step.command}`);
      return;
    }
    if (values["dry-run"]) {
      if (!ledgerRemote) return fail("--dry-run lists a REMOTE copy; use it with --ledger-from-host");
      try {
        for (const part of dryRunRemote(source, sshIdentity)) {
          console.log(c.bold(`${part.label} (rsync -n):`));
          for (const l of part.lines) console.log(`  ${l}`);
        }
      } catch (err) {
        return fail(`Dry run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (ledgerRemote && !values.yes) return fail(`The ledger is read from ${values["ledger-from-host"]} over ssh (read-only, filtered, hashed before and after). Re-run with --yes to proceed.`);
  } else if (values.from) {
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
    const forbiddenRoots = protectedRoots(loadConfig());
    const m = takeSnapshot({
      source, devRoot, force: values.force, includeSessions: values["include-sessions"], sshIdentity, forbiddenRoots,
      ...(mixed && values.shared ? { denName: wolf } : {}),
      ...(refresh ? { workOnly: true } : {}),
    });
    console.log(c.bold(`${refresh ? "Refreshed work of" : "Snapshot of"} ${wolf} -> ${devRoot}`));
    console.log(`  ledger events ${m.counts.ledgerEvents}, work items ${m.counts.workItems}, ops files ${m.counts.opsFiles}, den files ${m.counts.denFiles} (${m.den}), kb-base files ${m.counts.kbBaseFiles}`);
    if (m.ledgerSha256) console.log(`  ledger sha256 ${m.ledgerSha256}`);
    if (refresh) return;
    if (m.counts.ledgerEvents > 0 && m.counts.workItems === 0) {
      console.warn(c.yellow("warning: the ledger has events but 0 work item .md files were copied (check where the item files live: <from>/base or <from>/work/base)"));
    }
  } catch (err) {
    return fail(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (values["install-extensions"] !== false) {
    const from = values.from ? path.resolve(values.from) : undefined;
    const wolfYaml = values["wolf-yaml"] ? path.resolve(values["wolf-yaml"]) : from ? path.join(from, "wolf.yaml") : undefined;
    const { keys, from: keysFrom } = resolveExtensionKeys(values.extensions, wolfYaml);
    const denSrc = from ? path.join(from, "den", "extensions") : values.den ? path.join(path.resolve(values.den), "extensions") : undefined;
    try {
      const dirs = await install(devRoot, keys, denSrc, mixed && values.shared ? wolf : undefined);
      console.log(`  extension keys from ${keysFrom}: ${keys.join(", ")}`);
      const srcExt = denSrc;
      const dropped = srcExt && fs.existsSync(srcExt) ? fs.readdirSync(srcExt).filter((d) => !dirs.includes(d)) : [];
      if (dropped.length) console.warn(c.yellow(`warning: den extension(s) in the source were not copied and not reinstalled: ${dropped.join(", ")} (add them to --extensions to install)`));
    } catch (err) {
      return fail(`snapshot OK; extension install failed: ${err instanceof Error ? err.message : String(err)}\nrun \`wolfpack sandbox install-extensions ${devRoot}\``);
    }
  }
  console.log(`Use it: add to ${wolf}'s wolf.yaml\n  sandbox:\n    root: ${devRoot}`);
}
