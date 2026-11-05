#!/usr/bin/env node
/**
 * Live stack manager: `npm run stack -- <cmd>`.
 * Runs the HEADLESS live stack (workerd, which supervises one wolfd per wolf in ~/wolves/local) as a per-user launchd
 * agent: starts at login, restarts after a crash, keeps the Mac awake (caffeinate), logs to a file.
 *
 *   install            write the plist (no start)          uninstall   stop + remove the plist
 *   start              bootstrap + start the service        stop        bootout (stays installed, won't start at login until `start`)
 *   restart            kickstart -k (safe from inside a wolf turn)
 *   status             loaded/running, PID, uptime, port, wolfd children, log tail on trouble
 *   logs [-f] [-n N]   tail the log
 *   adopt --yes        cutover: kill a hand-started workerd tree on the port, install if needed, start the service
 *
 * Env overrides (mainly for tests): STACK_LABEL, STACK_PORT, STACK_WOLVES, STACK_RUNTIME, STACK_LOG, STACK_PLIST_DIR,
 * STACK_WORKERD_JS (path of the script to run instead of <runtime>/packages/workerd/dist/bin/workerd.js).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMMANDS = ["install", "uninstall", "start", "stop", "restart", "status", "logs", "adopt"];
export const LOG_CAP_BYTES = 10 * 1024 * 1024;

export function parseArgs(argv) {
	const [cmd, ...rest] = argv;
	if (!cmd || !COMMANDS.includes(cmd)) throw new Error(`usage: npm run stack -- <${COMMANDS.join("|")}> [-f] [-n N] [--yes]${cmd ? ` (unknown command "${cmd}")` : ""}`);
	const flags = { follow: false, lines: 50, yes: false, foreground: false };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (cmd === "logs" && (a === "-f" || a === "--follow")) flags.follow = true;
		else if (cmd === "logs" && (a === "-n" || a === "--lines")) {
			const n = Number(rest[++i]);
			if (!Number.isInteger(n) || n < 1) throw new Error("-n needs a positive integer");
			flags.lines = n;
		} else if (cmd === "adopt" && a === "--yes") flags.yes = true;
		else if (cmd === "adopt" && a === "--foreground") flags.foreground = true;
		else throw new Error(`unknown option "${a}" for ${cmd}`);
	}
	return { cmd, flags };
}

export function resolveConfig(env = process.env, home = os.homedir(), uid = process.getuid?.() ?? 501) {
	const wolves = env.STACK_WOLVES || path.join(home, "wolves/local");
	const runtime = env.STACK_RUNTIME || path.join(wolves, "runtime/wolfpack");
	const label = env.STACK_LABEL || "com.wolfpack.stack";
	const port = Number(env.STACK_PORT || 7141);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad STACK_PORT "${env.STACK_PORT}"`);
	const plistDir = env.STACK_PLIST_DIR || path.join(home, "Library/LaunchAgents");
	return {
		home, uid, label, port, wolves, runtime,
		workerdJs: env.STACK_WORKERD_JS || path.join(runtime, "packages/workerd/dist/bin/workerd.js"),
		log: env.STACK_LOG || path.join(wolves, "logs/stack.log"),
		plistDir,
		plist: path.join(plistDir, `${label}.plist`),
		domain: `gui/${uid}`,
		target: `gui/${uid}/${label}`,
	};
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (k, v) => `\t<key>${k}</key>\n\t<string>${esc(v)}</string>\n`;

/** PATH for the service: node's dir first, then the dirs of git/claude found at install time, then the usual system dirs. */
export function servicePath(nodePath, extraDirs = [], env = process.env) {
	const dirs = [path.dirname(nodePath), ...extraDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", path.join(env.HOME || "", ".local/bin")];
	return [...new Set(dirs.filter(Boolean))].join(":");
}

export function programArguments(cfg, nodePath) {
	return ["/usr/bin/caffeinate", "-is", nodePath, cfg.workerdJs, "--wolves", cfg.wolves, "--port", String(cfg.port)];
}

/**
 * launchd plist. KeepAlive=true restarts on any exit (a deliberate `stop` boots it out, so it stays down).
 * ThrottleInterval 15 keeps a crash loop from spinning. ProcessType Interactive avoids App Nap style throttling.
 */
export function buildPlist(cfg, nodePath, pathEnv) {
	const args = programArguments(cfg, nodePath).map((a) => `\t\t<string>${esc(a)}</string>\n`).join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${str("Label", cfg.label)}\t<key>ProgramArguments</key>
\t<array>
${args}\t</array>
${str("WorkingDirectory", cfg.runtime)}\t<key>EnvironmentVariables</key>
\t<dict>
\t${str("HOME", cfg.home).replace(/\n\t/g, "\n\t\t").trimStart().replace(/^/, "\t")}\t\t${str("PATH", pathEnv).replace(/\n\t/g, "\n\t\t").trimStart()}\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>15</integer>
\t<key>ExitTimeOut</key>
\t<integer>20</integer>
\t<key>ProcessType</key>
\t<string>Interactive</string>
${str("StandardOutPath", cfg.log)}${str("StandardErrorPath", cfg.log)}</dict>
</plist>
`;
}

/** Parse `lsof -Fpc` output into [{pid, command}]. */
export function parseLsof(out) {
	const res = [];
	let cur;
	for (const line of out.split("\n")) {
		if (line.startsWith("p")) res.push((cur = { pid: Number(line.slice(1)), command: "" }));
		else if (line.startsWith("c") && cur) cur.command = line.slice(1);
	}
	return res;
}

/** Listener(s) on a TCP port that are not `ownPid`. Empty list = free (or only ours). */
export function portConflicts(listeners, ownPid) {
	return listeners.filter((l) => l.pid !== ownPid);
}

export function conflictMessage(cfg, listeners) {
	const who = listeners.map((l) => `${l.command || "?"} (pid ${l.pid})`).join(", ");
	return `port ${cfg.port} is already in use by ${who}.\nIf that is the hand-started workerd, hand over with:  npm run stack -- adopt --yes\n(or stop it yourself: kill <pid>; its wolfd children exit with it), then run start again.`;
}

/** Parse `launchctl print` text into {state, pid, lastExit}. */
export function parseLaunchctlPrint(text) {
	const pick = (re) => text.match(re)?.[1];
	const pid = pick(/^\s*pid = (\d+)/m);
	return { state: pick(/^\s*state = (\S+)/m) ?? "unknown", pid: pid ? Number(pid) : undefined, lastExit: pick(/^\s*last exit code = (.+)$/m) };
}

/** Parse `ps -axo pid=,ppid=,etime=,command=` into rows. */
export function parsePs(out) {
	return out.split("\n").map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], command: m[4] }));
}
export const descendants = (rows, root) => {
	const out = [];
	const todo = [root];
	while (todo.length) {
		const p = todo.pop();
		for (const r of rows) if (r.ppid === p && !out.some((o) => o.pid === r.pid)) (out.push(r), todo.push(r.pid));
	}
	return out;
};
export const ancestors = (rows, pid) => {
	const by = new Map(rows.map((r) => [r.pid, r]));
	const out = [];
	for (let r = by.get(pid); r && r.ppid > 1 && out.length < 64; r = by.get(r.ppid)) out.push(r.ppid);
	return out;
};

// ---- side-effecting layer ----
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const psRows = () => parsePs(sh("ps", ["-axo", "pid=,ppid=,etime=,command="]).stdout ?? "");
const listeners = (port) => parseLsof(sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]).stdout ?? "");
const printService = (cfg) => {
	const r = sh("launchctl", ["print", cfg.target]);
	return r.status === 0 ? parseLaunchctlPrint(r.stdout) : undefined;
};
const which = (bin) => { const r = sh("/usr/bin/which", [bin]); return r.status === 0 ? r.stdout.trim() : undefined; };
const say = (m) => console.log(m);

export function rotateLog(log, cap = LOG_CAP_BYTES) {
	try {
		if (fs.statSync(log).size > cap) fs.renameSync(log, `${log}.1`);
	} catch { /* no log yet */ }
}

function install(cfg) {
	if (!fs.existsSync(cfg.workerdJs)) throw new Error(`${cfg.workerdJs} not found; build the runtime checkout first (${cfg.runtime}: npm install && npx turbo run build)`);
	const nodePath = process.execPath;
	const extra = ["git", "claude"].map(which).filter(Boolean).map((p) => path.dirname(p));
	fs.mkdirSync(cfg.plistDir, { recursive: true });
	fs.mkdirSync(path.dirname(cfg.log), { recursive: true });
	rotateLog(cfg.log);
	fs.writeFileSync(cfg.plist, buildPlist(cfg, nodePath, servicePath(nodePath, extra)));
	say(`installed ${cfg.plist} (node ${nodePath})`);
}

function requireFree(cfg) {
	const svc = printService(cfg);
	const bad = portConflicts(listeners(cfg.port), svc?.pid);
	if (bad.length) throw new Error(conflictMessage(cfg, bad));
}

function start(cfg) {
	if (!fs.existsSync(cfg.plist)) install(cfg);
	const svc = printService(cfg);
	if (svc?.state === "running") return say(`already running (pid ${svc.pid})`);
	requireFree(cfg);
	rotateLog(cfg.log);
	if (!svc) {
		const r = sh("launchctl", ["bootstrap", cfg.domain, cfg.plist]);
		if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`);
	} else sh("launchctl", ["kickstart", cfg.target]);
	say(`started ${cfg.label}`);
}

function stop(cfg) {
	if (!printService(cfg)) return say("not loaded");
	const r = sh("launchctl", ["bootout", cfg.target]);
	if (r.status !== 0) throw new Error(`launchctl bootout failed: ${(r.stderr || r.stdout).trim()}`);
	say(`stopped ${cfg.label} (still installed; \`start\` brings it back)`);
}

/**
 * restart from inside a wolf turn: the caller is a descendant of the service, and launchd kills the service's process
 * group when it restarts it, so the caller dies mid-command. `kickstart -k` is a single request to launchd, which then
 * does the kill+relaunch itself, but we don't rely on the caller surviving long enough to send it cleanly: we hand the
 * request to a helper started with `detached: true` (setsid: own session + process group, so launchd's group kill misses
 * it), reparented to launchd, which sleeps briefly (lets this process print its reply) and then runs kickstart -k.
 */
function restart(cfg) {
	if (!printService(cfg)) { start(cfg); return; }
	rotateLog(cfg.log);
	const child = spawn("/bin/sh", ["-c", `sleep 2; exec launchctl kickstart -k ${cfg.target}`], { detached: true, stdio: "ignore" });
	child.unref();
	say(`restart requested for ${cfg.label} (helper pid ${child.pid}); the service restarts in ~2s. Check with: npm run stack -- status`);
}

function status(cfg) {
	const svc = printService(cfg);
	say(`label:     ${cfg.label}${fs.existsSync(cfg.plist) ? "" : "  (plist not installed)"}`);
	if (!svc) say("service:   not loaded (npm run stack -- start)");
	else say(`service:   loaded, ${svc.state}${svc.pid ? `, pid ${svc.pid}` : ""}${svc.lastExit ? `, last exit ${svc.lastExit}` : ""}`);
	const rows = psRows();
	if (svc?.pid) {
		const me = rows.find((r) => r.pid === svc.pid);
		if (me) say(`uptime:    ${me.etime}`);
	}
	const ls = listeners(cfg.port);
	say(`port ${cfg.port}:   ${ls.length ? `listening (${ls.map((l) => `${l.command} ${l.pid}`).join(", ")})` : "NOT listening"}`);
	if (svc?.pid) {
		const kids = descendants(rows, svc.pid).filter((r) => /wolfd/.test(r.command));
		say(`wolfd:     ${kids.length ? kids.map((k) => `pid ${k.pid} (up ${k.etime})`).join(", ") : "none"}`);
	}
	const healthy = svc?.state === "running" && ls.length > 0;
	if (!healthy) {
		say(`\nlast log lines (${cfg.log}):`);
		const t = sh("tail", ["-n", "15", cfg.log]);
		say(t.status === 0 ? t.stdout.trimEnd() : "(no log)");
		process.exitCode = 1;
	}
}

function logs(cfg, flags) {
	if (!fs.existsSync(cfg.log)) throw new Error(`no log at ${cfg.log}`);
	spawnSync("tail", [...(flags.follow ? ["-f"] : []), "-n", String(flags.lines), cfg.log], { stdio: "inherit" });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Cutover. The hand-started tree may be this process's own ancestor (called from a wolf turn), so unless
 * --foreground we re-spawn ourselves detached (own session) writing to <logdir>/stack-adopt.log, and return at once.
 */
async function adopt(cfg, flags) {
	const ls = listeners(cfg.port);
	const svc = printService(cfg);
	const strays = portConflicts(ls, svc?.pid);
	say(strays.length ? `port ${cfg.port}: ${strays.map((l) => `${l.command} ${l.pid}`).join(", ")} (to be stopped)` : `port ${cfg.port}: nothing foreign listening`);
	if (!flags.yes) return say("dry run. This stops the hand-started workerd + wolfd tree (killing any wolf turn running in it), then installs and starts the launchd service.\nRe-run with --yes to do it.");
	if (!flags.foreground) {
		const logFile = path.join(path.dirname(cfg.log), "stack-adopt.log");
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		const fd = fs.openSync(logFile, "a");
		const c = spawn(process.execPath, [fileURLToPath(import.meta.url), "adopt", "--yes", "--foreground"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
		c.unref();
		return say(`adopt running detached (pid ${c.pid}); progress in ${logFile}. Then: npm run stack -- status`);
	}
	await sleep(1500);
	const rows = psRows();
	const victims = new Set();
	for (const l of strays) {
		victims.add(l.pid);
		for (const d of descendants(rows, l.pid)) victims.add(d.pid);
		// the caffeinate wrapper of a hand-started stack is the parent; take it so it doesn't linger
		const parent = rows.find((r) => r.pid === rows.find((x) => x.pid === l.pid)?.ppid);
		if (parent && /caffeinate/.test(parent.command)) victims.add(parent.pid);
	}
	victims.delete(process.pid);
	for (const pid of victims) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	for (let i = 0; i < 30 && [...victims].some(alive); i++) await sleep(500);
	for (const pid of victims) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
	await sleep(500);
	say(`stopped ${victims.size} process(es)`);
	install(cfg);
	if (printService(cfg)) stop(cfg);
	start(cfg);
	say("adopt done");
}

export async function main(argv, env = process.env) {
	const { cmd, flags } = parseArgs(argv);
	const cfg = resolveConfig(env);
	if (process.platform !== "darwin") throw new Error("stack: launchd is macOS-only");
	switch (cmd) {
		case "install": return install(cfg);
		case "uninstall": if (printService(cfg)) stop(cfg); fs.rmSync(cfg.plist, { force: true }); return say(`removed ${cfg.plist}`);
		case "start": return start(cfg);
		case "stop": return stop(cfg);
		case "restart": return restart(cfg);
		case "status": return status(cfg);
		case "logs": return logs(cfg, flags);
		case "adopt": return adopt(cfg, flags);
	}
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).catch((e) => { console.error(`stack: ${e.message}`); process.exit(1); });
}
