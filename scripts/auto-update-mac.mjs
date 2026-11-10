#!/usr/bin/env node
/**
 * Mac auto-update (work-wolfpack-qrU6cCO): refresh the live stack after a stable release, with no hand steps.
 *
 * What the scripts actually do on the Mac (checked, not assumed): the live stack runs from ~/wolves/local/runtime/wolfpack, a
 * worktree of the `stable` branch (RUNTIME_BRANCH, default stable), and `pnpm runtime:update` fast-forwards it to origin/stable
 * (ff-only; it refuses a dirty or diverged tree, never merges or rebases), builds, restamps VERSION and refreshes den extensions.
 * No release asset is installed on the Mac. So "update" here is exactly: runtime:update, then `pnpm stack restart`, then /healthz.
 *
 * One unit, `stack`: current = the running workerd's /healthz version, target = the manifest's workerd version. The core rules
 * (opt-in, kill switch, lock, failed = stop and never retry the same version, dev builds never touched) are runAutoUpdate's
 * (scripts/auto-update.mjs). When runtime:update succeeds but the checkout still stamps an older version (RUNTIME_BRANCH is a
 * working branch that has not had stable merged back), the unit fails with code `behind-stable` and the message
 * "Mac behind stable: merge stable back"; nothing is merged or pulled for you. Run `--clear-failed` after merging.
 *
 *   node scripts/auto-update-mac.mjs run [--now] [--clear-failed]
 *   node scripts/auto-update-mac.mjs status                         print the status file (also shown by `pnpm stack status`)
 *   node scripts/auto-update-mac.mjs install | uninstall            write / remove the launchd plist (loads nothing; see printed steps)
 * Opt-in: WOLFPACK_AUTO_UPDATE=1 in the plist's environment (written by `install`). Kill switch: ~/.wolfpack/auto-update.disabled.
 * Files: ~/.wolfpack/auto-update/status.json, lock ~/.wolfpack/auto-update/run.lock, log ~/wolves/local/logs/auto-update.log.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_URL, readStatus, runAutoUpdate } from "./auto-update.mjs";
import { liveWolvesDir, packHome } from "./live-paths.mjs";

const LABEL = "com.wolfpack.auto-update";
/** Every 30 minutes; releases land a few times a week. */
export const INTERVAL_S = 1800;

export function macPaths(env = process.env, home = os.homedir()) {
	const pack = packHome(env, home);
	const wolves = liveWolvesDir(env, home);
	const runtime = env.STACK_RUNTIME || path.join(wolves, "runtime/wolfpack");
	return {
		runtime,
		statusFile: path.join(pack, "auto-update/status.json"),
		lockFile: path.join(pack, "auto-update/run.lock"),
		disabledFile: path.join(pack, "auto-update.disabled"),
		log: path.join(wolves, "logs/auto-update.log"),
		plist: path.join(env.STACK_PLIST_DIR || path.join(home, "Library/LaunchAgents"), `${LABEL}.plist`),
		port: Number(env.STACK_PORT || 7141),
	};
}

const firstLine = (f) => {
	try {
		return fs.readFileSync(f, "utf8").split("\n")[0].trim() || null;
	} catch {
		return null;
	}
};
const core = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? "")?.slice(1, 4).map(Number) ?? null;
const atLeast = (a, b) => {
	const x = core(a);
	const y = core(b);
	return !!x && !!y && (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) >= 0;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthVersion(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) });
		const body = await res.json();
		return res.ok && body?.ok !== false && typeof body?.version === "string" ? body.version : null;
	} catch {
		return null;
	}
}

/** Real Mac deps. runtime:update and stack restart run from the runtime checkout (the same scripts a person would run). */
export function macDeps(p, env = process.env) {
	const node = (script, args) => spawnSync(process.execPath, [path.join(p.runtime, "scripts", script), ...args], { cwd: p.runtime, env, stdio: "inherit" }).status;
	return {
		fetchManifest: async () => {
			const r = await fetch(env.WOLFPACK_UPDATE_MANIFEST_URL?.trim() || MANIFEST_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.json();
		},
		currentVersion: () => healthVersion(p.port),
		install: (_u, entry) => {
			// runtime:update quietly falls back to npm without pnpm; under launchd that means a wrong install, so stop here instead.
			const pnpm = spawnSync("pnpm", ["--version"], { env, stdio: "ignore" });
			if (pnpm.error || pnpm.status !== 0) return { ok: false, code: "no-pnpm", message: `pnpm not found on PATH (${env.PATH ?? "unset"}); reinstall the plist: node scripts/auto-update-mac.mjs install` };
			if (node("runtime-update.mjs", []) !== 0) return { ok: false, code: "refresh-failed", message: "pnpm runtime:update failed (dirty or diverged runtime, fetch or build error); see the log" };
			const stamped = firstLine(path.join(p.runtime, "packages/workerd/VERSION"));
			if (!atLeast(stamped, entry.version)) return { ok: false, code: "behind-stable", message: `Mac behind stable: merge stable back (checkout stamps ${stamped ?? "no version"}, stable is ${entry.version})` };
			if (node("stack.mjs", ["restart"]) !== 0) return { ok: false, code: "restart-failed", message: "pnpm stack restart failed" };
			return { ok: true };
		},
		probe: async (_u, entry) => {
			let v = null;
			for (let i = 0; i < 40; i++) {
				await sleep(3_000); // restart is fire-and-forget: the helper waits 2s, then SIGTERMs (up to 40s)
				v = await healthVersion(p.port);
				if (atLeast(v, entry.version)) return { healthy: true };
			}
			return { healthy: false, message: `/healthz on :${p.port} reports ${v ?? "no answer"} after the restart, want ${entry.version}` };
		},
	};
}

/** `command -v <name>` in a login-like shell; → absolute path or null. */
function which(name) {
	const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
	const p = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
	return p.startsWith("/") ? p : null;
}
const nodeMajor = (bin) => spawnSync(bin, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" }).stdout?.trim() || null;

/**
 * The node the plist runs. A versioned path (nvm, fnm, asdf: it breaks when that version is removed) is swapped for a stable
 * symlink (Homebrew /opt/homebrew/bin/node, /usr/local/bin/node) only when that one runs the same major version; otherwise the
 * versioned path is kept and `stable: false` tells the caller to warn (the plist must be reinstalled after a node upgrade).
 */
export function chooseNode(found) {
	if (!/\/(\.nvm|\.fnm|\.asdf|\.volta|\.local\/share\/fnm)\//.test(found)) return { node: found, stable: true };
	const major = nodeMajor(found);
	for (const c of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) if (fs.existsSync(c) && major && nodeMajor(c) === major) return { node: c, stable: true };
	return { node: found, stable: false };
}

/** launchd plist: runs `run` every INTERVAL_S and at load. No secrets; opt-in flag in its environment. `binDirs`: node's and pnpm's dirs. */
export function buildPlist(p, nodePath, home = os.homedir(), binDirs = []) {
	const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const pathEnv = [...new Set([path.dirname(nodePath), ...binDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${esc(nodePath)}</string>
		<string>${esc(path.join(p.runtime, "scripts/auto-update-mac.mjs"))}</string>
		<string>run</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${esc(p.runtime)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>${esc(home)}</string>
		<key>PATH</key>
		<string>${esc(pathEnv)}</string>
		<key>WOLFPACK_AUTO_UPDATE</key>
		<string>1</string>
	</dict>
	<key>StartInterval</key>
	<integer>${INTERVAL_S}</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${esc(p.log)}</string>
	<key>StandardErrorPath</key>
	<string>${esc(p.log)}</string>
</dict>
</plist>
`;
}

export async function main(argv, env = process.env) {
	const [cmd, ...flags] = argv;
	const p = macPaths(env);
	if (cmd === "status") {
		console.log(JSON.stringify(readStatus(p.statusFile), null, 2));
		return 0;
	}
	if (cmd === "install") {
		fs.mkdirSync(path.dirname(p.plist), { recursive: true });
		fs.mkdirSync(path.dirname(p.log), { recursive: true });
		const foundNode = which("node") ?? process.execPath;
		const pnpm = which("pnpm");
		if (!pnpm) {
			console.error("pnpm not found on PATH (command -v pnpm); install it (corepack enable) and run install again. Nothing written.");
			return 1;
		}
		const { node, stable } = chooseNode(foundNode);
		fs.writeFileSync(p.plist, buildPlist(p, node, os.homedir(), [path.dirname(foundNode), path.dirname(pnpm)]), { mode: 0o600 });
		console.log(`wrote ${p.plist} (node ${node}, pnpm ${pnpm}); nothing loaded. Turn it on: launchctl bootstrap gui/$(id -u) ${p.plist}`);
		if (!stable) console.log(`note: ${node} is a versioned path; run install again after every node upgrade or removal (RUNBOOK.md).`);
		return 0;
	}
	if (cmd === "uninstall") {
		spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}/${LABEL}`], { stdio: "ignore" });
		fs.rmSync(p.plist, { force: true });
		console.log(`removed ${p.plist}`);
		return 0;
	}
	if (cmd !== "run") {
		console.error("usage: auto-update-mac.mjs run [--now] [--clear-failed] | status | install | uninstall");
		return 2;
	}
	const { result } = await runAutoUpdate({
		host: os.hostname().replace(/\.local$/, "") || "mac",
		units: [{ id: "stack", component: "workerd" }],
		statusFile: p.statusFile,
		lockFile: p.lockFile,
		disabledFile: p.disabledFile,
		enabled: env.WOLFPACK_AUTO_UPDATE === "1",
		manual: flags.includes("--now"),
		clearFailed: flags.includes("--clear-failed"),
		deps: macDeps(p, env),
		log: (m) => console.log(`${new Date().toISOString()} ${m}`),
	});
	console.log(`auto-update: ${result}`);
	return result === "failed" || result === "manifest-error" ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).then((c) => (process.exitCode = c));
}
