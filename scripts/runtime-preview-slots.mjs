/**
 * Agent slots for `wolfpack preview`: an on-demand `next dev` console per worktree on ports 3231+, at most 2 at once (PREVIEW_SLOT_MAX, capped at 4).
 * Each slot is a detached process group (a runner plus next and its workers; own log ~/.wolfpack/preview/slots/<port>.log) recorded in
 * ~/.wolfpack/preview/slots.json under a lock file. No launchd: a detached spawn plus a pid record needs no plist per slot, and the group
 * dies with one signal. Idle slots stop themselves: the runner (runtime-preview-slot-run.mjs) checks slots.json and exits, taking next with it.
 * A pid is only ever signalled after `ps` shows it is our runner, so a pid reused after a reboot is never touched. Node builtins only.
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devConsoleApp, resolveHub } from "./runtime-preview-console.mjs";
import { probePortFree } from "./runtime-preview-switch.mjs";

export const SLOT_BASE_PORT = 3231;
export const SLOT_MAX = 2;
export const SLOT_MAX_CAP = 4;
export const SLOT_IDLE_MS = 20 * 60_000;
const RUNNER = "runtime-preview-slot-run.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const sleepAsync = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when the pid is one of OUR slot runners: a node command line `...runtime-preview-slot-run.mjs <this home> <this port> ...`, not a bare substring. */
function isRunner(pid, slot) {
	const r = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
	if (r.status !== 0) return false;
	const cmd = String(r.stdout);
	return /\bnode\b/.test(cmd) && cmd.includes(`${RUNNER} ${slot.home} ${slot.port} `);
}
/** Does any process hold this pid? Only ESRCH says no (EPERM: someone else's process holds it). A zombie (killed, not yet reaped by its parent) holds nothing. */
function defaultPidExists(pid) {
	try {
		process.kill(pid, 0);
	} catch (e) {
		return e.code !== "ESRCH";
	}
	const st = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
	return !(st.status === 0 && String(st.stdout).trim().startsWith("Z"));
}
/** A live runner of ours. A pid that exists but is not our runner (EPERM, or reused after a reboot) is not ours. */
function defaultIsAlive(pid, slot) {
	return defaultPidExists(pid) && isRunner(pid, slot);
}
/** SIGTERM the runner's whole group (the runner escalates to SIGKILL itself). Refuses a pid that is not our runner. */
function defaultKill(pid, slot) {
	if (!isRunner(pid, slot)) return;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {}
}
/**
 * Only called when NO process holds the dead runner's pid (ESRCH), so its group id cannot belong to anything else while the group has
 * members. Stops only members whose command names this slot's worktree (its `<worktree>/…/node_modules/next` process): never anything
 * matched by name alone, since another console's `next-server` worker may share a reused group id. SIGTERM now, SIGKILL after 3 s.
 * The SIGTERM is sent synchronously; the returned promise settles after the escalation, which callers await outside the lock.
 */
async function defaultReapLeftovers(slot) {
	const ps = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" });
	const mine = String(ps.stdout)
		.split("\n")
		.map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
		.filter((m) => m && Number(m[2]) === slot.pid && Number(m[1]) !== slot.pid && slot.worktree && m[3].includes(`${slot.worktree}${path.sep}`))
		.map((m) => Number(m[1]));
	for (const p of mine) {
		try {
			process.kill(p, "SIGTERM");
		} catch {}
	}
	if (!mine.length) return;
	await sleepAsync(3000);
	for (const p of mine) {
		try {
			process.kill(p, 0);
			process.kill(p, "SIGKILL");
		} catch {}
	}
}

/**
 * A next dev (or anything) that is NOT one of our slots, listens on a TCP port, and has this worktree's apps/console as its cwd.
 * Read-only: two lsof lookups, never a signal. → {pid, port} or null. `slotPorts` are ours and are skipped.
 */
function defaultServedElsewhere(worktree, slotPorts) {
	const apps = [path.join(worktree, "apps", "console")];
	try {
		apps.push(fs.realpathSync(apps[0]));
	} catch {}
	const listen = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { encoding: "utf8" });
	const portOf = new Map();
	let pid = 0;
	for (const line of String(listen.stdout ?? "").split("\n")) {
		if (line[0] === "p") pid = Number(line.slice(1));
		else if (line[0] === "n" && pid) {
			const m = /:(\d+)$/.exec(line);
			if (m && !slotPorts.includes(Number(m[1])) && !portOf.has(pid)) portOf.set(pid, Number(m[1]));
		}
	}
	if (!portOf.size) return null;
	const cwds = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", [...portOf.keys()].join(",")], { encoding: "utf8" });
	pid = 0;
	for (const line of String(cwds.stdout ?? "").split("\n")) {
		if (line[0] === "p") pid = Number(line.slice(1));
		else if (line[0] === "n" && pid && apps.includes(line.slice(1))) return { pid, port: portOf.get(pid) };
	}
	return null;
}

/** The last useful line of a slot's log (ANSI stripped): an error-looking line if there is one, else the last non-empty line. */
function lastLogLine(logFile, secret) {
	let text = "";
	try {
		const fd = fs.openSync(logFile, "r");
		const size = fs.fstatSync(fd).size;
		const buf = Buffer.alloc(Math.min(size, 16_384));
		fs.readSync(fd, buf, 0, buf.length, size - buf.length);
		fs.closeSync(fd);
		text = buf.toString("utf8");
	} catch {
		return "";
	}
	const lines = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
	const line = [...lines].reverse().find((l) => /\u2a2f|error|already running|EADDRINUSE|cannot|failed/i.test(l)) ?? lines.at(-1) ?? "";
	// Redact the hub token if next echoed it. A secret under 16 characters is not redacted: it would garble the line (a one-letter value
	// matches everywhere) and real hub tokens are far longer.
	return (secret && secret.length >= 16 ? line.split(secret).join("[redacted]") : line).slice(0, 200);
}

/** Refuse a worktree that cannot serve the console: no next, or a @wolfpack/* dependency whose dist is missing. → {app, next} */
function defaultPrepare(worktree) {
	const found = devConsoleApp(worktree);
	let deps = {};
	try {
		deps = JSON.parse(fs.readFileSync(path.join(found.app, "package.json"), "utf8")).dependencies ?? {};
	} catch {}
	const missing = [];
	for (const name of Object.keys(deps).filter((n) => n.startsWith("@wolfpack/"))) {
		for (const d of fs.existsSync(path.join(worktree, "packages")) ? fs.readdirSync(path.join(worktree, "packages")) : []) {
			let pkg;
			try {
				pkg = JSON.parse(fs.readFileSync(path.join(worktree, "packages", d, "package.json"), "utf8"));
			} catch {
				continue;
			}
			if (pkg.name !== name) continue;
			const entry = JSON.stringify([pkg.main, pkg.module, pkg.exports]);
			if (entry.includes("dist/") && !fs.existsSync(path.join(worktree, "packages", d, "dist"))) missing.push(name);
		}
	}
	if (missing.length) throw new Error(`${worktree} is not built (no dist for ${missing.join(", ")}): run \`pnpm build\` in ${worktree} first`);
	return found;
}

/** The real spawn: a detached runner that starts `next dev` in the worktree's apps/console and stops it when idle. → the runner's pid (= its group). */
function realSpawn({ home, port, env, logFile, idleMs, prep }) {
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	const fd = fs.openSync(logFile, "a");
	const child = nodeSpawn(process.execPath, [path.join(HERE, RUNNER), home, String(port), prep.next, prep.app, String(idleMs)], { detached: true, stdio: ["ignore", fd, fd], cwd: prep.app, env });
	child.unref();
	fs.closeSync(fd);
	return child.pid;
}

export function createSlots({
	home,
	env = {},
	now = Date.now,
	spawn = realSpawn,
	isAlive = defaultIsAlive,
	pidExists = defaultPidExists,
	lockHolderExists = defaultPidExists,
	kill = defaultKill,
	reapLeftovers = defaultReapLeftovers,
	prepare = defaultPrepare,
	portFree = probePortFree,
	servedElsewhere = defaultServedElsewhere,
	// Ready means the slot port answers an HTTP request. Any answer counts (a 500 or a redirect to /pair still means next is serving). A slow answer
	// (the first page compiling) is retried until the deadline; if the runner dies first the slot never came up. Injectable for tests.
	waitListening = async ({ port, pid }) => {
		const until = Date.now() + (Number(env.PREVIEW_SLOT_WAIT_MS) || 90_000);
		while (Date.now() < until) {
			try {
				await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
				return true;
			} catch {} // refused, or still compiling: look at the runner, then try again
			if (!defaultIsAlive(pid, { home, port })) return false;
			await sleepAsync(500);
		}
		return false;
	},
	max = Number(env.PREVIEW_SLOT_MAX) || SLOT_MAX,
	idleMs = Number(env.PREVIEW_SLOT_IDLE_MS) || SLOT_IDLE_MS,
	lockWaitMs = 5000,
	// Revoking a slot's browser token (the one `slot pair` minted): a JSON request to the hub -> {status, json}; status 0 when unreachable.
	hubFetch = async (url, init) => {
		try {
			const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
			return { status: r.status, json: await r.json().catch(() => ({})) };
		} catch {
			return { status: 0, json: {} };
		}
	},
	warn = (m) => console.error(m),
} = {}) {
	max = Math.min(max, SLOT_MAX_CAP);
	const dir = path.join(home, ".wolfpack", "preview");
	const file = path.join(dir, "slots.json");
	const lockFile = path.join(dir, "slots.lock");
	// Non-secret token ids of the browser tokens `slot pair` minted, one per port and kind ("agent" = the wolf browser via --print-url, "owner" = the owner's browser): {"3231": {"agent": "tok_...", "owner": "tok_..."}}. The older flat {"3231": "tok_..."} reads as the owner's id. Its own file (not slots.json) so a
	// slot record dying never loses the id, and the runner's slots.json check is untouched. Only ids are ever stored here.
	const tokensFile = path.join(dir, "slot-tokens.json");
	const readIds = () => {
		try {
			const o = JSON.parse(fs.readFileSync(tokensFile, "utf8"));
			if (!o || typeof o !== "object") return {};
			for (const k of Object.keys(o)) if (typeof o[k] === "string") o[k] = { owner: o[k] }; // legacy flat shape
			return o;
		} catch {
			return {};
		}
	};
	const writeIds = (o) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(tokensFile + ".tmp", JSON.stringify(o, null, 2) + "\n");
		fs.renameSync(tokensFile + ".tmp", tokensFile);
	};
	const pendingIds = [];
	/** Under the lock: forget the port's recorded id of one kind (every kind when none is named) and queue it for revoking (done after the lock, in settled). */
	const forgetId = (port, kind) => {
		const ids = readIds();
		const entry = ids[String(port)];
		if (!entry || typeof entry !== "object") return;
		for (const k of kind ? [kind] : Object.keys(entry)) {
			if (typeof entry[k] === "string") pendingIds.push(entry[k]);
			delete entry[k];
		}
		if (!Object.keys(entry).length) delete ids[String(port)];
		writeIds(ids);
	};
	/** Revoke a token id on the hub with a token this Mac holds (hub-token file first, as `slot pair` does, then the env one). Never throws: a failure is one warning. */
	const revokeId = async (id) => {
		const hub = resolveHub({ home, env });
		const tokens = [];
		try {
			const t = fs.readFileSync(path.join(dir, "hub-token"), "utf8").trim();
			if (t) tokens.push(t);
		} catch {}
		const fromEnv = env.WOLFPACK_HUB_TOKEN?.trim();
		if (fromEnv && !tokens.includes(fromEnv)) tokens.push(fromEnv);
		let last = 0;
		if (hub) {
			for (const token of tokens) {
				last = (await hubFetch(hub.url + "/v1/tokens/" + encodeURIComponent(id), { method: "DELETE", headers: { Authorization: "Bearer " + token } })).status;
				if (last === 200 || last === 404) return; // 404: already revoked
			}
		}
		warn("preview: could not revoke slot browser token " + id + " (" + (hub ? (last ? "the hub answered " + last : "the hub is unreachable") : "no hub paired") + "); revoke it with `hubd tokens revoke " + id + "`");
	};

	/** A missing or corrupt file counts as "no slots" (runners whose record is gone exit on their next check). */
	const read = () => {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8")).slots ?? [];
		} catch {
			return [];
		}
	};
	const write = (slots) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ slots }, null, 2)}\n`);
		fs.renameSync(`${file}.tmp`, file);
	};
	/** The pid in a lock's token ("pid:nonce"), or undefined for an empty or foreign lock file. */
	const holderOf = (text) => {
		const n = Number(/^(\d+):/.exec(text)?.[1]);
		return n > 0 ? n : undefined;
	};
	/**
	 * Run fn holding the lock file (created O_EXCL with a pid:nonce token; removed only if the token is still ours). A lock is stale only
	 * when its holder pid is gone (ESRCH), or it is older than 60 s whatever its holder (a pid reused after a reboot must not wedge slots
	 * for ever; a command holds the lock for milliseconds). It is removed only if it still holds the same token.
	 */
	const locked = async (fn) => {
		fs.mkdirSync(dir, { recursive: true });
		const token = `${process.pid}:${crypto.randomBytes(6).toString("hex")}`;
		const t0 = Date.now();
		for (;;) {
			try {
				const fd = fs.openSync(lockFile, "wx");
				fs.writeSync(fd, token);
				fs.closeSync(fd);
				break;
			} catch (e) {
				if (e.code !== "EEXIST") throw e;
				try {
					const text = fs.readFileSync(lockFile, "utf8");
					const holder = holderOf(text);
					const stale = (holder && !lockHolderExists(holder)) || Date.now() - fs.statSync(lockFile).mtimeMs > 60_000;
					if (stale && fs.readFileSync(lockFile, "utf8") === text) {
						fs.rmSync(lockFile, { force: true });
						continue;
					}
				} catch {}
				if (Date.now() - t0 > lockWaitMs) throw new Error(`slots are locked by another preview command (${lockFile}); try again in a moment`);
				await sleepAsync(25);
			}
		}
		try {
			return await fn();
		} finally {
			try {
				if (fs.readFileSync(lockFile, "utf8") === token) fs.rmSync(lockFile, { force: true });
			} catch {}
		}
	};
	/** Leftover-reaping started under the lock; its SIGKILL escalation is awaited after the lock is released. */
	const pending = [];
	const settled = async (value) => {
		await Promise.all(pending.splice(0));
		for (const id of pendingIds.splice(0)) await revokeId(id);
		return value;
	};
	/** Drop dead slots (clearing what they left behind) and idle slots (killing them). → {slots, stopped: [port]} */
	const sweep = () => {
		const t = now();
		const keep = [];
		const stopped = [];
		for (const s of read()) {
			const rec = { ...s, home };
			if (!isAlive(s.pid, rec)) {
				// Only when no process holds the pid at all is the old group ours to clean up. A pid that exists but is not our runner (reused
				// after a reboot) may lead an unrelated group, such as another console's next dev: just forget the record.
				if (!pidExists(s.pid)) pending.push(Promise.resolve(reapLeftovers(s)).catch(() => {}));
				forgetId(s.port);
				continue;
			}
			if (t - s.lastUsed > idleMs) {
				kill(s.pid, rec);
				forgetId(s.port);
				stopped.push(s.port);
				continue;
			}
			keep.push(s);
		}
		write(keep);
		return { slots: keep, stopped };
	};
	const url = (port) => `http://127.0.0.1:${port}`;
	const tokenFile = path.join(dir, "hub-token");
	/** The hub token for a slot's environment: WOLFPACK_HUB_TOKEN, else the trimmed contents of ~/.wolfpack/preview/hub-token. The value goes only into the slot's env. */
	const hubToken = () => {
		const fromEnv = env.WOLFPACK_HUB_TOKEN?.trim();
		if (fromEnv) return { token: fromEnv };
		try {
			const token = fs.readFileSync(tokenFile, "utf8").trim();
			if (!token) return {};
			return { token, ...(fs.statSync(tokenFile).mode & 0o077 ? { looseFile: tokenFile } : {}) };
		} catch {
			return {};
		}
	};
	const logOf = (port) => path.join(dir, "slots", `${port}.log`);

	const api = {
		async get(worktree) {
			let slot;
			let tok = {};
			// Two lsof lookups: done before taking the lock so a slow machine cannot hold other commands past lockWaitMs. Skipped for a worktree
			// that already has a slot (asking again just reuses it). A slot or console that appears in between is caught by the port checks.
			const known = read();
			if (!known.some((x) => x.worktree === worktree)) {
				const other = servedElsewhere(worktree, known.map((x) => x.port));
				if (other) throw new Error(`this worktree's console already runs on :${other.port} (pid ${other.pid}); use that, or a separate worktree`);
			}
			try {
				slot = await locked(async () => {
					const { slots } = sweep();
					const have = slots.find((s) => s.worktree === worktree);
					if (have) {
						have.lastUsed = now();
						write(slots);
						return { ...have, reused: true };
					}
					if (slots.length >= max) {
						const busy = slots.map((s) => `${s.port} (${s.worktree})`).join(", ");
						throw new Error(`all ${max} slots are in use: ${busy}. Free one with \`wolfpack preview slot release <worktree|port>\`, then ask again.`);
					}
					const prep = prepare(worktree);
					tok = hubToken();
					let port = SLOT_BASE_PORT;
					while (slots.some((s) => s.port === port) || !(await portFree(port))) port++;
					const hub = resolveHub({ home, env });
					const access = hub
						? { WOLFPACK_HUB_URL: hub.url, HUBD_PUBLIC_URL: hub.publicUrl, WOLFPACK_CONSOLE_PUBLIC_ORIGIN: url(port) }
						: { WOLFPACK_API_URL: `http://127.0.0.1:${env.STACK_PORT || 7141}` };
					const childEnv = {
						...access,
						...(tok.token ? { WOLFPACK_HUB_TOKEN: tok.token } : {}),
						...(env.PREVIEW_SLOT_TICK_MS ? { PREVIEW_SLOT_TICK_MS: env.PREVIEW_SLOT_TICK_MS } : {}),
						PORT: String(port),
						HOSTNAME: "127.0.0.1",
						HOME: home,
						WOLFPACK_KEY_FILE: path.join(dir, "keys.env"),
						PATH: env.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
					};
					const pid = spawn({ home, port, worktree, env: childEnv, logFile: logOf(port), idleMs, prep });
					const t = now();
					const rec = { port, worktree, pid, startedAt: t, lastUsed: t };
					slots.push(rec);
					write(slots);
					return { ...rec, reused: false };
				});
			} finally {
				await settled(); // the SIGKILL escalation of any dead runner's leftovers, also when this get is refused
			}
			// Outside the lock: the first request can take a while, and other commands must not wait on it.
			if (slot.reused) tok = hubToken(); // read before the wait: a reused slot whose wait fails quotes the log, which must be redacted too
			if (!(await waitListening({ port: slot.port, pid: slot.pid }))) {
				const line = lastLogLine(logOf(slot.port), tok.token);
				try {
					await api.releaseExact(slot); // the slot never came up: do not leave a record (or a runner) behind
				} catch {}
				throw new Error(`slot ${slot.port} for ${worktree} is not listening${line ? `: ${line}` : ""}; see ${logOf(slot.port)}`);
			}
			return { port: slot.port, url: url(slot.port), pid: slot.pid, reused: slot.reused, noToken: !tok.token, ...(tok.looseFile ? { tokenFileLoose: tok.looseFile } : {}) };
		},
		list: async () => settled(await locked(() => sweep().slots)),
		/** Keep the non-secret id of the browser token `slot pair` just minted for this port and kind ("owner" | "agent"). */
		recordToken: async (port, id, kind = "owner") =>
			locked(() => {
				const ids = readIds();
				writeIds({ ...ids, [String(port)]: { ...ids[String(port)], [kind]: id } });
			}),
		/** Revoke the port's recorded token of this kind (if any) and forget it. A failure is a warning, never an error. */
		revokeToken: async (port, kind = "owner") => {
			await locked(() => forgetId(port, kind));
			return settled();
		},
		/** Best effort: revoke a token id that was minted but could not be recorded. Warns on failure. */
		revokeTokenId: async (id) => revokeId(id),
		/** Read-only view for `status`: no lock, no sweep, no write. Dead slots are just left out. */
		peek: () => read().filter((s) => isAlive(s.pid, { ...s, home })),
		/** Stop idle and dead slots. → [port] stopped for idleness */
		reap: async () => settled(await locked(() => sweep().stopped)),
		/**
		 * Internal (used by a failed get): stop the slot only if the record still holds this very runner (port, pid and start time). If the
		 * runner died and another get took the port, the record is not ours any more and nothing is signalled. No name matching.
		 */
		async releaseExact({ port, pid, startedAt }) {
			return settled(await locked(() => {
				const { slots } = sweep();
				const s = slots.find((x) => x.port === port && x.pid === pid && x.startedAt === startedAt);
				if (!s) return false;
				kill(s.pid, { ...s, home });
				forgetId(s.port);
				write(slots.filter((x) => x !== s));
				return true;
			}));
		},
		/** Stop one slot by port, worktree path, folder name, or a unique part of the folder name. → its port */
		async release(key, alt) {
			return settled(await locked(() => {
				const { slots } = sweep();
				const keys = [key, alt].filter(Boolean).map(String);
				const exact = slots.filter((x) => keys.some((k) => String(x.port) === k || x.worktree === k || path.basename(x.worktree) === k));
				const partial = slots.filter((x) => keys.some((k) => path.basename(x.worktree).includes(k)));
				const hit = exact.length ? exact : partial;
				if (hit.length > 1) throw new Error(`"${key}" matches several slots: ${hit.map((x) => `${x.port} ${x.worktree}`).join(", ")}; use the port`);
				const s = hit[0];
				if (!s) throw new Error(`no slot for ${key}${slots.length ? ` (running: ${slots.map((x) => `${x.port} ${x.worktree}`).join(", ")})` : " (no slots are running)"}`);
				kill(s.pid, { ...s, home });
				forgetId(s.port);
				write(slots.filter((x) => x !== s));
				return s.port;
			}));
		},
	};
	return api;
}
