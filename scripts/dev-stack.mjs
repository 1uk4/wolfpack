#!/usr/bin/env node
/**
 * Dev stack from the CURRENT checkout against a throwaway sandbox wolves folder, alongside the live stack.
 *   pnpm run dev:stack [-- --app console|none]
 * Env: DEV_WOLVES_DIR (default ~/wolves/dev-sandbox), DEV_WORKERD_PORT (7151), DEV_CONSOLE_PORT (3220),
 *      DEV_STACK_SKIP_BUILD=1 (skip the turbo build), WOLFPACK_MODELS_FILE (override the scaffolded models.json).
 * Never touches ~/wolves/local: sandbox paths that are, contain or sit inside it are refused (symlink/case aliases too), as are the live ports.
 * The child env drops the WOLF_ and WOLFPACK_ vars and runs with HOME=<sandbox>/.home, so ~/.wolfpack (hub, sockets, slots) is not shared.
 * First run scaffolds one minimal wolf ("sandbox"): wolf.yaml, AGENTS.md, den/, agent/, and a copy of a models.json
 * (tier/provider config only, no secrets) taken from a live wolf. Secrets come from $WOLFPACK_HOME/.env (default
 * ~/.wolfpack/.env) and your Claude login (CLAUDE_CONFIG_DIR). HOME is the sandbox, so git identity and ~/.npmrc are not shared. The pnpm store and corepack's pnpm download are: childEnv points PNPM_CONFIG_STORE_DIR and COREPACK_HOME at the real home, or the sandbox would install a second copy of everything.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { liveWolvesDir, packHome } from "./live-paths.mjs";

export const APPS = ["console", "none"];
export const LIVE_PORTS = [7141, 3210];

export function parseArgs(argv) {
	let app = "console";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--app") app = argv[++i];
		else if (a.startsWith("--app=")) app = a.slice(6);
		else throw new Error(`unknown option "${a}" (usage: dev:stack [--app console|none])`);
	}
	if (!APPS.includes(app)) throw new Error(`--app must be one of ${APPS.join("|")}, got "${app}"`);
	return { app };
}

const port = (name, v, dflt) => {
	const n = Number(v ?? dflt);
	if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`bad ${name} "${v}"`);
	if (LIVE_PORTS.includes(n)) throw new Error(`${name}=${n} is a live-stack port; pick another`);
	return n;
};

/** Resolve through symlinks (and on-disk case, APFS) as far as the path exists, so no alias of ~/wolves/local passes the guard. */
const real = (p) => {
	const abs = path.resolve(p);
	const rest = [];
	for (let cur = abs; ; cur = path.dirname(cur)) {
		try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch { rest.push(path.basename(cur)); }
		if (cur === path.dirname(cur)) return abs;
	}
};

/** Throws unless `dir` is safely outside the live wolves folder (neither equal, inside, nor an ancestor of it). */
export function assertSandboxDir(dir, home = os.homedir(), env = {}) {
	const d = real(dir);
	const live = real(liveWolvesDir(env, home));
	const rel = (a, b) => { const r = path.relative(a.toLowerCase(), b.toLowerCase()); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
	if (rel(live, d) || rel(d, live)) throw new Error(`refusing sandbox dir ${d}: it is, contains or is inside the live wolves folder ${live}`);
	if (d === path.parse(d).root || d === real(home)) throw new Error(`refusing sandbox dir ${d}: too broad`);
	return d;
}

export function resolveConfig(env = process.env, home = os.homedir()) {
	const wolves = assertSandboxDir(env.DEV_WOLVES_DIR || path.join(home, "wolves/dev-sandbox"), home, env);
	const workerdPort = port("DEV_WORKERD_PORT", env.DEV_WORKERD_PORT, 7151);
	const consolePort = port("DEV_CONSOLE_PORT", env.DEV_CONSOLE_PORT, 3220);
	if (workerdPort === consolePort) throw new Error("workerd and console ports must differ");
	return { wolves, workerdPort, consolePort, home, sandboxHome: path.join(wolves, ".home") };
}

/** The pack .env parsed by node's own parser (the same one the live service uses via --env-file); empty when absent. */
export function parseEnvFile(file) {
	try { return parseEnv(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

/**
 * Child env: the caller's env minus every WOLF_* / WOLFPACK_* (except the models file), plus the pack .env secrets (same
 * filter), then the sandbox values. HOME points inside the sandbox, which is what wolfd/workerd resolve ~/.wolfpack
 * (hub link, run sockets, subagent slots) from, so nothing lands in the live pack dir. Claude's own config stays
 * reachable via CLAUDE_CONFIG_DIR (the subscription login).
 */
/** Where pnpm keeps its package store and corepack its downloaded pnpm, for the REAL home (not the sandbox HOME). */
export function sharedToolDirs(env, home) {
	const xdgData = env.XDG_DATA_HOME || path.join(home, ".local/share");
	const xdgCache = env.XDG_CACHE_HOME || path.join(home, ".cache");
	return {
		PNPM_CONFIG_STORE_DIR: env.PNPM_CONFIG_STORE_DIR || (process.platform === "darwin" ? path.join(home, "Library/pnpm/store") : path.join(xdgData, "pnpm/store")),
		COREPACK_HOME: env.COREPACK_HOME || path.join(xdgCache, "node/corepack"),
	};
}

export function childEnv(cfg, env, dotenv = {}, models) {
	const keep = ([k]) => !/^(WOLF_|WOLFPACK_)/.test(k) || k === "WOLFPACK_MODELS_FILE";
	const out = { ...Object.fromEntries(Object.entries(env).filter(keep)), ...Object.fromEntries(Object.entries(dotenv).filter(keep)) };
	return {
		...out,
		...(models ? { WOLFPACK_MODELS_FILE: models } : {}),
		HOME: cfg.sandboxHome,
		...sharedToolDirs(env, cfg.home),
		CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || path.join(cfg.home, ".claude"),
		WORKERD_CONFIG_DIR: path.join(cfg.sandboxHome, ".wolfpack/workerd"),
		WOLFPACK_API_URL: `http://127.0.0.1:${cfg.workerdPort}`,
	};
}

export function wolfYaml(name, dir) {
	const id = crypto.randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 6);
	return `# Scaffolded by \`pnpm run dev:stack\`: minimal sandbox wolf, no memory/KB, no secrets.
id: ${id}
name: ${name}
domains: []
identity: ${path.join(dir, "agent/AGENTS.md")}
workspace: ${path.join(dir, "workspace")}
extensions: []
models:
  smart:
    provider: claude-stateless
    model: claude-sonnet-5-5
`;
}

/** Create the sandbox wolf if the folder has none. Returns the wolf dir, or undefined if wolves already exist. */
export function scaffold(cfg, modelsSource) {
	fs.mkdirSync(cfg.wolves, { recursive: true });
	const existing = fs.readdirSync(cfg.wolves).filter((n) => fs.existsSync(path.join(cfg.wolves, n, "wolf.yaml")));
	if (existing.length) return undefined;
	const dir = path.join(cfg.wolves, "sandbox");
	for (const sub of ["den", "agent", "workspace", "logs"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
	fs.writeFileSync(path.join(dir, "wolf.yaml"), wolfYaml("sandbox", dir));
	fs.writeFileSync(path.join(dir, "agent/AGENTS.md"), "# sandbox\n\nYou are a throwaway test wolf in the dev sandbox. Be brief.\n");
	if (modelsSource && fs.existsSync(modelsSource)) fs.copyFileSync(modelsSource, path.join(dir, "models.json"));
	return dir;
}

export function findModelsSource(home = os.homedir(), env = process.env) {
	const live = liveWolvesDir(env, home);
	try {
		for (const n of fs.readdirSync(live)) { const f = path.join(live, n, "models.json"); if (fs.existsSync(f)) return f; }
	} catch { /* none */ }
	return undefined;
}

export function main(argv, env = process.env) {
	const { app } = parseArgs(argv);
	const cfg = resolveConfig(env);
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const made = scaffold(cfg, env.WOLFPACK_MODELS_FILE || findModelsSource(cfg.home, env));
	if (made) console.log(`dev-stack: scaffolded ${made}`);
	const wolfDirs = fs.readdirSync(cfg.wolves).map((n) => path.join(cfg.wolves, n)).filter((d) => fs.existsSync(path.join(d, "wolf.yaml")));
	const models = env.WOLFPACK_MODELS_FILE || wolfDirs.map((d) => path.join(d, "models.json")).find((f) => fs.existsSync(f));
	fs.mkdirSync(path.join(cfg.sandboxHome, ".wolfpack/workerd"), { recursive: true });
	const baseEnv = childEnv(cfg, env, parseEnvFile(path.join(packHome(env, cfg.home), ".env")), models);
	console.log(`dev-stack: DEV (not live)  checkout=${root}\n  wolves=${cfg.wolves}  workerd=:${cfg.workerdPort}  app=${app}${app === "none" ? "" : ` console=:${cfg.consolePort}`}`);
	if (env.DEV_STACK_SKIP_BUILD === "1") {
		if (!fs.existsSync(path.join(root, "packages/workerd/dist/bin/workerd.js"))) throw new Error("DEV_STACK_SKIP_BUILD=1 but workerd.js is not built");
	} else {
		const b = spawnSync("pnpm", ["exec", "turbo", "run", "build", "--filter=@wolfpack/harness", "--filter=@wolfpack/workerd", "--filter=@wolfpack/cli", "--output-logs=errors-only"], { cwd: root, stdio: "inherit" });
		if (b.status !== 0) throw new Error("build failed");
	}
	const kids = [];
	let stopping = false;
	// Each child gets its own process group (detached) so we can kill the whole tree (next dev, electron, wolfd...).
	const run = (name, cmd, args, extraEnv = {}) => {
		const c = spawn(cmd, args, { cwd: root, stdio: "inherit", detached: true, env: { ...baseEnv, ...extraEnv } });
		kids.push(c);
		c.on("exit", (code) => { if (!stopping) { console.error(`dev-stack: ${name} exited (${code}); stopping`); stop(code ?? 1); } });
	};
	const killAll = (sig) => kids.forEach((c) => { try { process.kill(-c.pid, sig); } catch { /* gone */ } });
	const stop = (code = 0) => {
		if (stopping) return;
		stopping = true;
		killAll("SIGTERM");
		const t = setTimeout(() => { killAll("SIGKILL"); process.exit(code); }, 8000);
		let left = kids.filter((c) => c.exitCode === null && c.signalCode === null).length;
		if (!left) process.exit(code);
		kids.forEach((c) => c.on("exit", () => { if (--left <= 0) { clearTimeout(t); process.exit(code); } }));
	};
	process.on("SIGINT", () => stop(0));
	process.on("SIGTERM", () => stop(0));
	process.on("SIGHUP", () => stop(0));

	run("workerd", process.execPath, [path.join(root, "packages/workerd/dist/bin/workerd.js"), "--wolves", cfg.wolves, "--port", String(cfg.workerdPort)]);
	if (app === "console") run("console", "pnpm", ["--filter", "@wolfpack/console", "run", "dev", "-p", String(cfg.consolePort)], { CONSOLE_PORT: String(cfg.consolePort) });
	console.log("dev-stack: Ctrl-C stops everything");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	try { main(process.argv.slice(2)); } catch (e) { console.error(`dev-stack: ${e.message}`); process.exit(1); }
}
