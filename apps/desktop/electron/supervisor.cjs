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
 * GITHUB_TOKEN from the owner's shell); the API key goes only to workerd (and so to its wolfd) and hubd (its curator calls Haiku), never to argv, and is
 * redacted from any child output we log. The bundles exit by themselves when this process dies (WOLFPACK_EXIT_WITH_PARENT).
 */
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const KEY_FILE = "credentials.json"; // { ANTHROPIC_API_KEY }, mode 0600, in the pack state dir
// Model names live here (and only here): update them in this block when a model is retired.
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

const TAIL_LINES = 20;
const HUB_TOKEN_FILE = "hub-token.json"; // { token }, mode 0600: the wolf's loopback token for this app's own hubd
const DEFAULT_WINDOW_MAX = 5; // curator ticks (one contribution each) per curation window
const WINDOW_TIMEOUT_MS = 20 * 60_000;

const freePort = () =>
	new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});

/** The port picked last time when it is still free (a restart keeps the console server's URLs valid), else a new free port. */
const reuseOrFreePort = async (prev, pickFree = freePort) => {
	if (prev) {
		const ok = await new Promise((resolve) => {
			const srv = net.createServer();
			srv.once("error", () => resolve(false));
			srv.listen(prev, "127.0.0.1", () => srv.close(() => resolve(true)));
		});
		if (ok) return prev;
	}
	return pickFree();
};

const tier = (model) => ({ model, modelSource: "default", provider: "anthropic", piModel: `anthropic/${model}` });

/** Sonnet answers the chat; Haiku does memory and curation work. */
function modelsJson() {
	return { location: "local", transport: "api", transportSource: "default", tiers: { main: tier(SONNET), smart: tier(HAIKU), fast: tier(HAIKU) }, steps: {}, warnings: [] };
}

/** Default wolf: memory, KB and work items on, no browser tool. */
function wolfYaml(name, dir, domains) {
	return [
		`id: ${name}`,
		`name: ${name}`,
		`domains: [${domains.map((d) => d.name).join(", ")}]`,
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
	// The wizard's domains ({ name, description }); `personal` alone when none are given.
	const domains = opts.domains?.length ? opts.domains : [{ name: "personal", description: "" }];
	const log = opts.log ?? (() => {});
	// Test seam: opts.pickPort(freePort) may return a port (e.g. one already taken) in place of a free one.
	const pickFree = () => (opts.pickPort ? opts.pickPort(freePort) : freePort());
	const MAX_BIND_ATTEMPTS = 3; // a port taken between pick and bind: pick a new one and relaunch, this many tries in all
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
		...(opts.extraEnv ?? {}), // test seam: e.g. WOLFPACK_EMBED_URL at a dead port to prove nothing calls Ollama
		...extra,
	});
	const children = new Map();
	let stopping = false; // set by stop(), cleared by the next start(): a quit during start must not respawn anything
	const stoppedError = () => Object.assign(new Error("supervisor stopped"), { stopped: true });
	let secret = "";
	let hubHadKey = false; // hubd reads its key only at launch: a key added later reaches it at the next app launch
	const listeners = new Set();
	let wolfUp = false; // cached: the default wolf is online (set after bring-up, refreshed by a slow poll)
	let lastRunning = false;
	const changed = () => {
		const r = sup.status().running;
		if (r === lastRunning) return;
		lastRunning = r;
		for (const cb of listeners) try { cb(r); } catch { /* a listener must not break the supervisor */ }
	};
	let curatorOn = false;
	let embedEnv = {};
	let windowRunning = false;
	let hubToken = "";
	const curateWaiters = new Set(); // done() of each pending curate(): stop() and hubd's exit resolve them
	const endCurate = (why) => {
		for (const f of [...curateWaiters]) f({ skipped: why });
		windowRunning = false;
	};
	const redact = (s) => [secret, hubToken].reduce((t, v) => (v ? t.split(v).join("[redacted]") : t), s);
	const sup = { urls: {}, ports: {}, wolfDir: path.join(wolvesDir, wolfName), pids: () => [...children.values()].map((c) => c.pid) };

	function setup() {
		const wolfDir = sup.wolfDir;
		for (const d of [stateDir, wolvesDir, path.join(stateDir, "wolves-root"), path.join(stateDir, "kb", "ops"), path.join(stateDir, "kb", "base"), path.join(wolfDir, "workspace"), path.join(wolfDir, "den", "extensions")]) fs.mkdirSync(d, { recursive: true });
		fs.chmodSync(stateDir, 0o700);
		fs.chmodSync(wolfDir, 0o700);
		writeIfMissing(path.join(wolfDir, "models.json"), JSON.stringify(modelsJson(), null, 2));
		writeIfMissing(path.join(wolfDir, "wolf.yaml"), wolfYaml(wolfName, wolfDir, domains));
		// hubd's one-time registry seed (read only while the hub has no registry yet): the domains, plus the wolf.yaml above.
		const seedDir = path.join(stateDir, "seed");
		fs.mkdirSync(seedDir, { recursive: true });
		// JSON strings are valid YAML scalars, so a description needs no escaping of its own.
		const domainLines = domains.flatMap((d) => (d.description ? [`  ${d.name}:`, `    description: ${JSON.stringify(d.description)}`] : [`  ${d.name}: {}`]));
		fs.writeFileSync(path.join(seedDir, "domains.yaml"), ["domains:", ...domainLines, ""].join("\n"));
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
		const rec = { name, pid: child.pid, kill: (s) => child.kill(s), tail: [], exited: false, pending: "", lineWaiters: new Set() };
		children.set(name, rec);
		const onData = (b) => {
			for (const raw of String(b).split("\n")) {
				if (!raw.trim()) continue;
				const l = redact(raw);
				rec.tail.push(l);
				if (rec.tail.length > TAIL_LINES) rec.tail.shift();
				log(`${name}: ${l}`);
				for (const w of rec.lineWaiters) w(l);
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code, sig) => {
			rec.exited = true;
			log(`${name} exited (code=${code} signal=${sig})`);
			if (children.get(name) === rec) children.delete(name); // a restarted child must not be dropped by its predecessor's late exit
			if (name === "workerd" && !children.has("workerd")) wolfUp = false;
			if (name === "hubd") endCurate("hubd stopped");
			changed();
		});
		return rec;
	}

	/** Poll fn until true. Rejects at once if `rec` (the child being waited on) has exited, with its last output lines. */
	async function until(fn, what, rec, ms = 60_000) {
		const end = Date.now() + ms;
		const fail = (why) => {
			const e = new Error(`${what} ${why}${rec?.tail.length ? `. Last output:\n${rec.tail.join("\n")}` : ""}`);
			e.bind = !!rec && rec.tail.some((l) => /listen EADDRINUSE/.test(l)); // only a taken port is worth a retry on new ports; any other early exit fails with its own reason
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
	const healthy = (url) => async () => (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok; // a squatter that accepts but never answers must not hang the wait

	/**
	 * A single-use pairing code for a console token, from the hubd CLI (file based: hubd is not up yet). Null when a token is already stored.
	 * Safe to run again on a start retry: a token file that was redeemed is skipped, and a fresh code is minted only while none is stored.
	 */
	function mintHubToken(hubDir) {
		const file = path.join(stateDir, HUB_TOKEN_FILE);
		if (fs.existsSync(file)) {
			try {
				if (typeof JSON.parse(fs.readFileSync(file, "utf8")).token === "string") return null;
			} catch {}
			// Unreadable (corrupt, empty, no token): set it aside, never delete it, and mint a fresh one.
			fs.renameSync(file, `${file}.bad-${Date.now()}`);
			log(`${HUB_TOKEN_FILE} was unreadable: set aside, minting a new token`);
		}
		const r = spawnSync(nodeBin, [path.join(runtimeDir, "hubd.mjs"), "pair", "--kind", "console", "--label", "wolf", "--data-dir", hubDir], { env: base({}), encoding: "utf8" });
		const m = /pairing code: (\S+)/.exec(`${r.stdout}`);
		if (!m) throw new Error(`could not mint the wolf's hub token: ${String(r.stderr || r.stdout).split("\n")[0]}`);
		return m[1];
	}

	/** Trade the code for the token (once) and keep it in a 0600 file; later starts read it back. */
	async function redeemHubToken(hubUrl, code) {
		const file = path.join(stateDir, HUB_TOKEN_FILE);
		if (!code) return JSON.parse(fs.readFileSync(file, "utf8")).token;
		const res = await fetch(`${hubUrl}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, label: "wolf" }) });
		if (!res.ok) throw new Error(`hubd refused the wolf's pairing code (${res.status})`);
		const { token } = await res.json();
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify({ token }), { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, file);
		return token;
	}

	async function bringUp(keyFile) {
		const creds = readCredentials(keyFile);
		secret = creds.ANTHROPIC_API_KEY ?? "";
		hubHadKey = !!secret;
		if (!secret) log("no API key yet: KB curation is skipped until the app is launched with one");
		const hubPort = await reuseOrFreePort(sup.ports.hubd, pickFree);
		const workerdPort = await reuseOrFreePort(sup.ports.workerd, pickFree);
		sup.ports = { hubd: hubPort, workerd: workerdPort };
		sup.urls = { hubd: `http://127.0.0.1:${hubPort}`, workerd: `http://127.0.0.1:${workerdPort}` };
		// hubd: the app's own hub. Its curator timer is OFF (HUBD_CURATOR_POLL_MS=0): the gate in main.cjs decides when, and
		// sup.curate() sends SIGUSR2 for one bounded window. Needs the local embedding model, else curation is off (logged).
		const modelDir = opts.embedModelDir || process.env.WOLFPACK_APP_EMBED_MODEL_DIR || "";
		curatorOn = !!modelDir && fs.existsSync(path.join(modelDir, "model.onnx"));
		if (!curatorOn) log(modelDir ? `KB curation is off: no model.onnx in ${modelDir}` : "KB curation is off: no embedding model dir (WOLFPACK_APP_EMBED_MODEL_DIR)");
		// Half the cores for the embedder, so the laptop stays responsive.
		embedEnv = curatorOn ? { WOLFPACK_EMBED_PROVIDER: "onnx", WOLFPACK_EMBED_MODEL_DIR: modelDir, WOLFPACK_EMBED_THREADS: String(opts.embedThreads ?? Math.max(1, Math.floor(os.cpus().length / 2))) } : {};
		const hubDir = path.join(stateDir, "hub");
		const pairCode = mintHubToken(hubDir);
		const hub = launch(
			"hubd",
			"hubd.mjs",
			["serve", "--data-dir", hubDir, "--port", String(hubPort), "--host", "127.0.0.1", "--seed-domains", path.join(stateDir, "seed", "domains.yaml"), "--seed-wolf", path.join(sup.wolfDir, "wolf.yaml")],
			base({
				HUBD_CURATOR: curatorOn ? "1" : "0",
				HUBD_CURATOR_POLL_MS: "0",
				HUBD_CURATOR_WINDOW_MAX: String(opts.curateWindowMax ?? DEFAULT_WINDOW_MAX),
				HUBD_CURATOR_MODELS: path.join(sup.wolfDir, "models.json"),
				...embedEnv,
				// The curator calls the model provider (Haiku) with the user's key; proxy settings so a user behind one can reach it.
				...(secret ? { ANTHROPIC_API_KEY: secret } : {}),
				...proxyEnv(),
				...(opts.modelBaseUrl ? { ANTHROPIC_BASE_URL: opts.modelBaseUrl } : {}),
			}),
		);
		await until(healthy(sup.urls.hubd), "hubd", hub);
		hubToken = await redeemHubToken(sup.urls.hubd, pairCode);
		await startWorkerd();
		wolfUp = true;
		changed();
		startPoll();
	}

	/** Launch workerd (it supervises wolfd) on `sup.ports.workerd` with the key and hub token as they are now. */
	async function startWorkerd() {
		const wolfHubToken = hubToken;
		// workerd supervises wolfd through the shim. The wolfd env (incl. the key) is workerd's env.
		// v1: the key stays in wolfd's env, so the wolf's shell tool can read it. It is the user's own key on their own Mac.
		const shim = ensureShim(stateDir);
		const workerdPort = sup.ports.workerd;
		const env = base({
			WOLFPACK_SINGLE_MAC: "1", // the app's wolf: the no-key message names Settings → Data and support (harness engine/events.ts)
			WOLFPACK_APP_NODE: nodeBin,
			WOLFPACK_APP_WOLFD: path.join(runtimeDir, "wolfd", "wolfd.mjs"),
			WOLFPACK_MODELS_FILE: path.join(sup.wolfDir, "models.json"),
			KB_BASE: path.join(stateDir, "kb", "base"),
			KB_OPS: path.join(stateDir, "kb", "ops"),
			...(secret ? { ANTHROPIC_API_KEY: secret } : {}),
			// The wolf keeps its KB through the app's own hubd on loopback: it mirrors the KB from it and feeds its contributions to it.
			WOLFPACK_HUB_KB: "1",
			WOLFPACK_HUB_URL: sup.urls.hubd,
			WOLFPACK_HUB_TOKEN: wolfHubToken,
			...embedEnv,
			// Proxy settings go to workerd (and so its wolfd) and to hubd (its curator calls the model provider), so a user behind a proxy can reach it.
			...proxyEnv(),
			...(opts.modelBaseUrl ? { WOLFPACK_ANTHROPIC_BASE_URL: opts.modelBaseUrl } : {}),
		});
		const wd = launch("workerd", "workerd.mjs", ["--wolves", wolvesDir, "--port", String(workerdPort), "--host", "127.0.0.1", "--wolfd", shim.command], env, shim.dir);
		await until(healthy(sup.urls.workerd), "workerd", wd);
		await until(async () => ((await (await fetch(`${sup.urls.workerd}/v1/wolves`)).json()).wolves ?? []).some((w) => w.status === "online"), "the default wolf did not come online", wd);
	}

	/**
	 * Restart the wolf ("wolfd") so it picks up a changed credentials.json: workerd owns wolfd and hands it its own env, so workerd is
	 * relaunched (same port, hubd untouched; a new port if the old one is taken, which throws PORT_MOVED) with the key read afresh. Anything else is refused.
	 */
	let restarting = null;
	sup.restart = (name) => {
		if (name !== "wolfd") return Promise.reject(new Error(`cannot restart ${name}`));
		// One at a time, in order: each call waits for the one before it, then reads credentials.json fresh and reports its own result.
		const run = (restarting ?? Promise.resolve()).catch(() => {}).then(restartWolf);
		restarting = run;
		const clear = () => {
			if (restarting === run) restarting = null;
		};
		run.then(clear, clear);
		return run;
	};

	async function restartWolf() {
		if (stopping || !children.has("hubd")) throw new Error("the app is not running");
		wolfUp = false;
		changed();
		const wd = children.get("workerd");
		const pids = new Set([...(wd ? [wd.pid] : []), ...wolfdPids()]);
		wd?.kill("SIGTERM");
		const end = Date.now() + 8000;
		while (Date.now() < end && [...pids].some(alive)) await new Promise((r) => setTimeout(r, 100));
		for (const p of pids) if (alive(p)) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
		secret = readCredentials(path.join(stateDir, KEY_FILE)).ANTHROPIC_API_KEY ?? "";
		const prev = sup.ports.workerd;
		let port = await reuseOrFreePort(prev, pickFree);
		for (let attempt = 1; ; attempt++) {
			sup.ports = { ...sup.ports, workerd: port };
			sup.urls = { ...sup.urls, workerd: `http://127.0.0.1:${port}` };
			try {
				await startWorkerd();
				break;
			} catch (e) {
				// never leave a half-started workerd, or the wolfd it spawned, behind
				const left = new Set([...(children.get("workerd") ? [children.get("workerd").pid] : []), ...wolfdPids()]);
				for (const p of left) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
				if (stopping || !e.bind || attempt >= MAX_BIND_ATTEMPTS) throw e;
				log(`restart failed (${e.message.split("\n")[0]}); retrying workerd on a new port`);
				do port = await pickFree();
				while (port === sup.ports.hubd); // a new port, and never hubd's
			}
		}
		wolfUp = true;
		changed();
		if (port !== prev) {
			log(`workerd moved from port ${prev} to ${port} on restart; the console still points at the old one`);
			const e = new Error("Restart the app to finish.");
			e.code = "PORT_MOVED";
			throw e;
		}
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
		windowRunning = false;
		const keyFile = setup();
		for (let attempt = 1; ; attempt++) {
			try {
				await bringUp(keyFile);
				if (stopping) throw stoppedError();
				return;
			} catch (e) {
				await killAll();
				if (stopping) throw stoppedError();
				// A port taken between pick and bind: one more try on new ports. Any other failure is final.
				if (attempt >= MAX_BIND_ATTEMPTS || !e.bind) throw e;
				log(`start failed (${e.message.split("\n")[0]}); retrying on new ports`);
				sup.ports = {}; // the old picks may be the taken ones: pick both afresh (nothing has used them yet)
			}
		}
	};

	/** SIGTERM every child (workerd first: it stops its wolfd), wait up to graceMs, SIGKILL what is left, including wolfd grandchildren. */
	sup.stop = async (graceMs = 8000) => {
		stopping = true;
		wolfUp = false;
		if (poll) clearInterval(poll);
		poll = null;
		endCurate("hubd stopped");
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
	/** False when hubd started with no key: it reads its key only at launch, so curation waits for the next app launch. */
	sup.hubHasKey = () => hubHadKey;
	/** True while hubd, workerd and the wolf are all up. Cheap: reads cached state only. */
	sup.status = () => ({ running: !stopping && wolfUp && children.has("hubd") && children.has("workerd") });
	/**
	 * One bounded curation window in hubd (SIGUSR2; hubd runs up to HUBD_CURATOR_WINDOW_MAX ticks, one contribution each).
	 * Resolves with hubd's "curator window done" line, or {skipped} with the reason. The caller (main.cjs) owns the gate.
	 */
	sup.curate = () =>
		new Promise((resolve) => {
			const hub = children.get("hubd");
			if (!hub || stopping) return resolve({ skipped: "hubd is not running" });
			if (!curatorOn) return resolve({ skipped: "no embedding model" });
			if (!hubHadKey) return resolve({ skipped: "no API key" });
			if (windowRunning) return resolve({ skipped: "a window is already running" });
			windowRunning = true;
			const done = (v) => {
				clearTimeout(timer);
				hub.lineWaiters.delete(onLine);
				curateWaiters.delete(done);
				windowRunning = false;
				resolve(v);
			};
			const onLine = (l) => {
				// Accepted: a stale "window done" line arriving after a 20-minute timeout could resolve a later curate() early.
				if (l.includes("curator window done")) done({ line: l.slice(l.indexOf("curator window done")) });
				else if (l.includes("curator window skipped: busy")) done({ skipped: "busy" });
			};
			const timer = setTimeout(() => done({ skipped: "window timed out" }), opts.curateTimeoutMs ?? WINDOW_TIMEOUT_MS);
			timer.unref();
			curateWaiters.add(done);
			hub.lineWaiters.add(onLine);
			hub.kill("SIGUSR2");
		});
	sup.allPids = () => [...children.values()].map((c) => c.pid).concat(wolfdPids());
	return sup;
}

module.exports = { createSupervisor, KEY_FILE };
