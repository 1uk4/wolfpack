/**
 * The app's own runtime supervisor (work-wolfpack-wOBXF9f): hubd, workerd and (through workerd) one wolfd per wolf,
 * all children of the Electron main process, all on this Mac, all run with Electron's own Node (ELECTRON_RUN_AS_NODE=1).
 *
 *   const sup = createSupervisor({ stateDir, wolvesDir, runtimeDir, nodeBin, apiKey });
 *   await sup.start();   // first run writes pack state, models.json, the default wolf and the 0600 credential file
 *   sup.urls.workerd     // http://127.0.0.1:<port>  (the wolf's /v1 for the console)
 *   await sup.stop();    // SIGTERM every child, wait, SIGKILL the rest
 *
 * No Electron imports: the module is driven from a plain Node test. `runtimeDir` holds the bundles from
 * scripts/build-runtime.mjs. Ports are free ports picked at start (listen on 0), so the owner's dev stack
 * (7141, 3142, 3150, 3210, 3230) is never in the way. Children get an allowlisted env (no HTTPS_PROXY, no ANTHROPIC_*, no
 * GITHUB_TOKEN from the owner's shell); the API key goes only to workerd (and so to its wolfd), never to argv, and is
 * redacted from any child output we log. The bundles exit by themselves when this process dies (WOLFPACK_EXIT_WITH_PARENT).
 */
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const KEY_FILE = "credentials.json"; // { ANTHROPIC_API_KEY }, mode 0600, in the pack state dir
// Model names live here (and only here): update them in this block when a model is retired.
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

const TAIL_LINES = 20;

const freePort = () =>
	new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});

const tier = (model) => ({ model, modelSource: "default", provider: "anthropic", piModel: `anthropic/${model}` });

/** Sonnet answers the chat; Haiku does memory and curation work. */
function modelsJson() {
	return { location: "local", transport: "api", transportSource: "default", tiers: { main: tier(SONNET), smart: tier(HAIKU), fast: tier(HAIKU) }, steps: {}, warnings: [] };
}

/** Default wolf: memory, KB and work items on, no browser tool. */
function wolfYaml(name, dir) {
	return [
		`id: ${name}`,
		`name: ${name}`,
		"domains: [personal]",
		`workspace: ${path.join(dir, "workspace")}`,
		"extensions: [memory]",
		"memory:",
		"  live: true",
		"  defaultDomain: personal",
		"",
	].join("\n");
}

function writeIfMissing(file, text) {
	if (fs.existsSync(file)) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

/**
 * workerd splits --wolfd on whitespace with no quoting, and the app's state dir has spaces ("Application Support"),
 * so the command cannot be an absolute path there. The shim is a static script in <stateDir>/bin; workerd runs with that
 * folder as its cwd and is told `./wolfd-shim` (workerd's wolfd children inherit its cwd). The shim reads the real
 * node and wolfd paths from env. Written to a temp name then renamed, so a running workerd never sees a half file.
 */
function ensureShim(stateDir) {
	const dir = path.join(stateDir, "bin");
	const file = path.join(dir, "wolfd-shim");
	const body = '#!/bin/sh\nexec "$WOLFPACK_APP_NODE" "$WOLFPACK_APP_WOLFD" "$@"\n';
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) {
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, body, { mode: 0o700 });
		fs.renameSync(tmp, file);
	}
	return { dir, command: "./wolfd-shim" };
}

/** HTTPS_PROXY, HTTP_PROXY, NO_PROXY in both cases, when set in the app's own environment. */
function proxyEnv() {
	const out = {};
	for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) for (const n of [k, k.toLowerCase()]) if (process.env[n]) out[n] = process.env[n];
	return out;
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

function createSupervisor(opts) {
	const { stateDir, wolvesDir, runtimeDir, nodeBin, wolfName = "wolf" } = opts;
	const log = opts.log ?? (() => {});
	// Allowlist, not process.env: nothing from the owner's shell (proxy, ANTHROPIC_*, tokens) reaches a child.
	const base = (extra) => ({
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		HOME: process.env.HOME ?? os.homedir(),
		TMPDIR: os.tmpdir(),
		LANG: process.env.LANG ?? "en_US.UTF-8",
		ELECTRON_RUN_AS_NODE: "1",
		WOLFPACK_EXIT_WITH_PARENT: "1",
		WOLFPACK_HOME: stateDir,
		WORKERD_CONFIG_DIR: path.join(stateDir, "workerd"),
		// App-owned, not dirname(wolvesDir): that is the owner's home, and the root is read by hubd's live-mirror guard and the KB den fallback.
		WOLFPACK_WOLVES_ROOT: path.join(stateDir, "wolves-root"),
		WOLFPACK_WOLVES_DIR: wolvesDir,
		WOLFPACK_KB_OPS: path.join(stateDir, "kb", "ops"),
		...extra,
	});
	const children = new Map();
	let stopping = false; // set by stop(), cleared by the next start(): a quit during start must not respawn anything
	const stoppedError = () => Object.assign(new Error("supervisor stopped"), { stopped: true });
	let secret = "";
	const redact = (s) => (secret ? s.split(secret).join("[redacted]") : s);
	const listeners = new Set();
	let wolfUp = false; // cached: the default wolf is online (set after bring-up, refreshed by a slow poll)
	let lastRunning = false;
	const changed = () => {
		const r = sup.status().running;
		if (r === lastRunning) return;
		lastRunning = r;
		for (const cb of listeners) try { cb(r); } catch { /* a listener must not break the supervisor */ }
	};
	const sup = { urls: {}, ports: {}, wolfDir: path.join(wolvesDir, wolfName), pids: () => [...children.values()].map((c) => c.pid) };

	function setup() {
		const wolfDir = sup.wolfDir;
		for (const d of [stateDir, wolvesDir, path.join(stateDir, "wolves-root"), path.join(stateDir, "kb", "ops"), path.join(stateDir, "kb", "base"), path.join(wolfDir, "workspace"), path.join(wolfDir, "den", "extensions")]) fs.mkdirSync(d, { recursive: true });
		fs.chmodSync(stateDir, 0o700);
		fs.chmodSync(wolfDir, 0o700);
		writeIfMissing(path.join(wolfDir, "models.json"), JSON.stringify(modelsJson(), null, 2));
		writeIfMissing(path.join(wolfDir, "wolf.yaml"), wolfYaml(wolfName, wolfDir));
		const ext = path.join(wolfDir, "den", "extensions", "wolfpack-memory");
		fs.mkdirSync(ext, { recursive: true });
		fs.copyFileSync(path.join(runtimeDir, "extensions", "wolfpack-memory", "index.js"), path.join(ext, "index.js"));
		const keyFile = path.join(stateDir, KEY_FILE);
		if (opts.apiKey) {
			try {
				fs.writeFileSync(keyFile, JSON.stringify({ ANTHROPIC_API_KEY: opts.apiKey }), { mode: 0o600, flag: "wx" });
			} catch (e) {
				if (e.code !== "EEXIST") throw e; // an existing file wins: the wizard (or an earlier run) owns it
			}
		}
		return keyFile;
	}

	function readCredentials(keyFile) {
		if (!fs.existsSync(keyFile)) return {};
		try {
			const v = JSON.parse(fs.readFileSync(keyFile, "utf8"));
			if (v && typeof v === "object") return v;
		} catch {
			/* fall through */
		}
		throw new Error(`${keyFile} is damaged (not a JSON object). Delete it and sign in again.`);
	}

	function launch(name, entry, args, env, cwd) {
		if (stopping) throw stoppedError();
		const child = spawn(nodeBin, [path.join(runtimeDir, entry), ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
		const rec = { name, pid: child.pid, kill: (s) => child.kill(s), tail: [], exited: false, pending: "" };
		children.set(name, rec);
		const onData = (b) => {
			for (const raw of String(b).split("\n")) {
				if (!raw.trim()) continue;
				const l = redact(raw);
				rec.tail.push(l);
				if (rec.tail.length > TAIL_LINES) rec.tail.shift();
				log(`${name}: ${l}`);
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code, sig) => {
			rec.exited = true;
			log(`${name} exited (code=${code} signal=${sig})`);
			children.delete(name);
			if (name === "workerd") wolfUp = false;
			changed();
		});
		return rec;
	}

	/** Poll fn until true. Rejects at once if `rec` (the child being waited on) has exited, with its last output lines. */
	async function until(fn, what, rec, ms = 60_000) {
		const end = Date.now() + ms;
		const fail = (why) => {
			const e = new Error(`${what} ${why}${rec?.tail.length ? `. Last output:\n${rec.tail.join("\n")}` : ""}`);
			e.bind = !!rec && (rec.exited || rec.tail.some((l) => /listen EADDRINUSE/.test(l)));
			return e;
		};
		for (;;) {
			if (stopping) throw stoppedError();
			if (rec?.exited) throw fail("exited before it came up");
			try {
				if (await fn()) return;
			} catch {
				/* not up yet */
			}
			if (rec?.tail.some((l) => /listen EADDRINUSE/.test(l))) throw fail("could not bind its port");
			if (Date.now() > end) throw fail("did not come up");
			await new Promise((r) => setTimeout(r, 150));
		}
	}
	const healthy = (url) => async () => (await fetch(`${url}/healthz`)).ok;

	async function bringUp(keyFile) {
		const creds = readCredentials(keyFile);
		secret = creds.ANTHROPIC_API_KEY ?? "";
		const hubPort = await freePort();
		const workerdPort = await freePort();
		sup.ports = { hubd: hubPort, workerd: workerdPort };
		sup.urls = { hubd: `http://127.0.0.1:${hubPort}`, workerd: `http://127.0.0.1:${workerdPort}` };
		// hubd: the app's own hub. Curator OFF for this slice (ticket F16FFQL owns the gate).
		const hub = launch("hubd", "hubd.mjs", ["serve", "--data-dir", path.join(stateDir, "hub"), "--port", String(hubPort), "--host", "127.0.0.1"], base({ HUBD_CURATOR: "0" }));
		await until(healthy(sup.urls.hubd), "hubd", hub);
		// workerd supervises wolfd through the shim. The wolfd env (incl. the key) is workerd's env.
		// v1: the key stays in wolfd's env, so the wolf's shell tool can read it. It is the user's own key on their own Mac.
		const shim = ensureShim(stateDir);
		const env = base({
			WOLFPACK_APP_NODE: nodeBin,
			WOLFPACK_APP_WOLFD: path.join(runtimeDir, "wolfd", "wolfd.mjs"),
			WOLFPACK_MODELS_FILE: path.join(sup.wolfDir, "models.json"),
			KB_BASE: path.join(stateDir, "kb", "base"),
			KB_OPS: path.join(stateDir, "kb", "ops"),
			...(secret ? { ANTHROPIC_API_KEY: secret } : {}),
			// Documented decision: proxy settings go to workerd (and so its wolfd) only, so a user behind a proxy can reach the model provider. hubd gets none.
			...proxyEnv(),
			...(opts.modelBaseUrl ? { WOLFPACK_ANTHROPIC_BASE_URL: opts.modelBaseUrl } : {}),
		});
		const wd = launch("workerd", "workerd.mjs", ["--wolves", wolvesDir, "--port", String(workerdPort), "--host", "127.0.0.1", "--wolfd", shim.command], env, shim.dir);
		await until(healthy(sup.urls.workerd), "workerd", wd);
		await until(async () => ((await (await fetch(`${sup.urls.workerd}/v1/wolves`)).json()).wolves ?? []).some((w) => w.status === "online"), "the default wolf did not come online", wd);
		wolfUp = true;
		changed();
		startPoll();
	}

	// Slow, unref'd check that the wolf is still online (workerd restarts a dead wolfd by itself); the menu reads the cached value.
	let poll = null;
	function startPoll() {
		if (poll) return;
		poll = setInterval(async () => {
			let up;
			try {
				up = ((await (await fetch(`${sup.urls.workerd}/v1/wolves`, { signal: AbortSignal.timeout(5000) })).json()).wolves ?? []).some((w) => w.status === "online");
			} catch {
				up = false;
			}
			if (stopping) return;
			wolfUp = up;
			changed();
		}, 30_000);
		poll.unref?.();
	}

	sup.start = async () => {
		stopping = false;
		const keyFile = setup();
		for (let attempt = 1; ; attempt++) {
			try {
				await bringUp(keyFile);
				if (stopping) throw stoppedError();
				return;
			} catch (e) {
				await killAll();
				if (stopping) throw stoppedError();
				// A port taken between pick and bind, or a child that died at once: one more try on new ports.
				if (attempt >= 2 || !e.bind) throw e;
				log(`start failed (${e.message.split("\n")[0]}); retrying on new ports`);
			}
		}
	};

	/** SIGTERM every child (workerd first: it stops its wolfd), wait up to graceMs, SIGKILL what is left, including wolfd grandchildren. */
	sup.stop = async (graceMs = 8000) => {
		stopping = true;
		wolfUp = false;
		if (poll) clearInterval(poll);
		poll = null;
		changed();
		await killAll(graceMs);
	};

	/** Synchronous best-effort SIGTERM of every child and wolfd (logout/shutdown: no time to wait). Does not wait or SIGKILL. */
	sup.killAllSync = () => {
		stopping = true;
		for (const pid of sup.allPids()) try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
	};

	/** cb(running) fires when the running state flips (wolf up, child exit, stop). Returns an unsubscribe. */
	sup.onChange = (cb) => {
		listeners.add(cb);
		return () => listeners.delete(cb);
	};

	async function killAll(graceMs = 8000) {
		const kids = [...children.values()];
		const pids = new Set([...kids.map((c) => c.pid), ...wolfdPids()]);
		for (const c of kids) c.kill("SIGTERM");
		const end = Date.now() + graceMs;
		while (Date.now() < end && [...pids].some(alive)) await new Promise((r) => setTimeout(r, 100));
		// A wolfd workerd respawned while stopping is only visible now.
		for (const p of wolfdPids()) pids.add(p);
		for (const pid of pids) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
	}

	/** wolfd processes under our workerd (children of the workerd child). */
	function wolfdPids() {
		const w = children.get("workerd");
		if (!w) return [];
		try {
			return execFileSync("pgrep", ["-P", String(w.pid)], { encoding: "utf8" }).split("\n").map(Number).filter((n) => n > 0);
		} catch {
			return [];
		}
	}
	/** True while hubd, workerd and the wolf are all up. Cheap: reads cached state only. */
	sup.status = () => ({ running: !stopping && wolfUp && children.has("hubd") && children.has("workerd") });
	sup.allPids = () => [...children.values()].map((c) => c.pid).concat(wolfdPids());
	return sup;
}

module.exports = { createSupervisor, KEY_FILE };
