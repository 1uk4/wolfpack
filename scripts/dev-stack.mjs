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
/** Live ports: workerd 7141, the standalone console build 3210, the `wolfpack preview` console 3230 and the agent preview slots 3231-3234. */
export const LIVE_PORTS = [7141, 3210, 3230, 3231, 3232, 3233, 3234];

export const ACTIONS = ["start", "stop", "status"];

/**
 * `[start|stop|status] [--app console|none]`. No action: run in the foreground (Ctrl-C stops). → {app, action?, sandbox?}
 * `--sandbox <dir>` is what `start` passes to its detached runner: it puts the sandbox dir on the runner's command line, so
 * `isOurs` can tell this sandbox's runner from another's, and the runner refuses to start if it does not match its config.
 */
export function parseArgs(argv) {
	let app = "console";
	let action;
	let sandbox;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (i === 0 && ACTIONS.includes(a)) action = a;
		else if (a === "--app") app = argv[++i];
		else if (a.startsWith("--app=")) app = a.slice(6);
		else if (a === "--sandbox" && argv[i + 1]) sandbox = argv[++i];
		else throw new Error(`unknown option "${a}" (usage: dev:stack [start|stop|status] [--app console|none])`);
	}
	if (!APPS.includes(app)) throw new Error(`--app must be one of ${APPS.join("|")}, got "${app}"`);
	return { app, ...(action ? { action } : {}), ...(sandbox ? { sandbox } : {}) };
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

/** Runner record and log of a detached dev stack: both inside the sandbox, never in ~/.wolfpack or the live wolves folder. */
export const runFiles = (cfg) => ({ pidFile: path.join(cfg.wolves, ".dev-stack.json"), log: path.join(cfg.wolves, "logs", "dev-stack.log") });

const SELF = fileURLToPath(import.meta.url);
/** How long `stop` waits for the runner to exit after SIGTERM (the runner gives its children 8 s), and how often it looks. */
export const STOP_WAIT_MS = 10000;
const STOP_POLL_MS = 250;
/** How long `start` waits before checking that the runner is still alive. */
export const START_CHECK_MS = 1000;

/**
 * The real side effects for `control`: a detached foreground runner, a ps check that a pid is still our dev-stack.mjs
 * running for THIS sandbox (`--sandbox <dir>` on its command line), a signal, and a blocking sleep.
 */
export function realControlDeps(env = process.env) {
	return {
		spawnDetached: (args, log) => {
			fs.mkdirSync(path.dirname(log), { recursive: true });
			const fd = fs.openSync(log, "a");
			const c = spawn(process.execPath, [SELF, ...args], { detached: true, stdio: ["ignore", fd, fd], env });
			c.unref();
			fs.closeSync(fd);
			return c.pid;
		},
		isOurs: (pid, cfg) => {
			const r = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
			const cmd = (r.stdout ?? "").trim();
			return r.status === 0 && /\bnode\b/.test(cmd) && cmd.includes(SELF) && (cmd.endsWith(` --sandbox ${cfg.wolves}`) || cmd.includes(` --sandbox ${cfg.wolves} `));
		},
		kill: (pid, sig) => { try { process.kill(pid, sig); } catch { /* gone */ } },
		sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
		say: (m) => console.log(m),
	};
}

/**
 * start | stop | status for a detached dev stack (what a worker uses: no terminal to Ctrl-C). start spawns this script in
 * foreground mode as its own session, logging to <sandbox>/logs/dev-stack.log, and records its pid in <sandbox>/.dev-stack.json.
 * After START_CHECK_MS it checks the runner is still alive; if not it reports that and points to the log. (It does not wait
 * for the ports: the runner builds first, which takes longer than a quick check.)
 * stop SIGTERMs that runner (it stops workerd and the console itself), only after ps shows the pid is still our runner for
 * this sandbox, then waits up to STOP_WAIT_MS for it to exit. The pid file is removed only once it is gone.
 * Returns {running, pid?, log}: after start, running=false means it died; after stop, running=true means it did not exit.
 */
export function control(action, cfg, opts = {}, d = realControlDeps()) {
	const { pidFile, log } = runFiles(cfg);
	let rec;
	try { rec = JSON.parse(fs.readFileSync(pidFile, "utf8")); } catch { /* none */ }
	const ours = (pid) => d.isOurs(pid, cfg);
	const alive = rec?.pid && ours(rec.pid) ? rec : undefined;
	if (action === "status") {
		d.say(alive ? `dev-stack: running (pid ${alive.pid}) workerd=:${cfg.workerdPort} console=:${cfg.consolePort}  log ${log}` : "dev-stack: not running");
		return alive ? { running: true, pid: alive.pid, log } : { running: false, log };
	}
	if (action === "stop") {
		if (!alive) {
			fs.rmSync(pidFile, { force: true });
			d.say("dev-stack: not running");
			return { running: false, log };
		}
		d.kill(alive.pid, "SIGTERM");
		for (let waited = 0; ours(alive.pid) && waited < STOP_WAIT_MS; waited += STOP_POLL_MS) d.sleep(STOP_POLL_MS);
		if (ours(alive.pid)) {
			d.say(`dev-stack: still running ${STOP_WAIT_MS / 1000} s after SIGTERM (pid ${alive.pid}); see ${log}, or kill it: kill ${alive.pid}`);
			return { running: true, pid: alive.pid, log };
		}
		fs.rmSync(pidFile, { force: true });
		d.say(`dev-stack: stopped (pid ${alive.pid})`);
		return { running: false, log };
	}
	if (alive) {
		d.say(`dev-stack: already running (pid ${alive.pid}); log ${log}`);
		return { running: true, pid: alive.pid, log };
	}
	const app = opts.app ?? "console";
	const pid = d.spawnDetached(["--app", app, "--sandbox", cfg.wolves], log);
	fs.mkdirSync(cfg.wolves, { recursive: true });
	fs.writeFileSync(pidFile, `${JSON.stringify({ pid, app, workerdPort: cfg.workerdPort, consolePort: cfg.consolePort, startedAt: new Date().toISOString() })}\n`);
	d.sleep(START_CHECK_MS);
	if (!ours(pid)) {
		fs.rmSync(pidFile, { force: true });
		d.say(`dev-stack: the runner (pid ${pid}) exited within ${START_CHECK_MS / 1000} s; see the log: ${log}`);
		return { running: false, log };
	}
	d.say(`dev-stack: started (pid ${pid}) workerd=:${cfg.workerdPort}${app === "none" ? "" : ` console=:${cfg.consolePort}`}  log ${log}  stop: pnpm dev:stack stop`);
	return { running: true, pid, log };
}

/** → exit code: 1 when `start` saw the runner die or `stop` could not stop it; 0 otherwise (also for the foreground run). */
export function main(argv, env = process.env) {
	const { app, action, sandbox } = parseArgs(argv);
	const cfg = resolveConfig(env);
	if (sandbox && real(sandbox) !== cfg.wolves) throw new Error(`--sandbox ${sandbox} does not match the configured sandbox ${cfg.wolves}`);
	if (action) {
		const r = control(action, cfg, { app }, realControlDeps(env));
		return (action === "start" && !r.running) || (action === "stop" && r.running) ? 1 : 0;
	}
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
		const b = spawnSync(process.execPath, ["scripts/turbo.mjs", "run", "build", "--filter=@wolfpack/harness", "--filter=@wolfpack/workerd", "--filter=@wolfpack/cli", "--output-logs=errors-only"], { cwd: root, stdio: "inherit" });
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
	return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`dev-stack: ${e.message}`); process.exit(1); }
}
