#!/usr/bin/env node
/**
 * Build the standalone console server (apps/console, Next.js output: "standalone") into ONE self-contained directory that runs with
 * plain `node server.js` on node 22 (linux or mac, same arch as the build host for native deps).
 *
 *   node scripts/build-server.mjs [--out <dir>] [--skip-build]      default out: dist/console
 *   NEXT_PUBLIC_WOLFPACK_HUB_URL=https://host/hub node scripts/build-server.mjs   (build-time only, see below)
 *
 * Output layout (the monorepo trace is rooted at the repo root):
 *   <out>/server.js                      shim: loads apps/console/server.js (so `node server.js` works from <out>)
 *   <out>/apps/console/server.js         Next's standalone server (chdirs to its own dir)
 *   <out>/apps/console/.next/static      copied in (Next does not trace it)
 *   <out>/apps/console/public            copied in
 *   <out>/node_modules                   traced runtime deps (hoisted)
 *   <out>/VERSION                        "<console version>+<short sha>"
 * Run:  PORT=3210 HOSTNAME=127.0.0.1 WOLFPACK_HUB_URL=http://127.0.0.1:3150 node server.js
 *
 * Configuration is RUNTIME env except one build-time value:
 *   WOLFPACK_HUB_URL / WOLFPACK_HUB_TOKEN / WOLFPACK_API_URL ... read by the server at runtime (nothing is baked in; no secrets here).
 *   NEXT_PUBLIC_WOLFPACK_HUB_URL ... only the /pair page's "open the hub pairing page" link; inlined by Next at BUILD time.
 * No base path: the console uses absolute "/api/..." and "/" URLs, so it must be served at the root of its origin.
 * `next dev` for local work is untouched (this script only adds a build step and a copy).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const APP = path.join(REPO, "apps", "console");
const STANDALONE = path.join(APP, ".next", "standalone");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const die = (m) => { console.error(`[build-server] ${m}`); process.exit(1); };
const outIdx = args.indexOf("--out");
if (outIdx >= 0 && (!args[outIdx + 1] || args[outIdx + 1].startsWith("--"))) die("--out needs a directory");
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(REPO, "dist", "console"));
// OUT is rmSync'd below: never let it be (or contain) the repo, the app, or the cwd.
for (const [what, p] of [["the repo root", REPO], ["apps/console", APP], ["the current directory", process.cwd()]]) {
	const rel = path.relative(OUT, p);
	if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) die(`REFUSING --out ${OUT}: it equals or contains ${what} (${p})`);
}
if (OUT === path.parse(OUT).root) die("REFUSING --out /");

if (!flag("--skip-build")) {
	fs.rmSync(path.join(APP, ".next"), { recursive: true, force: true }); // deterministic: never reuse a stale trace
	// Scrubbed env: nothing from the caller's shell (tokens, API keys, WOLFPACK_*) can be inlined into the client bundle.
	const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
	if (process.env.NEXT_PUBLIC_WOLFPACK_HUB_URL) env.NEXT_PUBLIC_WOLFPACK_HUB_URL = process.env.NEXT_PUBLIC_WOLFPACK_HUB_URL;
	execFileSync("npx", ["next", "build"], { cwd: APP, stdio: "inherit", env });
}
const srv = path.join(STANDALONE, "apps", "console");
if (!fs.existsSync(path.join(srv, "server.js"))) die("apps/console/.next/standalone/apps/console/server.js missing; the build failed or output: 'standalone' is off");
if (!fs.existsSync(path.join(APP, ".next", "static"))) die(".next/static missing; the build looks incomplete");

// Nothing secret-shaped may be inlined into the client bundle (.next/static) or sit in the server output (.next/server: prerendered HTML/RSC, chunks, maps).
const walk = (dir, fn) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, fn);
		else fn(p, e);
	}
};
// VALUE shapes: a literal credential, wherever it is.
const VALUE_NEEDLES = [
	["a literal bearer token", /Bearer [A-Za-z0-9._~+\/=-]{16,}/], // `Bearer ${token}` in the fetch wrapper is not followed by a literal
	["an sk-ant- key", /sk-ant-[A-Za-z0-9_-]{16,}/],
	["an sk- key", /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/],
	["a GitHub token (ghp_)", /ghp_[A-Za-z0-9]{20,}/],
	["a GitHub fine-grained token (github_pat_)", /github_pat_[A-Za-z0-9_]{20,}/],
	["an AWS access key id (AKIA)", /AKIA[0-9A-Z]{16}/],
];
// NAME needles: the env var names of our credentials. Legitimate in SERVER code (console-client reads WOLFPACK_HUB_TOKEN, the engine reads
// OAUTH_TOKEN), so they are checked in the browser bundle only, where their presence means a build-time inline.
// (ghp_ / github_pat_ / AKIA are prefixes, not names: bare substrings occur in library code, so they are matched only in VALUE form above.)
const NAME_NEEDLES = ["WOLFPACK_HUB_TOKEN", "OAUTH_TOKEN", "sk-ant-"];
const SCAN_EXT = /\.(js|mjs|cjs|css|html|rsc|body|json|map|txt|segment)$/;
const scan = (root, names) => {
	if (!fs.existsSync(root)) return;
	walk(root, (p) => {
		if (!SCAN_EXT.test(p)) return;
		const t = fs.readFileSync(p, "utf8");
		for (const [what, re] of VALUE_NEEDLES) if (re.test(t)) die(`REFUSING: ${what} in ${path.relative(APP, p)}`);
		if (names) for (const n of NAME_NEEDLES) if (t.includes(n)) die(`REFUSING: ${n} found in ${path.relative(APP, p)} (a secret or its name was inlined into the client bundle)`);
	});
};
scan(path.join(APP, ".next", "static"), true);
scan(path.join(APP, ".next", "server"), false);

// Prerendered routes are baked at BUILD time, so anything they read (env, files, the hub) would be frozen into static HTML. Only these may be
// prerendered; every one is a static shell with no data fetch (verified 2026-11 from the build output):
//   /            the (home) layout's client graph shell; data arrives client-side through /api
//   /pair        client page: reads location.hash, no server data
//   /pipeline    static shell, data via /api
//   /settings    static shell, data via /api
//   /_not-found, /_global-error   Next's framework error pages
// Any new prerendered route (a page that forgot `dynamic = "force-dynamic"`) fails the build until it is reviewed and added here.
const PRERENDER_ALLOWLIST = new Set(["/", "/pair", "/pipeline", "/settings", "/_not-found", "/_global-error"]);
{
	const mf = path.join(APP, ".next", "prerender-manifest.json");
	if (!fs.existsSync(mf)) die(".next/prerender-manifest.json missing");
	const m = JSON.parse(fs.readFileSync(mf, "utf8"));
	const extra = [...Object.keys(m.routes ?? {}), ...Object.keys(m.dynamicRoutes ?? {})].filter((r) => !PRERENDER_ALLOWLIST.has(r));
	if (extra.length) die(`REFUSING: unexpected prerendered route(s): ${extra.join(", ")} (add \`export const dynamic = "force-dynamic"\`, or review and extend PRERENDER_ALLOWLIST)`);
}

// Safety: the trace sweep must not carry session data or dev secrets (see next.config.ts).
for (const bad of ["data", "auth.json", ".env", ".env.local"]) {
	for (const base of [STANDALONE, srv]) if (fs.existsSync(path.join(base, bad))) die(`REFUSING: standalone contains ${path.relative(STANDALONE, path.join(base, bad))} (check outputFileTracingExcludes)`);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
// verbatimSymlinks: Next writes RELATIVE links (.next/node_modules/<pkg>-<hash> -> ../../../../../node_modules/<pkg>); the default cpSync would resolve them
// to absolute paths into the build tree (dangling anywhere else). The audit below still verifies every link resolves inside the payload.
fs.cpSync(STANDALONE, OUT, { recursive: true, verbatimSymlinks: true });
const outSrv = path.join(OUT, "apps", "console");
fs.cpSync(path.join(APP, ".next", "static"), path.join(outSrv, ".next", "static"), { recursive: true });
if (fs.existsSync(path.join(APP, "public"))) fs.cpSync(path.join(APP, "public"), path.join(outSrv, "public"), { recursive: true });
// Build-only payload the trace sweeps in (same curation as the desktop shell; never broader, that breaks externals).
for (const extra of ["dist", path.join("node_modules", "electron")]) fs.rmSync(path.join(OUT, extra), { recursive: true, force: true });
// Whole-payload audit: no env files, no auth.json, no data/ dir outside node_modules; every symlink resolves inside the payload.
const realOut = fs.realpathSync(OUT);
const audit = (dir, inNodeModules) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		const rel = path.relative(OUT, p);
		if (/^\.env/.test(e.name)) die(`REFUSING: env file in the payload: ${rel}`);
		if (e.name === "auth.json") die(`REFUSING: auth.json in the payload: ${rel}`);
		if (e.isSymbolicLink()) {
			let real;
			try { real = fs.realpathSync(p); } catch { die(`dangling symlink in payload: ${rel}`); }
			if (real !== realOut && !real.startsWith(realOut + path.sep)) die(`symlink escapes the payload: ${rel} -> ${real}`);
			continue;
		}
		if (e.isDirectory()) {
			if (e.name === "data" && !inNodeModules) die(`REFUSING: data/ directory in the payload: ${rel}`);
			audit(p, inNodeModules || e.name === "node_modules");
		}
	}
};
audit(OUT, false);
fs.writeFileSync(path.join(OUT, "server.js"), `// shim: run the standalone console from the payload root\nimport "./apps/console/server.js";\n`);
fs.writeFileSync(path.join(OUT, "package.json"), '{"private":true,"type":"module"}\n'); // self-contained: never inherit a parent package.json
let sha = "nogit";
try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
const ver = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(OUT, "VERSION"), `${ver}+${sha}\n`);
console.log(`[build-server] ready: ${OUT} (${ver}+${sha}); run: cd ${path.relative(process.cwd(), OUT) || "."} && node server.js`);
