/**
 * Portable identity-bundle builder (remote wolves).
 *
 * "Single source of truth": a wolf's PI identity (its `agent/` dir — settings,
 * persona, and extensions) is built here from the repo's `extensions/` plus the
 * wolf's config, then shipped to a host agent as a base64 tar.gz. The agent
 * unpacks it into the wolf's home; the VPS never needs the monorepo.
 *
 * Extensions are bundled with esbuild (Path Z): each becomes a self-contained
 * `index.js` + `package.json` + resource dirs, with Pi-supplied packages left
 * external. No node_modules, no npm on the VPS.
 *
 * Used by both `wolf add` (create) and `wolf sync` (propagate updates).
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { parseAgentDefinition, standardsFor } from "@wolfpack/agents";
import { wolfDenDir, writeModelTable, type ModelTable } from "@wolfpack/engine";
import {
  getExtension,
  extensionsDir,
  type WolfExtension,
} from "./extensions.js";
import { buildDenExtension, findDenExtension } from "./den-extensions.js";
import { MODELS_FILE_NAME, modelTableHash } from "./models.js";

/**
 * Packages Pi supplies to extensions at load time — never bundle these.
 * (From the Pi packages doc: `pi` package catalog + typebox.)
 */
const PI_SUPPLIED_EXTERNALS = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

/** Minimal shape of an extension package.json `pi` field. */
interface PiManifest {
  extensions?: string[];
  agents?: string[];
  prompts?: string[];
  skills?: string[];
  themes?: string[];
}

/** Config fields the bundle needs for settings.json + persona. */
export interface BundleWolfConfig {
  id?: string;
  name: string;
  role: string;
  specialty?: string;
  domains?: string[];
  extensions: string[];
}

/** Config fields for pi-durable harness bundle (includes extra config for wolf.yaml). */
export interface HarnessBundleConfig extends BundleWolfConfig {
  /** The wolf's model table, resolved on this machine (location vps). Shipped
   *  as models.json — the VPS never resolves models itself. */
  models: ModelTable;
  extraConfig?: Record<string, unknown>;
  /**
   * The wolf's den `extensions/` dir on this machine. Keys that aren't repo
   * extensions are looked up here (index.ts is built, index.js shipped as is).
   */
  denExtensionsDir?: string;
}

/** Version + content identity of one bundled extension (drift detection). */
export interface ExtensionStamp {
  /** Logical key (wolf.yaml `extensions: [...]`). */
  key: string;
  /** Package name. */
  name: string;
  /** package.json version (human-facing). */
  version: string;
  /** sha256 of the bundled entry output (catches same-version source changes). */
  hash: string;
}

/** Manifest of everything a bundle installed — stored per wolf for drift checks. */
export interface BundleManifest {
  builtAt: string;
  extensions: ExtensionStamp[];
  /** modelTableHash of the shipped models.json (pi-durable bundles; drift). */
  modelTableHash?: string;
}

export interface BuiltBundle {
  /** base64(gzip(tar)) of the `agent/` directory contents. */
  bundleB64: string;
  /** Extension keys whose package dir was missing (skipped). */
  missing: string[];
  /** Extension keys actually included. */
  included: string[];
  /** Version/hash manifest of included extensions. */
  manifest: BundleManifest;
}

/** Feed an asset's contents into the hash: a file's bytes, or every file under a folder (sorted, with relative paths). */
function hashAsset(hash: ReturnType<typeof createHash>, abs: string, rel = path.basename(abs)): void {
  if (fs.statSync(abs).isDirectory()) {
    for (const entry of fs.readdirSync(abs).sort()) hashAsset(hash, path.join(abs, entry), `${rel}/${entry}`);
    return;
  }
  hash.update(rel);
  hash.update(fs.readFileSync(abs));
}

/**
 * Fail the build when a profile shipped in the extension names (or is always given) a standard that is not in the built
 * extension's `standards` folder. At runtime a missing standard only degrades the agent, so this is where it must be caught.
 */
function assertStandardsShipped(dest: string, agentGlobs: string[] | undefined): void {
  for (const glob of agentGlobs ?? []) {
    const agentsDir = path.join(dest, path.basename(glob.replace(/\/[^/]*$/, "")));
    if (!fs.existsSync(agentsDir)) continue;
    for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
      const def = parseAgentDefinition(fs.readFileSync(path.join(agentsDir, file), "utf8"), file.replace(/\.md$/, ""));
      if (!def) continue;
      for (const name of standardsFor(def.name, def.standards, file.replace(/\.md$/, ""))) {
        const shipped = path.join(dest, "standards", `${name}.md`);
        if (!fs.existsSync(shipped)) throw new Error(`Agent profile ${file} needs standard "${name}" but ${shipped} is not in the built extension (add the standards folder to wolfpack.assets)`);
      }
    }
  }
}

/**
 * Compute the stamp (version + content hash) an extension *would* get right now,
 * without building a full bundle. Used by `status`/`list` to detect drift.
 * Returns undefined if the extension is unknown or missing from the repo.
 */
export async function stampExtension(
  key: string,
): Promise<ExtensionStamp | undefined> {
  const ext = getExtension(key);
  if (!ext) return undefined;
  const srcDir = path.join(extensionsDir(), ext.dir);
  if (!fs.existsSync(srcDir)) return undefined;
  const pkg = JSON.parse(
    fs.readFileSync(path.join(srcDir, "package.json"), "utf8"),
  ) as { name?: string; version?: string; pi?: PiManifest; wolfpack?: { assets?: string[] } };
  const hash = createHash("sha256");
  for (const entry of pkg.pi?.extensions ?? []) {
    const built = await esbuild.build({
      entryPoints: [path.resolve(srcDir, entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      external: PI_SUPPLIED_EXTERNALS,
      write: false,
      logLevel: "silent",
    });
    for (const f of built.outputFiles) hash.update(f.contents);
  }
  // Must match bundleExtension's hash, which includes the asset folders.
  for (const asset of pkg.wolfpack?.assets ?? []) {
    const abs = path.resolve(srcDir, asset);
    if (fs.existsSync(abs)) hashAsset(hash, abs);
  }
  return {
    key,
    name: pkg.name ?? ext.dir,
    version: pkg.version ?? "0.0.0",
    hash: hash.digest("hex").slice(0, 16),
  };
}

/**
 * Bundle one extension into `destDir/<dir>/`: esbuild its entry files and copy
 * declared resource dirs (agents/prompts/skills/themes) verbatim.
 */
export async function bundleExtension(
  ext: WolfExtension,
  srcDir: string,
  destRoot: string,
): Promise<ExtensionStamp> {
  const pkgJsonPath = path.join(srcDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
    name?: string;
    version?: string;
    pi?: PiManifest;
    /** Extra folders the extension reads at runtime (e.g. "kb-graph"), copied as-is. */
    wolfpack?: { assets?: string[] };
  };
  const pi = pkg.pi ?? {};
  const dest = path.join(destRoot, ext.dir);
  fs.mkdirSync(dest, { recursive: true });

  // 1. esbuild each extension entry → self-contained .js (keep basename).
  const outExtensions: string[] = [];
  const hash = createHash("sha256");
  for (const entry of pi.extensions ?? []) {
    const absEntry = path.resolve(srcDir, entry);
    const outName = path.basename(entry).replace(/\.(ts|tsx|mts|cts)$/, ".js");
    const outFile = path.join(dest, outName);
    await esbuild.build({
      entryPoints: [absEntry],
      outfile: outFile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      external: PI_SUPPLIED_EXTERNALS,
      logLevel: "silent",
    });
    hash.update(fs.readFileSync(outFile));
    outExtensions.push(`./${outName}`);
  }

  // 2. Copy resource dirs declared via globs (e.g. "./agents/*.md").
  const copyGlobDir = (globs: string[] | undefined): string[] => {
    const out: string[] = [];
    for (const g of globs ?? []) {
      // Only the directory part matters for copying; keep the glob in manifest.
      const dirPart = g.replace(/\/[^/]*$/, "");
      const absDir = path.resolve(srcDir, dirPart);
      if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
        fs.cpSync(absDir, path.join(dest, path.basename(dirPart)), {
          recursive: true,
        });
      }
      out.push(g);
    }
    return out;
  };
  const outAgents = copyGlobDir(pi.agents);
  const outPrompts = copyGlobDir(pi.prompts);
  const outSkills = copyGlobDir(pi.skills);
  const outThemes = copyGlobDir(pi.themes);

  // 2b. Copy runtime asset folders (not Pi resources; just files next to the bundle).
  for (const asset of pkg.wolfpack?.assets ?? []) {
    const abs = path.resolve(srcDir, asset);
    if (fs.existsSync(abs)) {
      fs.cpSync(abs, path.join(dest, path.basename(asset)), { recursive: true });
      hashAsset(hash, abs);
    }
  }
  assertStandardsShipped(dest, pi.agents);

  // 3. Write a slim package.json: inlined deps, Pi resources repointed to .js.
  const outPi: PiManifest = { extensions: outExtensions };
  if (outAgents.length) outPi.agents = outAgents;
  if (outPrompts.length) outPi.prompts = outPrompts;
  if (outSkills.length) outPi.skills = outSkills;
  if (outThemes.length) outPi.themes = outThemes;
  fs.writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify(
      {
        name: pkg.name ?? ext.dir,
        version: pkg.version ?? "0.0.0",
        private: true,
        type: "module",
        pi: outPi,
      },
      null,
      2,
    ) + "\n",
  );

  return {
    key: ext.key,
    name: pkg.name ?? ext.dir,
    version: pkg.version ?? "0.0.0",
    hash: hash.digest("hex").slice(0, 16),
  };
}

/** Generate a baseline persona (AGENTS.md) from the wolf's config. */
function renderPersona(cfg: BundleWolfConfig): string {
  const lines = [`# ${cfg.name} — Wolf Identity`, ""];
  lines.push("## Role", cfg.role || cfg.name, "");
  if (cfg.specialty) lines.push("## Specialty", cfg.specialty, "");
  if (cfg.domains?.length) {
    lines.push("## Domains", cfg.domains.map((d) => `- ${d}`).join("\n"), "");
  }
  lines.push(
    "## Memory",
    "- Your den (`$WOLF_DEN`) is your PRIVATE working memory across sessions.",
    "- Read `$WOLF_DEN/tasks/` at startup for active work.",
    "",
  );
  lines.push(
    "## Shared Knowledge Base",
    "Separate from your private den, the pack shares a librarian-curated knowledge",
    "base — the source of truth for shared knowledge. It lives at",
    "`knowledge/base/domains/<domain>/` as a read-only mirror kept current by the",
    "librarian (Dewey). Your den is private; the KB is shared truth.",
    "",
    "Before answering a question about a domain — or contributing knowledge to it —",
    "consult the KB and READ IT FRESH (it syncs continuously and may have changed",
    "since earlier in your session):",
    "- `knowledge/base/domains/<domain>/_registry.md` — the topic map: what topics",
    "  exist and how mature they are. Check it before writing, to extend an existing",
    "  topic instead of duplicating it.",
    "- `knowledge/base/domains/<domain>/INDEX.md` — the entry list (titles → files).",
    "- the entry files under `.../entries/` for detail.",
    "",
    "Never answer a shared-domain question from your den or a cached view — re-read",
    "the registry and index at the moment you need them.",
    "",
  );
  return lines.join("\n");
}

/**
 * Build the portable identity bundle for a remote wolf.
 *
 * Produces an `agent/` directory containing:
 *   - settings.json   (packages[] = ./extensions/<dir>, resolved relative to it)
 *   - AGENTS.md       (generated persona)
 *   - extensions/<dir>/ (esbuild-bundled, self-contained)
 * then tars + gzips + base64-encodes it.
 */
export async function buildRemoteBundle(
  cfg: BundleWolfConfig,
): Promise<BuiltBundle> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wolf-bundle-"));
  const agentStage = path.join(tmpRoot, "agent");
  const extStage = path.join(agentStage, "extensions");
  fs.mkdirSync(extStage, { recursive: true });

  const base = extensionsDir();
  const included: string[] = [];
  const missing: string[] = [];
  const packages: string[] = [];
  const stamps: ExtensionStamp[] = [];

  try {
    for (const key of cfg.extensions) {
      const ext = getExtension(key);
      if (!ext) {
        missing.push(key);
        continue;
      }
      const srcDir = path.join(base, ext.dir);
      if (!fs.existsSync(srcDir)) {
        missing.push(key);
        continue;
      }
      stamps.push(await bundleExtension(ext, srcDir, extStage));
      // Relative path — Pi resolves local package paths from the settings file.
      packages.push(`./extensions/${ext.dir}`);
      included.push(key);
    }

    const manifest: BundleManifest = {
      builtAt: new Date().toISOString(),
      extensions: stamps,
    };

    // settings.json
    fs.writeFileSync(
      path.join(agentStage, "settings.json"),
      JSON.stringify({ packages }, null, 2) + "\n",
    );

    // bundle manifest (drift detection: version + content hash per extension)
    fs.writeFileSync(
      path.join(agentStage, "bundle.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );

    // persona
    fs.writeFileSync(path.join(agentStage, "AGENTS.md"), renderPersona(cfg));

    // tar + gzip + base64 (portable: bsdtar on mac, GNU tar on linux)
    const tarBuf = execFileSync(
      "tar",
      ["-czf", "-", "-C", agentStage, "."],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    return { bundleB64: tarBuf.toString("base64"), missing, included, manifest };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** Return type for pi-durable harness bundle (individual files, not tarball). */
export interface BuiltHarnessBundle {
  /** Path to the bundled harness.cjs file */
  harnessPath: string;
  /** Path to the generated wolf.yaml */
  wolfYamlPath: string;
  /** Path to the generated AGENTS.md */
  agentsMdPath: string;
  /** Path to the resolved model table (models.json) */
  modelsPath: string;
  /** Manifest recorded in wolf.yaml `bundle:` (extension stamps + model table hash) */
  manifest: BundleManifest;
  /** Extension keys that were missing (skipped) */
  missing: string[];
  /** Extension keys actually included */
  included: string[];
  /** Temporary directory (caller must clean up) */
  tmpDir: string;
}

/** Why an extension was skipped by the last buildDurableExtension call (key -> reason); `wolfpack sync` prints it. */
export const skipReasons = new Map<string, string>();

export interface BuildDurableOptions {
  /** Test seam: how `playwright-core/package.json` is resolved (default: Node resolution from this module). */
  resolvePackage?: (id: string) => string;
}

/**
 * Build one pi-durable extension into `<extDir>/<dir>/index.js` (the layout `wolfpack sync` ships and wolfd/harness
 * load from `<den>/extensions/`). A repo extension is bundled from its package.json `pi-durable` entrypoint; any other
 * key is an owner extension looked up in `denExtensionsDir`. Returns false (skipped) when it can't be built.
 */
export async function buildDurableExtension(key: string, extDir: string, denExtensionsDir?: string, opts: BuildDurableOptions = {}): Promise<boolean> {
  skipReasons.delete(key);
  const ext = getExtension(key);
  if (!ext) {
    // Not a repo extension: an owner extension from the wolf's den?
    const denSrc = denExtensionsDir ? findDenExtension(denExtensionsDir, key) : undefined;
    if (!denSrc) return false;
    try {
      await buildDenExtension(denSrc, path.join(extDir, key, "index.js"));
      return true;
    } catch (err) {
      console.warn(`Den extension ${key}: build failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
  const srcDir = path.join(extensionsDir(), ext.dir);
  if (!fs.existsSync(srcDir)) return false;

  const pkgPath = path.join(srcDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    "pi-durable"?: { extensions?: string[] };
    /** Optional dynamic requires the bundle never reaches (kept out of the bundle instead of failing the build). */
    wolfpack?: { externals?: string[]; playwrightCore?: boolean };
  };
  const durableEntries = pkg["pi-durable"]?.extensions;
  if (!durableEntries || durableEntries.length === 0) return false;

  const entryFile = path.resolve(srcDir, durableEntries[0]);
  if (!fs.existsSync(entryFile)) {
    console.warn(`Extension ${key}: pi-durable entrypoint not found: ${durableEntries[0]}`);
    return false;
  }

  const extOutDir = path.join(extDir, ext.dir);

  // playwright-core resolves its package root as `__dirname/..` and reads package.json / browsers.json there. Bundled,
  // that would be the den's extensions/ dir; point it at the extension's own dir and ship the two files beside index.js.
  // Everything playwright-specific is best effort: if it can't be done, THIS extension is skipped with a warning and the
  // build for every other extension (and wolf) is unaffected.
  let playwrightRoot: esbuild.Plugin[] = [];
  let playwrightFiles: { pkgJson: string; browsersJson: string } | undefined;
  if (pkg.wolfpack?.playwrightCore) {
    try {
      const pwPkg = (opts.resolvePackage ?? ((id: string) => createRequire(import.meta.url).resolve(id)))("playwright-core/package.json");
      const pwDir = path.dirname(pwPkg);
      const browsersJson = path.join(pwDir, "browsers.json");
      if (!fs.existsSync(browsersJson)) throw new Error(`browsers.json not found in ${pwDir}`);
      const version = (JSON.parse(fs.readFileSync(pwPkg, "utf8")) as { version: string }).version;
      playwrightFiles = { pkgJson: JSON.stringify({ name: "playwright-core", version }) + "\n", browsersJson };
      playwrightRoot = [
        {
          name: "playwright-core-root",
          setup(b) {
            b.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, (a) => {
              const src = fs.readFileSync(a.path, "utf8");
              const re = /packageRoot\s*=\s*(\w+)\.default\.join\(__dirname,\s*"\.\."\)/;
              if (!re.test(src)) throw new Error("playwright-core: packageRoot assignment not found (unsupported version)");
              return { contents: src.replace(re, "packageRoot = __dirname"), loader: "js", resolveDir: path.dirname(a.path) };
            });
          },
        },
      ];
    } catch (err) {
      const why = `playwright-core unavailable: ${err instanceof Error ? err.message.split("\n")[0] : err}`;
      skipReasons.set(key, why);
      console.warn(`Extension ${key}: skipped (${why})`);
      return false;
    }
  }

  // Build beside the target and swap in only on success: a failed rebuild must not delete a working install.
  // (Beside the target, not in os.tmpdir(): rename across filesystems fails with EXDEV.) Staging dirs a crashed build
  // left behind are swept first.
  fs.mkdirSync(path.dirname(extOutDir), { recursive: true });
  for (const n of fs.readdirSync(path.dirname(extOutDir))) {
    if (n.startsWith(`.${ext.dir}-build-`)) fs.rmSync(path.join(path.dirname(extOutDir), n), { recursive: true, force: true });
  }
  const stage = fs.mkdtempSync(path.join(path.dirname(extOutDir), `.${ext.dir}-build-`));
  try {
    await esbuild.build({
      entryPoints: [entryFile],
      outfile: path.join(stage, "index.js"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      plugins: playwrightRoot,
      external: [
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-tui",
        "grammy",
        ...(pkg.wolfpack?.externals ?? []),
      ],
      logLevel: "silent",
    });
    if (playwrightFiles) {
      fs.copyFileSync(playwrightFiles.browsersJson, path.join(stage, "browsers.json"));
      fs.writeFileSync(path.join(stage, "package.json"), playwrightFiles.pkgJson);
    }
    // Swap in (same cleanup path as a failure): the old install is only removed once the new one is complete.
    fs.rmSync(extOutDir, { recursive: true, force: true });
    fs.renameSync(stage, extOutDir);
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (!playwrightFiles) throw err; // other extensions keep their existing failure behaviour
    const why = `build failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`;
    skipReasons.set(key, why);
    console.warn(`Extension ${key}: skipped (${why})`);
    return false;
  }
  return true;
}

/**
 * Install CURRENT extension bundles (built from this checkout exactly as `wolfpack sync` builds them) into a dev
 * root's den: `<devRoot>/den/extensions/<dir>/index.js` (`<devRoot>/dens/<wolf>/extensions/...` for a wolf of a shared sandbox). Replaces the named extensions' dirs; others are untouched.
 */
export async function installDevExtensions(
  devRoot: string,
  keys: string[],
  denExtensionsDir?: string,
  wolf?: string,
): Promise<{ included: string[]; missing: string[] }> {
  // `wolf` (shared sandbox): that wolf's own den, `<devRoot>/dens/<wolf>`; else the single-wolf `<devRoot>/den`.
  const target = path.join(wolf ? wolfDenDir(path.resolve(devRoot), wolf) : path.join(path.resolve(devRoot), "den"), "extensions");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-devext-"));
  const included: string[] = [];
  const missing: string[] = [];
  try {
    for (const key of keys) {
      if (await buildDurableExtension(key, staging, denExtensionsDir)) included.push(key);
      else missing.push(key);
    }
    for (const dir of fs.readdirSync(staging)) {
      fs.rmSync(path.join(target, dir), { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(path.join(staging, dir), path.join(target, dir), { recursive: true });
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { included, missing };
}

/**
 * pi-claude-bridge-stateless imports the Agent SDK statically (only as the default `queryFn`). The SDK is ESM and is not
 * resolvable from harness.cjs on a VPS (global install, no node_modules above the bundle), so a plain external
 * require would throw when the bridge initialises. The harness always injects the query function it resolved
 * itself (engine loadQuery: harness tree, NODE_PATH, global install), so the bridge's own import is stubbed.
 * Both stubs apply to importers under pi-claude-bridge-stateless only (BRIDGE_IMPORTER). pnpm names the git dependency
 * by its package.json name (pi-claude-bridge), npm by the dependency key (-stateless), so both directory names match.
 */
const BRIDGE_IMPORTER = /[\\/]pi-claude-bridge(-stateless)?[\\/]/;

export function stubBridgeSdkPlugin(): esbuild.Plugin {
  return {
    name: "stub-bridge-agent-sdk",
    setup(build) {
      build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, (args) =>
        BRIDGE_IMPORTER.test(args.importer) ? { path: "claude-agent-sdk-stub", namespace: "bridge-sdk-stub" } : undefined,
      );
      build.onLoad({ filter: /.*/, namespace: "bridge-sdk-stub" }, () => ({
        contents: 'export function query() { throw new Error("claude-stateless: the Agent SDK query function must be injected (queryFn)"); }',
        loader: "js",
      }));
      // The stateless bridge's skills.ts imports pi-coding-agent for formatSkillsForPrompt, which the stateless provider
      // never calls. Bundled, pi-coding-agent's config.js runs fileURLToPath(import.meta.url) at load, which is undefined
      // in CJS and crashes the harness. Stub it for the bridge only.
      build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, (args) =>
        BRIDGE_IMPORTER.test(args.importer) ? { path: "pi-coding-agent-stub", namespace: "bridge-pca-stub" } : undefined,
      );
      build.onLoad({ filter: /.*/, namespace: "bridge-pca-stub" }, () => ({
        contents: 'export function formatSkillsForPrompt() { throw new Error("claude-stateless: pi-coding-agent is not available in the harness bundle"); }',
        loader: "js",
      }));
    },
  };
}

/** Version of the @earendil-works/pi-durable the harness bundle is built against (resolved from the harness package). */
export function piDurableVersion(repoRoot: string): string {
  const req = createRequire(path.join(repoRoot, "packages/harness/package.json"));
  let dir = path.dirname(req.resolve("@earendil-works/pi-durable"));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg.name === "@earendil-works/pi-durable") return String(pkg.version);
    } catch { /* keep walking up */ }
    dir = path.dirname(dir);
  }
  return "unknown";
}

/**
 * A wolf this bundle ships to a VPS IS the live wolf, so its durable memory is opted in explicitly:
 * `memory: { live: true }`. memoryGate (extensions/wolfpack-memory/unified.ts) is deliberately fail-closed and
 * stays so; the opt-in belongs to the deployer, not to the harness (which also runs unsandboxed in dev).
 * An explicit `memory.live` or `memory.enabled: false` in the wolf's config is respected.
 * Librarians get `live: true` too: the Oct 24 Dewey bundle had no memory gate, so its memory extension was active,
 * and live: true keeps that behaviour under the gate.
 */
export function withLiveMemory(extra: Record<string, unknown> | undefined, extensions: readonly string[]): Record<string, unknown> | undefined {
  const mem = extra?.memory;
  if (mem !== undefined && (typeof mem !== "object" || mem === null)) return extra;
  if (mem === undefined && !extensions.includes("memory")) return extra;
  const memory = (mem ?? {}) as Record<string, unknown>;
  if (memory.live !== undefined || memory.enabled === false) return extra;
  return { ...extra, memory: { ...memory, live: true } };
}

/**
 * Bundle @wolfpack/harness + extensions for pi-durable runtime.
 *
 * Uses esbuild to produce:
 * - harness.cjs (~1.2-2.4MB) from packages/harness/src/bin/harness.ts
 * - Extensions bundled separately in extensions/<name>/index.js
 * - wolf.yaml config file
 * - models.json (the resolved model table)
 * - AGENTS.md persona file
 *
 * Returns file paths — caller reads, base64-encodes, and ships to VPS.
 */
export async function buildHarnessBundle(
  cfg: HarnessBundleConfig,
  wolfId: string,
): Promise<BuiltHarnessBundle> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wolfpack-harness-"));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  const included: string[] = [];
  const missing: string[] = [];

  // 1. Bundle harness.cjs via esbuild
  const harnessEntry = path.join(repoRoot, "packages/harness/src/bin/harness.ts");
  const harnessPath = path.join(outDir, "harness.cjs");
  await esbuild.build({
    entryPoints: [harnessEntry],
    outfile: harnessPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["@anthropic-ai/claude-agent-sdk", "grammy"],
    plugins: [stubBridgeSdkPlugin()],
    // import.meta.url is empty in CJS and pi-durable is not on the VPS disk: bake its version in (engine/version.ts).
    define: { __PI_DURABLE_VERSION__: JSON.stringify(piDurableVersion(repoRoot)) },
    logLevel: "silent",
  });

  // 2. Bundle extensions separately
  const extDir = path.join(outDir, "extensions");
  fs.mkdirSync(extDir, { recursive: true });

  for (const key of cfg.extensions) {
    if (await buildDurableExtension(key, extDir, cfg.denExtensionsDir)) included.push(key);
    else missing.push(key);
  }

  // 3. Generate wolf.yaml
  const wolfYamlLines: string[] = [
    `id: ${wolfId}`,
    `name: ${cfg.name}`,
    `runtime: pi-durable`,
    `role: ${cfg.role}`,
  ];
  if (cfg.specialty) wolfYamlLines.push(`specialty: ${cfg.specialty}`);
  if (cfg.domains?.length) {
    wolfYamlLines.push(`domains:`);
    for (const d of cfg.domains) wolfYamlLines.push(`  - ${d}`);
  }
  if (included.length) {
    wolfYamlLines.push(`extensions:`);
    for (const e of included) wolfYamlLines.push(`  - ${e}`);
  }
  wolfYamlLines.push(`harness:`);
  wolfYamlLines.push(`  storage: session.sqlite`);

  // Bundle manifest for drift detection: extension stamps + model table hash.
  const stamps: ExtensionStamp[] = [];
  for (const key of included) {
    const stamp = await stampExtension(key);
    if (stamp) stamps.push(stamp);
  }
  const manifest: BundleManifest = {
    builtAt: new Date().toISOString(),
    extensions: stamps,
    modelTableHash: modelTableHash(cfg.models),
  };
  wolfYamlLines.push(`bundle:`);
  wolfYamlLines.push(`  builtAt: "${manifest.builtAt}"`);
  wolfYamlLines.push(`  modelTableHash: "${manifest.modelTableHash}"`);
  wolfYamlLines.push(stamps.length ? `  extensions:` : `  extensions: []`);
  for (const s of stamps) {
    wolfYamlLines.push(`    - key: ${s.key}`);
    wolfYamlLines.push(`      name: ${s.name}`);
    wolfYamlLines.push(`      version: ${s.version}`);
    wolfYamlLines.push(`      hash: "${s.hash}"`);
  }

  // Include extra config (memory, telegram, etc.)
  const extraConfig = withLiveMemory(cfg.extraConfig, cfg.extensions);
  if (extraConfig) {
    const { stringify: yamlStringify } = await import("yaml");
    for (const [key, value] of Object.entries(extraConfig)) {
      if (value !== undefined && value !== null) {
        const serialized = yamlStringify({ [key]: value }).trim();
        wolfYamlLines.push(serialized);
      }
    }
  }

  const wolfYamlPath = path.join(outDir, "wolf.yaml");
  fs.writeFileSync(wolfYamlPath, wolfYamlLines.join("\n") + "\n");

  // 4. Resolved model table, next to wolf.yaml on the VPS
  const modelsPath = path.join(outDir, MODELS_FILE_NAME);
  writeModelTable(modelsPath, cfg.models);

  // 5. Generate AGENTS.md persona
  const agentsMdPath = path.join(outDir, "AGENTS.md");
  fs.writeFileSync(agentsMdPath, renderPersona(cfg));

  return {
    harnessPath,
    wolfYamlPath,
    agentsMdPath,
    modelsPath,
    manifest,
    missing,
    included,
    tmpDir: outDir,
  };
}
