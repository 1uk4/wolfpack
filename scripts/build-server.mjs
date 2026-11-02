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
const outIdx = args.indexOf("--out");
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(REPO, "dist", "console"));
const die = (m) => { console.error(`[build-server] ${m}`); process.exit(1); };

if (!flag("--skip-build")) {
	fs.rmSync(path.join(APP, ".next"), { recursive: true, force: true }); // deterministic: never reuse a stale trace
	execFileSync("npx", ["next", "build"], { cwd: APP, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
}
const srv = path.join(STANDALONE, "apps", "console");
if (!fs.existsSync(path.join(srv, "server.js"))) die("apps/console/.next/standalone/apps/console/server.js missing; the build failed or output: 'standalone' is off");
if (!fs.existsSync(path.join(APP, ".next", "static"))) die(".next/static missing; the build looks incomplete");

// Safety: the trace sweep must not carry session data or dev secrets (see next.config.ts).
for (const bad of ["data", "auth.json", ".env", ".env.local"]) {
	for (const base of [STANDALONE, srv]) if (fs.existsSync(path.join(base, bad))) die(`REFUSING: standalone contains ${path.relative(STANDALONE, path.join(base, bad))} (check outputFileTracingExcludes)`);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.cpSync(STANDALONE, OUT, { recursive: true });
const outSrv = path.join(OUT, "apps", "console");
fs.cpSync(path.join(APP, ".next", "static"), path.join(outSrv, ".next", "static"), { recursive: true });
if (fs.existsSync(path.join(APP, "public"))) fs.cpSync(path.join(APP, "public"), path.join(outSrv, "public"), { recursive: true });
// Build-only payload the trace sweeps in (same curation as the desktop shell; never broader, that breaks externals).
for (const extra of ["dist", path.join("node_modules", "electron")]) fs.rmSync(path.join(OUT, extra), { recursive: true, force: true });
// Workspace packages resolve through node_modules symlinks; make sure none dangle outside OUT.
for (const e of fs.readdirSync(path.join(OUT, "node_modules"), { recursive: true, withFileTypes: true })) {
	if (e.isSymbolicLink()) {
		const p = path.join(e.parentPath ?? e.path, e.name);
		if (!fs.existsSync(p)) die(`dangling symlink in payload: ${path.relative(OUT, p)}`);
		if (!fs.realpathSync(p).startsWith(fs.realpathSync(OUT))) die(`symlink escapes the payload: ${path.relative(OUT, p)}`);
	}
}
fs.writeFileSync(path.join(OUT, "server.js"), `// shim: run the standalone console from the payload root\nimport "./apps/console/server.js";\n`);
fs.writeFileSync(path.join(OUT, "package.json"), '{"private":true,"type":"module"}\n'); // self-contained: never inherit a parent package.json
let sha = "nogit";
try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
const ver = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(OUT, "VERSION"), `${ver}+${sha}\n`);
console.log(`[build-server] ready: ${OUT} (${ver}+${sha}); run: cd ${path.relative(process.cwd(), OUT) || "."} && node server.js`);
