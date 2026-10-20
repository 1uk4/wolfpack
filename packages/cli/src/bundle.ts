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
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { writeModelTable, type ModelTable } from "@wolfpack/engine";
import {
  getExtension,
  extensionsDir,
  type WolfExtension,
} from "./extensions.js";
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
    if (fs.existsSync(path.resolve(srcDir, asset))) hash.update(asset);
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
async function bundleExtension(
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
      hash.update(asset);
    }
  }

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
    logLevel: "silent",
  });

  // 2. Bundle extensions separately
  const extDir = path.join(outDir, "extensions");
  fs.mkdirSync(extDir, { recursive: true });
  const base = extensionsDir();

  for (const key of cfg.extensions) {
    const ext = getExtension(key);
    if (!ext) { missing.push(key); continue; }
    const srcDir = path.join(base, ext.dir);
    if (!fs.existsSync(srcDir)) { missing.push(key); continue; }

    const pkgPath = path.join(srcDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      "pi-durable"?: { extensions?: string[] };
    };
    const durableEntries = pkg["pi-durable"]?.extensions;
    if (!durableEntries || durableEntries.length === 0) {
      missing.push(key);
      continue;
    }

    const entryFile = path.resolve(srcDir, durableEntries[0]);
    if (!fs.existsSync(entryFile)) {
      console.warn(`Extension ${key}: pi-durable entrypoint not found: ${durableEntries[0]}`);
      missing.push(key);
      continue;
    }

    const extOutDir = path.join(extDir, ext.dir);
    fs.mkdirSync(extOutDir, { recursive: true });
    await esbuild.build({
      entryPoints: [entryFile],
      outfile: path.join(extOutDir, "index.js"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: [
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-tui",
        "grammy",
      ],
      logLevel: "silent",
    });
    included.push(key);
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
  if (cfg.extraConfig) {
    const { stringify: yamlStringify } = await import("yaml");
    for (const [key, value] of Object.entries(cfg.extraConfig)) {
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
