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
import { fileURLToPath } from "node:url";

const BOOTSTRAP_TRIES = 5;

export const MANUAL_WAY_BACK = (plist) =>
	[
		"Manual way back:",
		"  cd ~/wolves/local/runtime/wolfpack && git checkout stable && pnpm install --frozen-lockfile --prefer-offline && node scripts/turbo.mjs run build",
		`  launchctl bootstrap gui/$(id -u) ${plist}`,
	].join("\n");

/** Returns the exit code (0 healthy, 1 otherwise). */
export async function runSwitch({ stateFile, plist, label, port, okPhase, clear, uid, launchctl, sleep, health, log = console.log, exists = fs.existsSync }) {
	const say = (m) => log(`${new Date().toISOString()} ${m}`);
	const setPhase = (phase) => {
		try {
			const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			fs.writeFileSync(stateFile, `${JSON.stringify({ ...s, phase }, null, 2)}\n`);
		} catch {}
	};
	if (!exists(plist)) {
		say(`plist ${plist} does not exist: not stopping anything`);
		setPhase("plist-missing");
		return 1;
	}
	setPhase("switching");
	say("stopping the stack");
	launchctl("bootout", `gui/${uid}/${label}`); // not loaded is fine
	await sleep(3000);
	say("starting the stack");
	let started = false;
	for (let i = 1; i <= BOOTSTRAP_TRIES && !started; i++) {
		started = launchctl("bootstrap", `gui/${uid}`, plist) === 0;
		if (!started) {
			say(`launchctl bootstrap failed (attempt ${i}/${BOOTSTRAP_TRIES})`);
			if (i < BOOTSTRAP_TRIES) await sleep(2000);
		}
	}
	if (!started) {
		say(`the stack is DOWN. Recover with: launchctl bootstrap gui/${uid} ${plist}`);
		say(MANUAL_WAY_BACK(plist));
		setPhase("stack-down");
		return 1;
	}
	for (let i = 0; i < 30; i++) {
		if (await health(port)) {
			say(`healthz answered on ${port}`);
			if (clear) fs.rmSync(stateFile, { force: true });
			else setPhase(okPhase);
			return 0;
		}
		await sleep(2000);
	}
	say("healthz did not answer within 60s (the stack is bootstrapped, so it may still be starting)");
	say(MANUAL_WAY_BACK(plist));
	setPhase("unhealthy");
	return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	const [stateFile, plist, label, port, okPhase, clear] = process.argv.slice(2);
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
	});
	process.exit(code);
}
