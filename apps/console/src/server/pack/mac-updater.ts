/**
 * MAC UPDATE START (work-wolfpack-BPQjV3y): the Update now of a Mac console. The Mac has no systemd; its updater is the launchd agent
 * com.wolfpack.auto-update (scripts/auto-update-mac.mjs). Starting it = `launchctl kickstart gui/<uid>/com.wolfpack.auto-update`
 * (no -k: a run already going is left alone; the script's own lock covers the rest).
 * A kickstart cannot pass `--now`, and a button-mode Mac installs only on a manual run, so the console first writes the request file
 * ~/.wolfpack/auto-update/run-now; the script consumes it and runs as manual (takeRunNow in auto-update-mac.mjs). Progress and the
 * result then come from the script's status file, which /api/updates already reads. Argv only, never a shell.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { macAutoUpdateDir } from "./updater-paths.ts";
import { execRunner, type CommandRunner } from "./pack-health.ts";

export const MAC_UPDATE_LABEL = "com.wolfpack.auto-update";

export type MacUpdateOutcome =
	| { ok: true; service: "update"; at: string }
	| { ok: false; service: "update"; code: "unsupported" | "not_installed" | "failed"; message: string };

export interface MacUpdater {
	start(by: string): Promise<MacUpdateOutcome>;
}

export const defaultRunNowFile = (home = homedir()) => path.join(macAutoUpdateDir(home), "run-now");
/** Same window as RUN_NOW_MAX_AGE_MS in the script: an older request is dropped there, so a new click replaces it. */
const RUN_NOW_FRESH_MS = 2 * 60_000;

export function createMacUpdater(o: { platform?: NodeJS.Platform; uid?: number; getuid?: (() => number) | null; runNowFile?: string; run?: CommandRunner; now?: () => number; log?: (m: string) => void } = {}): MacUpdater {
	const platform = o.platform ?? process.platform;
	const run = o.run ?? execRunner;
	const now = o.now ?? Date.now;
	const log = o.log ?? ((m: string) => console.log(m));
	return {
		async start(by) {
			if (platform !== "darwin") return { ok: false, service: "update", code: "unsupported", message: "This computer has no Mac updater to start." };
			const getuid = o.getuid === undefined ? process.getuid?.bind(process) : o.getuid;
			const uid = o.uid ?? getuid?.();
			if (uid === undefined) return { ok: false, service: "update", code: "unsupported", message: "This computer has no Mac updater to start." };
			const target = `gui/${uid}/${MAC_UPDATE_LABEL}`;
			if ((await run("launchctl", ["print", target])).code !== 0) {
				log(`console: mac update NOT INSTALLED (agent not loaded) by ${by}`);
				return { ok: false, service: "update", code: "not_installed", message: "The Mac updater is not turned on. Run: node scripts/auto-update-mac.mjs install" };
			}
			const file = o.runNowFile ?? defaultRunNowFile();
			try {
				mkdirSync(path.dirname(file), { recursive: true });
				let at = NaN;
				try {
					at = Number(readFileSync(file, "utf8").trim());
					if (!Number.isFinite(at)) at = statSync(file).mtimeMs;
				} catch {}
				if (!(now() - at <= RUN_NOW_FRESH_MS)) {
					rmSync(file, { force: true }); // stale or unreadable: replace it
					const tmp = `${file}.${process.pid}.tmp`;
					writeFileSync(tmp, `${now()}\n`, { mode: 0o600 });
					renameSync(tmp, file);
				}
			} catch {
				return { ok: false, service: "update", code: "failed", message: "Could not ask the Mac updater to run." };
			}
			const r = await run("launchctl", ["kickstart", target]);
			log(`console: mac update by ${by}: ${r.code === 0 ? "started" : `FAILED (exit ${r.code}) ${r.stderr.trim()}`}`);
			if (r.code === 0) return { ok: true, service: "update", at: new Date(now()).toISOString() };
			rmSync(file, { force: true });
			return { ok: false, service: "update", code: "failed", message: "The Mac updater did not start." };
		},
	};
}
