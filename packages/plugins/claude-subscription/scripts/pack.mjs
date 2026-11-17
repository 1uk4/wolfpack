#!/usr/bin/env node
/**
 * Packs the claude-subscription plug-in into a self-contained tarball (no monorepo needed at runtime).
 *   node scripts/pack.mjs [outDir]      (default outDir: the package folder; writes <outDir>/stage and <outDir>/dist)
 * Steps: esbuild src/index.ts -> stage/claude-subscription/dist/index.js (ESM, node22, harness/engine inlined, the Agent SDK
 * external); npm install the SDK without its optional platform binary (the plug-in runs the user's own `claude` through
 * CLAUDE_CODE_PATH); write the manifest; tar to dist/claude-subscription-<version>.tgz (+ .sha256) and a -latest copy.
 * The tarball extracts to a single folder named claude-subscription.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ID = "claude-subscription";
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? pkgDir);
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const sdkVersion = pkg.dependencies["@anthropic-ai/claude-agent-sdk"];
const stage = join(outDir, "stage");
const root = join(stage, ID);
const dist = join(outDir, "dist");

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(root, "dist"), { recursive: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(pkgDir, "src/index.ts")],
  outfile: join(root, "dist/index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["@anthropic-ai/claude-agent-sdk"],
  logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// The manifest the loader reads; "type": "module" so dist/index.js is ESM; the SDK is the only runtime dependency.
writeFileSync(join(root, "package.json"), JSON.stringify({
  name: ID, version: pkg.version, private: true, type: "module", license: pkg.license,
  dependencies: { "@anthropic-ai/claude-agent-sdk": sdkVersion },
  wolfpack: pkg.wolfpack,
}, null, 2) + "\n");

// --omit=optional: no platform binary (309 MB on darwin-arm64); the user's own claude is used via CLAUDE_CODE_PATH.
execFileSync("npm", ["install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund", "--no-package-lock", "--prefix", root], { stdio: "inherit" });

const tgz = join(dist, `${ID}-${pkg.version}.tgz`);
execFileSync("tar", ["-czf", tgz, "-C", stage, ID]);
const writeSum = (file) => writeFileSync(`${file}.sha256`, `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${file.split("/").pop()}\n`);
writeSum(tgz);
const latest = join(dist, `${ID}-latest.tgz`);
copyFileSync(tgz, latest);
writeSum(latest);
console.log(`packed ${tgz}`);
