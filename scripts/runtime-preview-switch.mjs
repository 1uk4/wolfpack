#!/usr/bin/env node
/**
 * Detached helper for `wolfpack preview`: restart the launchd stack, poll /healthz, record the result.
 * Self-contained (node builtins only) because runtime-preview.mjs copies it to ~/.wolfpack/preview/ and runs it from there:
 * the runtime tree is being switched under it and the CLI's own dist lives in that tree.
 * Usage: node runtime-preview-switch.mjs <stateFile> <plist> <label> <port> <okPhase> <clear:0|1>
 * Phases written to the state file: switching -> okPhase | unhealthy (stack up, /healthz silent) | stack-down (bootstrap kept
 * failing: nothing is running) | plist-missing (aborted before stopping anything). clear=1 deletes the state file on success.
 * `runSwitch` takes launchctl, sleep and health as parameters so tests are instant; the CLI entry below uses the real ones.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { CONSOLE_LABEL, applyApps, planApps, recoverApps, restoreApps, startConsole, stopConsole } from "./runtime-preview-console.mjs";

const BOOTSTRAP_TRIES = 5;

/** True when nothing listens on 127.0.0.1:<port>. */
export const probePortFree = (port) =>
	new Promise((resolve) => {
		const sock = net.connect({ host: "127.0.0.1", port: Number(port) });
		sock.once("connect", () => (sock.destroy(), resolve(false)));
		sock.once("error", () => resolve(true));
	});

export const MANUAL_WAY_BACK = (plist, { loaded = false } = {}) =>
	[
		"Manual way back:",
		"  cd ~/wolves/local/runtime/wolfpack && git checkout stable && pnpm install --frozen-lockfile --prefer-offline && node scripts/turbo.mjs run build",
		loaded ? "  launchctl kickstart -k gui/$(id -u)/com.wolfpack.stack   # the stack is still loaded; restart it on the restored build" : `  launchctl bootstrap gui/$(id -u) ${plist}`,
	].join("\n");

/**
 * Deep health: prove the app reaches real data, not just /healthz. The console must list at least one wolf and answer a chat list;
 * when the console is down, wolfd's /v1/wolves tells the two failures apart. Returns {ok, reason}.
 */
export async function deepCheck({ consoleUrl, port, fetchJson }) {
	try {
		const wolves = (await fetchJson(`${consoleUrl}/api/wolves`))?.wolves;
		if (!Array.isArray(wolves) || wolves.length === 0) return { ok: false, reason: `${consoleUrl}/api/wolves listed no wolves` };
		if (!Array.isArray((await fetchJson(`${consoleUrl}/api/chats`))?.chats)) return { ok: false, reason: `${consoleUrl}/api/chats did not return a chat list` };
		return { ok: true };
	} catch (err) {
		let wolfd = "wolfd did not answer either";
		try {
			const w = (await fetchJson(`http://127.0.0.1:${port}/v1/wolves`))?.wolves;
			if (Array.isArray(w) && w.length > 0) wolfd = "wolfd answers with wolves, so the problem is the console";
		} catch {}
		return { ok: false, reason: `the console at ${consoleUrl} is not answering (${err.message}); ${wolfd}` };
	}
}

/**
 * Returns the exit code (0 healthy, 1 otherwise). With `deep` ({consoleUrl}) + `fetchJson` the new stack must also pass deepCheck;
 * on failure `rollback()` (check out previousRef and build, resolves true/false) runs, the stack restarts, and the state ends
 * rolled-back with the reason; a failed rollback ends stack-down.
 */
export async function runSwitch({ stateFile, plist, label, port, okPhase, clear, uid, launchctl, sleep, health, log = console.log, exists = fs.existsSync, deep, fetchJson, rollback, localConsole, portFree = probePortFree }) {
	const say = (m) => log(`${new Date().toISOString()} ${m}`);
	// Phase-only writes warn; a write that carries `apps` must succeed or fail loudly (it is the only record of the owner's consoleUrl).
	const setPhase = (phase, extra = {}) => {
		try {
			const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			fs.writeFileSync(stateFile, `${JSON.stringify({ ...s, ...extra, phase }, null, 2)}\n`);
		} catch (err) {
			if (extra.apps) throw err;
			say(`warning: could not write ${stateFile}: ${err.message}`);
		}
	};
	const readState = () => {
		try {
			return JSON.parse(fs.readFileSync(stateFile, "utf8"));
		} catch {
			return {};
		}
	};
	const lc = localConsole;
	const teardownConsole = () => {
		if (!lc || lc.keepConsole) return; // a dev console outlives a ref preview switch; only `off` stops it
		stopConsole({ home: lc.home, uid, launchctl });
		restoreApps(readState().apps ?? recoverApps({ root: lc.userDataRoot, url: `http://127.0.0.1:${lc.port}` }));
		setPhase(readState().phase, { apps: undefined });
	};
	const restart = async () => {
		say("stopping the stack");
		launchctl("bootout", `gui/${uid}/${label}`); // not loaded is fine
		await sleep(3000);
		say("starting the stack");
		for (let i = 1; i <= BOOTSTRAP_TRIES; i++) {
			if (launchctl("bootstrap", `gui/${uid}`, plist) === 0) return true;
			say(`launchctl bootstrap failed (attempt ${i}/${BOOTSTRAP_TRIES})`);
			if (i < BOOTSTRAP_TRIES) await sleep(2000);
		}
		return false;
	};
	const waitHealthz = async () => {
		for (let i = 0; i < 30; i++) {
			if (await health(port)) return true;
			await sleep(2000);
		}
		return false;
	};
	const down = (why) => {
		say(`the stack is DOWN${why ? ` (${why})` : ""}. Recover with: launchctl bootstrap gui/${uid} ${plist}`);
		say(MANUAL_WAY_BACK(plist));
		setPhase("stack-down");
		return 1;
	};
	// The rollback could not restore the previous build: the stack is still loaded and still running the preview build.
	const stuckOnPreview = (why) => {
		say(`${why}: the stack is still running the preview build (it is loaded, not down).`);
		say(MANUAL_WAY_BACK(plist, { loaded: true }));
		setPhase("stack-down");
		return 1;
	};
	if (!exists(plist)) {
		say(`plist ${plist} does not exist: not stopping anything`);
		setPhase("plist-missing");
		return 1;
	}
	setPhase("switching");
	if (!(await restart())) return down();
	let reason;
	if (await waitHealthz()) {
		say(`healthz answered on ${port}`);
		if (lc && !clear && !lc.keepConsole) {
			stopConsole({ home: lc.home, uid, launchctl }); // a console left by an earlier preview would hold the port
			await sleep(1000);
			try {
				if (!(await portFree(lc.port))) throw new Error(`port ${lc.port} is already in use by something else`);
				startConsole({ home: lc.home, runtimeDir: lc.runtimeDir, port: lc.port, stackPort: port, node: lc.node, uid, launchctl });
			} catch (err) {
				reason = `the preview console would not start: ${err.message}`;
			}
		}
		if (reason === undefined && deep && fetchJson) {
			let r = { ok: false };
			for (let i = 0; i < 15 && !r.ok; i++) {
				r = await deepCheck({ consoleUrl: deep.consoleUrl, port, fetchJson });
				if (!r.ok) await sleep(2000);
			}
			if (!r.ok) reason = r.reason;
		}
	} else {
		reason = "healthz did not answer within 60s";
		if (!(deep && rollback)) {
			say(`${reason} (the stack is bootstrapped, so it may still be starting)`);
			say(MANUAL_WAY_BACK(plist));
			if (clear) teardownConsole(); // off: never leave the app pointed at a preview console
			setPhase("unhealthy");
			return 1;
		}
	}
	if (reason === undefined) {
		if (clear) {
			teardownConsole();
			fs.rmSync(stateFile, { force: true });
		} else {
			if (lc && !lc.keepConsole) {
				const url = `http://127.0.0.1:${lc.port}`;
				try {
					const apps = planApps({ root: lc.userDataRoot, url, existing: readState().apps });
					setPhase(okPhase, { apps }); // state first: if this throws, no console.json was touched
					applyApps(apps, url);
				} catch (err) {
					stopConsole({ home: lc.home, uid, launchctl });
					throw err;
				}
			} else setPhase(okPhase);
			if (lc) say(`quit and reopen Wolfpack Console: it now loads http://127.0.0.1:${lc.port}`);
		}
		return 0;
	}
	say(`deep health check failed: ${reason}`);
	teardownConsole();
	if (!rollback) {
		setPhase("unhealthy", { reason });
		return 1;
	}
	say("rolling back to the previous ref");
	setPhase("rolling-back", { reason });
	if (!(await rollback())) return stuckOnPreview("the rollback failed");
	if (!(await restart())) return down("it did not restart after the rollback");
	if (!(await waitHealthz())) return stuckOnPreview("healthz did not answer after the rollback");
	say("rolled back; the stack is healthy on the previous ref");
	setPhase("rolled-back", { reason });
	return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const [stateFile, plist, label, port, okPhase, clear] = process.argv.slice(2);
	let st = {};
	try {
		st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	} catch {}
	const fetchJson = async (url) => {
		const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
		if (!r.ok) throw new Error(`${url} answered ${r.status}`);
		return r.json();
	};
	const here = path.dirname(fileURLToPath(import.meta.url));
	const code = await runSwitch({
		stateFile, plist, label, port, okPhase, clear: clear === "1", uid: process.getuid?.() ?? 501,
		launchctl: (...args) => spawnSync("launchctl", args, { stdio: "inherit" }).status,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		health: async (p) => {
			try {
				return (await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
			} catch {
				return false;
			}
		},
		// Only a preview switch ("on") that started a local console is deep-checked and can roll back.
		...(st.consolePort
			? {
					localConsole: { port: String(st.consolePort), home: process.env.HOME || os.homedir(), userDataRoot: process.env.PREVIEW_USERDATA_ROOT || path.join(process.env.HOME || os.homedir(), "Library", "Application Support"), runtimeDir: st.runtimeDir, node: process.execPath, keepConsole: st.console?.mode === "dev" && clear !== "1" },
				}
			: {}),
		...(st.consolePort && clear !== "1"
			? {
					deep: { consoleUrl: `http://127.0.0.1:${st.consolePort}` },
					fetchJson,
					rollback: async () => spawnSync(process.execPath, [path.join(here, "runtime-preview.mjs"), "off", "--rollback"], { stdio: "inherit" }).status === 0,
				}
			: {}),
	});
	process.exit(code);
}
