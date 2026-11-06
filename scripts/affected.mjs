#!/usr/bin/env node
// Affected-package detection for CI (and later `wolfpack release`).
//   node scripts/affected.mjs <base> <head> [--github-output]    prints JSON on stdout
// Rules:
//  - changed files come from `git diff --name-only <base> <head>`; a missing/zero/unknown base marks EVERYTHING.
//  - root config (package-lock.json, root package.json, root tsconfig*.json, vitest/turbo config, .github/workflows/**) marks everything.
//  - a file under a workspace dir marks that workspace; docs (*.md, docs/**, LICENSE) mark nothing.
//  - affected packages = changed + everything that depends on them (dependencies/devDependencies/peer/optional), transitively.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPONENTS = {
  wolfd: "@wolfpack/harness",
  workerd: "@wolfpack/workerd",
  hubd: "@wolfpack/hubd",
  console: "@wolfpack/console",
};
const ROOT_CONFIG = [/^package-lock\.json$/, /^package\.json$/, /^tsconfig[^/]*\.json$/, /^vitest\.(config|setup)\.[cm]?[jt]s$/, /^turbo\.json$/, /^\.github\/workflows\//, /^scripts\/affected\./];
const DOC = [/\.md$/i, /^docs\//, /^LICENSE/, /^ATTRIBUTION/];
const ZERO = /^0+$/;

/** Workspaces: [{name, dir, deps:[workspace names], inTsRoot}] from the root package.json globs. */
export function loadWorkspaces(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dirs = [];
  for (const g of rootPkg.workspaces ?? []) {
    if (!g.endsWith("/*")) { dirs.push(g); continue; }
    const base = g.slice(0, -2);
    if (!existsSync(join(root, base))) continue;
    for (const d of readdirSync(join(root, base), { withFileTypes: true })) if (d.isDirectory() && existsSync(join(root, base, d.name, "package.json"))) dirs.push(`${base}/${d.name}`);
  }
  const pkgs = dirs.map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) }));
  const names = new Set(pkgs.map((p) => p.pkg.name));
  const tsRoot = existsSync(join(root, "tsconfig.json")) ? JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")).references?.map((r) => r.path.replace(/^\.\//, "")) ?? [] : [];
  return pkgs.map(({ dir, pkg }) => ({
    name: pkg.name,
    dir,
    deps: [...new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {})))].filter((d) => names.has(d)),
    inTsRoot: tsRoot.includes(dir),
    hasTest: !!pkg.scripts?.test,
  }));
}

/** Pure: changed files (or null = unknown) + workspaces -> result. */
export function computeAffected(changed, workspaces) {
  const all = changed === null || changed.some((f) => ROOT_CONFIG.some((r) => r.test(f)));
  const files = (changed ?? []).filter((f) => !DOC.some((r) => r.test(f)));
  const hit = new Set();
  if (all) workspaces.forEach((w) => hit.add(w.name));
  else for (const f of files) for (const w of workspaces) if (f === w.dir || f.startsWith(w.dir + "/")) hit.add(w.name);
  // transitive dependents
  for (let grew = true; grew; ) {
    grew = false;
    for (const w of workspaces) if (!hit.has(w.name) && w.deps.some((d) => hit.has(d))) (hit.add(w.name), (grew = true));
  }
  const packages = workspaces.filter((w) => hit.has(w.name)).map((w) => w.name).sort();
  const components = Object.entries(COMPONENTS).filter(([, p]) => hit.has(p)).map(([c]) => c);
  const has = (re) => all || files.some((f) => re.test(f));
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const dirs = (f) => packages.map((n) => byName.get(n)).filter(f).map((w) => w.dir);
  const tracerPk = ["@wolfpack/hubd", "@wolfpack/workerd", "@wolfpack/harness"];
  return {
    all,
    changedFiles: changed ?? null,
    packages,
    components,
    /** `tsc --build` targets: affected packages that are root TS references (all => the root project). */
    tsProjects: all ? ["."] : dirs((w) => w.inTsRoot),
    /** vitest path filters for affected packages (all => whole suite). */
    vitestPaths: all ? [] : dirs((w) => w.inTsRoot).map((d) => `${d}/src`),
    /** root-level vitest suites outside packages/ */
    extensionsTests: has(/^extensions\//) || packages.includes("@wolfpack/harness") || packages.includes("@wolfpack/memory"),
    scriptsTests: has(/^scripts\/[^/]*\.test\.ts$|^scripts\/(runtime-update|dev-stack-extensions)\./),
    consoleTests: hit.has("@wolfpack/console"),
    tracer: tracerPk.some((p) => hit.has(p)) || has(/^infra\/tracer\//),
    release: has(/^infra\/release\//) || has(/^scripts\/[^/]*release[^/]*$/) || has(/^package-lock\.json$/),
  };
}

export function changedFiles(base, head, cwd) {
  if (!base || ZERO.test(base) || !head) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", "--no-renames", base, head], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  } catch {
    return null; // base not in the clone (force-push, shallow): be safe, mark everything
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [base, head, flag] = process.argv.slice(2);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = computeAffected(changedFiles(base, head, root), loadWorkspaces(root));
  console.log(JSON.stringify(result, null, 2));
  if (flag === "--github-output" && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `affected=${JSON.stringify(result)}\n`);
}
