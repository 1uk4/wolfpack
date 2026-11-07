#!/usr/bin/env node
// Guards the two lockfiles the repo keeps while npm still builds the release and pnpm is for dev and CI.
//   node scripts/check-lockfiles.mjs [repo-path]      (also: pnpm check:lockfiles)    exit 1 on any problem
// 1. package-lock.json must be what `npm install --package-lock-only --ignore-scripts` writes for the current package.json files.
//    That runs in a temp copy (package.json files + the existing lock + .npmrc); the checked-in lock is never touched.
//    It needs the npm registry only when the lock is stale.
// 2. pnpm-lock.yaml and package-lock.json must resolve the same version(s) for every package name.
//    Exception: the git dependency is "pi-claude-bridge-stateless" in npm and "pi-claude-bridge" in pnpm (pnpm names it after the
//    package inside the repo); those are compared by commit sha instead of a version.
// pnpm-lock.yaml against the package.json files is `pnpm install --frozen-lockfile`'s job (CI runs it), not repeated here.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

/** npm lock name -> pnpm lock name, for entries whose two names differ. */
export const NAME_EXCEPTIONS = { "pi-claude-bridge-stateless": "pi-claude-bridge" };
const SHA = /[0-9a-f]{40}/;

export const FIX = [
  "Fix: regenerate both lockfiles from the package.json files and commit them together:",
  "  npm install --package-lock-only --ignore-scripts   (package-lock.json, which the release image installs from)",
  "  pnpm install --lockfile-only                        (pnpm-lock.yaml, which dev and CI install from)",
].join("\n");

function add(map, name, version) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(version);
}

/** package-lock.json text -> Map(name -> Set(version)); git entries are "git:<sha>", workspace packages and links are skipped. */
export function parseNpmLock(text) {
  const out = new Map();
  for (const [key, e] of Object.entries(JSON.parse(text).packages ?? {})) {
    if (!key.includes("node_modules/") || e.link || !e.version) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const git = typeof e.resolved === "string" && /^git/.test(e.resolved) ? e.resolved.match(SHA)?.[0] : undefined;
    add(out, name, git ? `git:${git}` : e.version);
  }
  return out;
}

/** pnpm-lock.yaml text -> Map(name -> Set(version)); URL-resolved entries are "git:<sha>" when the URL carries one. */
export function parsePnpmLock(text) {
  const out = new Map();
  // pnpm writes the packageManager (pnpm itself) env lock as a first YAML document; the project's own lock is the last one
  const docs = parseAllDocuments(text).map((d) => d.toJS());
  const keys = Object.keys(docs[docs.length - 1]?.packages ?? {});
  for (const key of keys) {
    const at = key.indexOf("@", 1);
    if (at < 0) continue;
    const name = key.slice(0, at);
    const ref = key.slice(at + 1);
    const sha = /^(https?|git)/.test(ref) ? ref.match(SHA)?.[0] : undefined;
    add(out, name, sha ? `git:${sha}` : ref);
  }
  return out;
}

const list = (s) => [...s].sort().join(", ");

/** Pure: both lock texts -> problems [{kind, name, detail}]. */
export function compareLocks(npmText, pnpmText) {
  const npm = parseNpmLock(npmText);
  const pnpm = parsePnpmLock(pnpmText);
  const problems = [];
  const seen = new Set();
  for (const [name, versions] of npm) {
    const other = NAME_EXCEPTIONS[name] ?? name;
    seen.add(other);
    const theirs = pnpm.get(other);
    if (!theirs) { problems.push({ kind: "missing-in-pnpm", name, detail: `${name} (${list(versions)}) is in package-lock.json but not in pnpm-lock.yaml` }); continue; }
    if (list(versions) !== list(theirs)) problems.push({ kind: "version-mismatch", name, detail: `${name}: package-lock.json has ${list(versions)}, pnpm-lock.yaml has ${list(theirs)}` });
  }
  for (const [name, versions] of pnpm) if (!seen.has(name)) problems.push({ kind: "missing-in-npm", name, detail: `${name} (${list(versions)}) is in pnpm-lock.yaml but not in package-lock.json` });
  return problems;
}

function workspaceDirs(root) {
  const globs = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? [];
  const dirs = [];
  for (const g of globs) {
    if (!g.endsWith("/*")) { dirs.push(g); continue; }
    const base = g.slice(0, -2);
    if (!existsSync(join(root, base))) continue;
    for (const d of readdirSync(join(root, base), { withFileTypes: true })) if (d.isDirectory() && existsSync(join(root, base, d.name, "package.json"))) dirs.push(`${base}/${d.name}`);
  }
  return dirs;
}

/** What npm would write for `root`'s package.json files, starting from its existing lock. Works in a temp copy; returns the lock text. */
export function regenerateNpmLock(root) {
  const tmp = mkdtempSync(join(tmpdir(), "lockcheck-"));
  try {
    for (const f of ["package.json", "package-lock.json", ".npmrc"]) if (existsSync(join(root, f))) cpSync(join(root, f), join(tmp, f));
    for (const d of workspaceDirs(root)) { mkdirSync(join(tmp, d), { recursive: true }); cpSync(join(root, d, "package.json"), join(tmp, d, "package.json")); }
    const r = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tmp, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, npm_config_update_notifier: "false" } });
    if (r.error || r.status !== 0) throw new Error(`npm install --package-lock-only failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}: ${(r.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
    return readFileSync(join(tmp, "package-lock.json"), "utf8");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function drift(before, after) {
  const a = JSON.parse(before).packages ?? {};
  const b = JSON.parse(after).packages ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/** Both checks on a repo checkout -> problems [{kind, name?, detail}]. `regenerate` is injectable for tests. */
export function checkLockfiles(root, { regenerate = regenerateNpmLock } = {}) {
  const problems = [];
  const npmPath = join(root, "package-lock.json");
  const pnpmPath = join(root, "pnpm-lock.yaml");
  if (!existsSync(npmPath)) return [{ kind: "missing-lock", detail: `package-lock.json is missing.\n${FIX}` }];
  if (!existsSync(pnpmPath)) return [{ kind: "missing-lock", detail: `pnpm-lock.yaml is missing.\n${FIX}` }];
  const current = readFileSync(npmPath, "utf8");
  const regenerated = regenerate(root);
  if (regenerated !== current) {
    const keys = drift(current, regenerated);
    const shown = keys.slice(0, 8).join(", ") + (keys.length > 8 ? `, +${keys.length - 8} more` : "");
    problems.push({ kind: "npm-lock-drift", detail: `package-lock.json is not what \`npm install --package-lock-only --ignore-scripts\` writes for the current package.json files (differing entries: ${shown || "formatting only"}).\n${FIX}` });
  }
  problems.push(...compareLocks(current, readFileSync(pnpmPath, "utf8")));
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? ".";
  let problems;
  try { problems = checkLockfiles(root); } catch (e) { console.error(`check-lockfiles: ${e.message}`); process.exit(2); }
  for (const p of problems) console.log(p.detail);
  if (problems.length) {
    if (!problems.some((p) => p.detail.includes("Fix:"))) console.log(FIX);
    console.error(`${problems.length} lockfile problem(s).`);
    process.exit(1);
  }
  console.log("check-lockfiles: package-lock.json is current and both locks agree");
}
