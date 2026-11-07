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
	// "Listening" means a TCP connect to 127.0.0.1:<port> succeeds. Next binds the port before it can compile anything, so there is a short
	// window where the URL accepts connections but the first page is still compiling (that request is just slow, not refused).
	waitListening = async ({ port, pid }) => {
		const until = Date.now() + (Number(env.PREVIEW_SLOT_WAIT_MS) || 60_000);
		while (Date.now() < until) {
			if (!(await probePortFree(port))) return true;
			if (!defaultIsAlive(pid, { home, port })) return false;
			await sleepAsync(500);
		}
		return false;
	},
	max = Number(env.PREVIEW_SLOT_MAX) || SLOT_MAX,
	idleMs = Number(env.PREVIEW_SLOT_IDLE_MS) || SLOT_IDLE_MS,
	lockWaitMs = 5000,
} = {}) {
	max = Math.min(max, SLOT_MAX_CAP);
	const dir = path.join(home, ".wolfpack", "preview");
	const file = path.join(dir, "slots.json");
	const lockFile = path.join(dir, "slots.lock");

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
				continue;
			}
			if (t - s.lastUsed > idleMs) {
				kill(s.pid, rec);
				stopped.push(s.port);
				continue;
			}
			keep.push(s);
		}
		write(keep);
		return { slots: keep, stopped };
	};
	const url = (port) => `http://127.0.0.1:${port}`;
	const logOf = (port) => path.join(dir, "slots", `${port}.log`);

	return {
		async get(worktree) {
			let slot;
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
					let port = SLOT_BASE_PORT;
					while (slots.some((s) => s.port === port) || !(await portFree(port))) port++;
					const hub = resolveHub({ home, env });
					const access = hub
						? { WOLFPACK_HUB_URL: hub.url, HUBD_PUBLIC_URL: hub.publicUrl, WOLFPACK_CONSOLE_PUBLIC_ORIGIN: url(port) }
						: { WOLFPACK_API_URL: `http://127.0.0.1:${env.STACK_PORT || 7141}` };
					const childEnv = {
						...access,
						...(env.WOLFPACK_HUB_TOKEN ? { WOLFPACK_HUB_TOKEN: env.WOLFPACK_HUB_TOKEN } : {}),
						...(env.PREVIEW_SLOT_TICK_MS ? { PREVIEW_SLOT_TICK_MS: env.PREVIEW_SLOT_TICK_MS } : {}),
						PORT: String(port),
						HOSTNAME: "127.0.0.1",
						HOME: home,
						WOLFPACK_AUTH_FILE: path.join(dir, "auth.json"),
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
			if (!(await waitListening({ port: slot.port, pid: slot.pid }))) throw new Error(`slot ${slot.port} for ${worktree} is not listening yet; see ${logOf(slot.port)} (\`wolfpack preview slot release ${slot.port}\` stops it)`);
			return { port: slot.port, url: url(slot.port), pid: slot.pid, reused: slot.reused, noToken: !env.WOLFPACK_HUB_TOKEN };
		},
		list: async () => settled(await locked(() => sweep().slots)),
		/** Read-only view for `status`: no lock, no sweep, no write. Dead slots are just left out. */
		peek: () => read().filter((s) => isAlive(s.pid, { ...s, home })),
		/** Stop idle and dead slots. → [port] stopped for idleness */
		reap: async () => settled(await locked(() => sweep().stopped)),
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
				write(slots.filter((x) => x !== s));
				return s.port;
			}));
		},
	};
}
