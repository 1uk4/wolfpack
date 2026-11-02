// Stages the package.json of every npm workspace (derived from the root package.json "workspaces" globs) plus the root manifest and lockfile
// into <export-dir>/.manifests/, keeping relative paths. The tracer Dockerfile COPYs only that dir before `npm ci`, so a source-only change
// does not invalidate the npm ci layer, and a new workspace package cannot be silently missed.
//   node infra/tracer/stage-manifests.mjs <export-dir>      prints the staged relative paths, one per line
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
const root = process.argv[2];
if (!root) { console.error("usage: stage-manifests.mjs <export-dir>"); process.exit(2); }
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
const dirs = [];
for (const g of globs) {
  if (g.endsWith("/*")) {
    const base = g.slice(0, -2);
    if (!existsSync(join(root, base))) continue;
    for (const n of readdirSync(join(root, base)).sort()) if (statSync(join(root, base, n)).isDirectory() && existsSync(join(root, base, n, "package.json"))) dirs.push(`${base}/${n}`);
  } else if (!g.includes("*")) {
    if (existsSync(join(root, g, "package.json"))) dirs.push(g);
  } else { console.error(`stage-manifests: unsupported workspace glob '${g}' (only 'dir/*' and exact paths); extend this script`); process.exit(1); }
}
const files = ["package.json", "package-lock.json", ...dirs.map((d) => `${d}/package.json`)];
const out = join(root, ".manifests");
for (const f of files) {
  if (!existsSync(join(root, f))) { console.error(`stage-manifests: missing ${f}`); process.exit(1); }
  mkdirSync(dirname(join(out, f)), { recursive: true });
  cpSync(join(root, f), join(out, f));
}
console.log(files.join("\n"));
