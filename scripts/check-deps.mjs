#!/usr/bin/env node
// Finds imports (imports only, see "NOT checked") a package uses but does not declare in its own package.json.
//   node scripts/check-deps.mjs [repo-path]      exit 1 when anything is missing
// pnpm's strict layout only lets a package import what it declares; npm hoisting hides the gaps.
// Rules:
//  - scans .ts/.tsx/.mts/.js/.mjs/.cjs under each workspace and under the repo root itself (root files count against the root
//    package.json only; the root scan skips apps/ and packages/ and any nested dir
//    with its own package.json, e.g. extensions/*, which are not workspaces and not checked here), skipping dist, node_modules, .next and fixtures.
//  - counts import/export ... from (multi-line too), side-effect import, dynamic import(), require(), `import x = require()`,
//    require.resolve(), import.meta.resolve(), createRequire(...)("a") and vi.mock/doMock/unmock/importActual/importMock("a"). `import type` counts too:
//    the types package must resolve at typecheck time.
//  - ignores comments and require()/import() calls that sit inside a quoted string (test fixtures), node: and bare builtins, relative paths, and the package's own tsconfig path aliases (e.g. "@/*").
//  - known limit: a line-leading `import ... from` inside a template literal (fixture source) is counted; declare it or move the fixture.
//  - ALLOW lists deliberate exceptions (with a reason); an entry that is no longer imported is reported as stale.
//  - NOT checked (the real pnpm build and typecheck are the backstop): tsconfig `types` and `extends`, bins used in package
//    scripts, and plugin names given as strings in config files. Only imports are looked at.
//  - declared = dependencies, devDependencies, peerDependencies, optionalDependencies of that package.
//  - TEST files (*.test.* / *.spec.* or under __tests__) may also use the ROOT devDependencies (vitest etc.).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["dist", "node_modules", ".next", "fixtures"]);
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const BUILTINS = new Set(builtinModules.map((m) => m.split("/")[0]));
const IMPORT_RES = [
  /^[ \t]*(?:import|export)\s[^"'`;]*?\sfrom\s*["']([^"']+)["']/gm, // import x from "a" / export * from "a" / import type {..} from "a"
  /^[ \t]*import\s*["']([^"']+)["']/gm, // import "a"
  /(?<![\w"'`\/.])import\s*\(\s*["']([^"']+)["']\s*\)/g, // import("a")
  /(?<![\w"'`\/.])require\s*\(\s*["']([^"']+)["']\s*\)/g, // require("a") and `import x = require("a")`
  /(?<![\w"'`\/.])require\.resolve\s*\(\s*["']([^"']+)["']/g, // require.resolve("a")
  /(?<![\w"'`\/.])import\.meta\.resolve\s*\(\s*["']([^"']+)["']/g, // import.meta.resolve("a")
  /(?<![\w"'`\/.])createRequire\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\(\s*["']([^"']+)["']\s*\)/g, // createRequire(import.meta.url)("a")
  /(?<![\w"'`\/.])vi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*["']([^"']+)["']/g, // vitest module lookups
];

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const declared = (pkg) => new Set(FIELDS.flatMap((k) => Object.keys(pkg[k] ?? {})));
const isTestFile = (rel) => /\.(test|spec)\.[^/]+$/.test(rel) || /(^|\/)__tests__\//.test(rel);

function workspaceDirs(root) {
  const dirs = [];
  for (const g of readJson(join(root, "package.json")).workspaces ?? []) {
    if (!g.endsWith("/*")) { dirs.push(g); continue; }
    const base = g.slice(0, -2);
    if (!existsSync(join(root, base))) continue;
    for (const d of readdirSync(join(root, base), { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(root, base, d.name, "package.json"))) dirs.push(`${base}/${d.name}`);
    }
  }
  return dirs;
}

/** `skip` are directory names not to enter (used at the repo root to leave apps/ and packages/ to their own package.json). */
function sourceFiles(dir, skip = new Set(), isRoot = true) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (isRoot && skip.has(e.name))) continue;
      // a nested directory with its own package.json is another package (e.g. extensions/*), not part of this scan
      if (skip.size && existsSync(join(dir, e.name, "package.json"))) continue;
      out.push(...sourceFiles(join(dir, e.name), skip, false));
    }
    else if (SOURCE.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** Alias prefixes from the package's tsconfig `paths`, e.g. "@/*" -> "@/". Exact keys are kept whole. */
function aliasPatterns(pkgDir) {
  const file = join(pkgDir, "tsconfig.json");
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf8");
    let json;
    try { json = JSON.parse(raw); } // plain JSON first: "@/*" would look like a block comment to the stripper below
    catch { json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1")); }
    return Object.keys(json.compilerOptions?.paths ?? {}).map((k) => (k.endsWith("*") ? { prefix: k.slice(0, -1) } : { exact: k }));
  } catch { return []; }
}

/** True when `idx` falls inside a quoted string that opened earlier on the same line (fixture source in tests). */
function insideString(text, idx) {
  let quote = null;
  for (let i = text.lastIndexOf("\n", idx - 1) + 1; i < idx; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; }
    else if (c === '"' || c === "'" || c === "`") quote = c;
  }
  return quote !== null;
}

const stripNonCode = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|\*).*$/gm, "");

/** "@a/b/c" -> "@a/b", "lodash/fp" -> "lodash"; null for relative, node: and builtin specifiers. */
function packageName(spec, aliases) {
  if (!/^@?[\w.~-]+(\/[\w.~@-]+)*\/?$/.test(spec) && !spec.startsWith(".")) return null; // not a specifier (text inside a string or template)
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  if (aliases.some((a) => (a.exact ? spec === a.exact : spec.startsWith(a.prefix)))) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return BUILTINS.has(name) ? null : name;
}

/**
 * Imports that are deliberately not declared: package dir -> { name: reason }.
 * An entry the package no longer imports is reported as stale, so this list cannot rot.
 */
export const ALLOW = {
  "apps/console": {
    "electron-builder": "resolved from apps/desktop via createRequire in the mac-signing and desktop-platform tests",
    "app-builder-lib": "resolved from apps/desktop via createRequire in the mac-signing and desktop-platform tests",
  },
};

/** Returns [{pkg, name, files:[repo-relative]}] for every undeclared import, plus {stale:true, reason} for unused allow-list entries. */
export function checkDeps(root, allow = ALLOW) {
  const rootDev = new Set(Object.keys(readJson(join(root, "package.json")).devDependencies ?? {}));
  const result = [];
  // "." first: root files (scripts/, root configs, extensions/) count against the root package.json only.
  const rootSkip = new Set(["apps", "packages"]);
  for (const dir of [".", ...workspaceDirs(root)]) {
    const pkg = readJson(join(root, dir, "package.json"));
    const own = declared(pkg);
    const aliases = aliasPatterns(join(root, dir));
    const allowed = allow[dir] ?? {};
    const usedAllowed = new Set();
    const missing = new Map(); // name -> Set(files)
    for (const file of sourceFiles(join(root, dir), dir === "." ? rootSkip : undefined)) {
      const rel = relative(root, file).split("\\").join("/");
      const text = stripNonCode(readFileSync(file, "utf8"));
      for (const re of IMPORT_RES) {
        for (const m of text.matchAll(re)) {
          if (!re.source.startsWith("^") && insideString(text, m.index)) continue;
          const name = packageName(m[1], aliases);
          if (!name || name === pkg.name || own.has(name)) continue;
          if (isTestFile(rel) && rootDev.has(name)) continue;
          if (name in allowed) { usedAllowed.add(name); continue; }
          if (!missing.has(name)) missing.set(name, new Set());
          missing.get(name).add(rel);
        }
      }
    }
    for (const [name, files] of [...missing].sort(([a], [b]) => a.localeCompare(b))) result.push({ pkg: pkg.name ?? dir, name, files: [...files].sort() });
    for (const [name, reason] of Object.entries(allowed)) if (!usedAllowed.has(name)) result.push({ pkg: pkg.name ?? dir, name, stale: true, reason, files: [] });
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = checkDeps(process.argv[2] ?? ".");
  for (const m of missing) if (m.stale) console.log(`${m.pkg}: stale allow-list entry "${m.name}" (${m.reason}); remove it from ALLOW in scripts/check-deps.mjs`);
  else console.log(`${m.pkg}: missing "${m.name}" (used in ${m.files.slice(0, 3).join(", ")}${m.files.length > 3 ? `, +${m.files.length - 3} more` : ""})`);
  if (missing.length) { console.error(`${missing.length} problem(s). Test files may use root devDependencies; source files may not.`); process.exit(1); }
  console.log("check-deps: every import is declared");
}
