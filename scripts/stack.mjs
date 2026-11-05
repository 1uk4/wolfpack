#!/usr/bin/env node
/**
 * Live stack manager: `npm run stack -- <cmd>`.
 * Runs the HEADLESS live stack (workerd, which supervises one wolfd per wolf in ~/wolves/local) as a per-user launchd
 * agent: starts at login, restarts after a crash, keeps the Mac awake (caffeinate), logs to a file.
 *
 *   start              write the plist if missing, bootstrap + start the service
 *   stop               bootout: stops it now; stays installed and starts again at next login (or `start`)
 *   restart            graceful: SIGTERM, wait for exit, launchd (KeepAlive) relaunches. Kills in-flight turns, including the caller's.
 *   status             loaded/running, PID, uptime, port, wolfd children, log tail on trouble
 *   logs [-f] [-n N]   tail the log
 *   uninstall          stop + remove the plist
 *
 * Secrets: node loads $WOLFPACK_HOME/.env (default ~/.wolfpack/.env) at process start via --env-file-if-exists; nothing
 * secret is written to the plist. Env overrides (tests): STACK_LABEL, STACK_PORT, STACK_WOLVES, STACK_RUNTIME, STACK_LOG, STACK_PLIST_DIR.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { liveWolvesDir, packHome } from "./live-paths.mjs";

export const COMMANDS = ["start", "stop", "restart", "status", "logs", "uninstall"];

export function parseArgs(argv) {
	const [cmd, ...rest] = argv;
	if (!cmd || !COMMANDS.includes(cmd)) throw new Error(`usage: npm run stack -- <${COMMANDS.join("|")}> [-f] [-n N]${cmd ? ` (unknown command "${cmd}")` : ""}`);
	const flags = { follow: false, lines: 50 };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (cmd === "logs" && (a === "-f" || a === "--follow")) flags.follow = true;
		else if (cmd === "logs" && (a === "-n" || a === "--lines")) {
			const n = Number(rest[++i]);
			if (!Number.isInteger(n) || n < 1) throw new Error("-n needs a positive integer");
			flags.lines = n;
		} else throw new Error(`unknown option "${a}" for ${cmd}`);
	}
	return { cmd, flags };
}

export function resolveConfig(env = process.env, home = os.homedir(), uid = process.getuid?.()) {
	if (uid === undefined) throw new Error("stack: needs a POSIX uid (macOS)");
	const wolves = liveWolvesDir(env, home);
	const runtime = env.STACK_RUNTIME || path.join(wolves, "runtime/wolfpack");
	const label = env.STACK_LABEL || "com.wolfpack.stack";
	const port = Number(env.STACK_PORT || 7141);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad STACK_PORT "${env.STACK_PORT}"`);
	const plistDir = env.STACK_PLIST_DIR || path.join(home, "Library/LaunchAgents");
	return {
		home, uid, label, port, wolves, runtime,
		envFile: path.join(packHome(env, home), ".env"),
		workerdJs: path.join(runtime, "packages/workerd/dist/bin/workerd.js"),
		log: env.STACK_LOG || path.join(wolves, "logs/stack.log"),
		plist: path.join(plistDir, `${label}.plist`),
		plistDir,
		target: `gui/${uid}/${label}`,
		domain: `gui/${uid}`,
	};
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const item = (s) => `\t\t<string>${esc(s)}</string>\n`;
const kv = (k, v) => `\t<key>${k}</key>\n\t<string>${esc(v)}</string>\n`;

/** PATH for the service: node's dir first, then the dirs of git/claude found at start, then the usual system dirs. */
export function servicePath(nodePath, extraDirs = [], home = os.homedir()) {
	const dirs = [path.dirname(nodePath), ...extraDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", path.join(home, ".local/bin")];
	return [...new Set(dirs)].join(":");
}

/**
 * node is the job pid (so launchctl kill / kill -0 hit workerd itself): sh starts `caffeinate -w $$` (it watches the pid,
 * which survives the exec) and execs node. node loads the env file with its own parser (same as dev-stack's util.parseEnv):
 * a bad line is skipped, not run as shell, and variables already in the plist (HOME, PATH) are not overridden.
 */
export function programArguments(cfg, nodePath) {
	return ["/bin/sh", "-c", '/usr/bin/caffeinate -is -w $$ & exec "$@"', "sh", nodePath, `--env-file-if-exists=${cfg.envFile}`, cfg.workerdJs, "--wolves", cfg.wolves, "--port", String(cfg.port)];
}

/** launchd plist. KeepAlive restarts on any exit (`stop` boots it out, so it stays down). No secrets in here. */
export function buildPlist(cfg, nodePath, pathEnv) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${kv("Label", cfg.label)}\t<key>ProgramArguments</key>
\t<array>
${programArguments(cfg, nodePath).map(item).join("")}\t</array>
${kv("WorkingDirectory", cfg.runtime)}\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
${item(cfg.home)}\t\t<key>PATH</key>
${item(pathEnv)}\t</dict>
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
${kv("StandardOutPath", cfg.log)}${kv("StandardErrorPath", cfg.log)}</dict>
</plist>
`;
}

/** `lsof -Fpc` output -> [{pid, command}]. */
export function parseLsof(out) {
	const res = [];
	for (const line of out.split("\n")) {
		if (line.startsWith("p")) res.push({ pid: Number(line.slice(1)), command: "" });
		else if (line.startsWith("c") && res.length) res.at(-1).command = line.slice(1);
	}
	return res;
}

export function parseLaunchctlPrint(text) {
	const pick = (re) => text.match(re)?.[1];
	const pid = pick(/^\s*pid = (\d+)/m);
	return { state: pick(/^\s*state = (\S+)/m) ?? "unknown", pid: pid ? Number(pid) : undefined, lastExit: pick(/^\s*last exit code = (.+)$/m) };
}

export function parsePs(out) {
	return out.split("\n").map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], command: m[4] }));
}
export function descendants(rows, root) {
	const out = [];
	for (const todo = [root]; todo.length;) {
		const p = todo.pop();
		for (const r of rows) if (r.ppid === p && !out.some((o) => o.pid === r.pid)) (out.push(r), todo.push(r.pid));
	}
	return out;
}

/** Warning text about the env file (missing, or readable by others), or undefined. */
export function envFileWarning(file) {
	let st;
	try { st = fs.statSync(file); } catch { return `warning: ${file} not found; the service starts without API keys/tokens`; }
	return st.mode & 0o077 ? `warning: ${file} is mode ${(st.mode & 0o777).toString(8)}; run: chmod 600 ${file}` : undefined;
}

// ---- side-effecting layer ----
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const say = (m) => console.log(m);
const psRows = () => parsePs(sh("ps", ["-axo", "pid=,ppid=,etime=,command="]).stdout ?? "");
/** Listeners on the port. lsof exits 1 with no output when there are none; anything else is a failure. */
const listeners = (port) => {
	const r = sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
	const parsed = r.error || r.status === null ? [] : parseLsof(r.stdout);
	if (r.error || r.status === null || r.status > 1 || (r.status === 1 && !parsed.length && r.stdout.trim())) {
		throw new Error(`lsof failed: ${r.error?.message ?? (r.status === null ? `killed by ${r.signal}` : r.stderr.trim() || `exit ${r.status}`)}`);
	}
	return parsed;
};
const printService = (cfg) => {
	const r = sh("launchctl", ["print", cfg.target]);
	return r.status === 0 ? parseLaunchctlPrint(r.stdout) : undefined;
};
const which = (bin) => { const r = sh("/usr/bin/which", [bin]); return r.status === 0 ? r.stdout.trim() : undefined; };

function writePlist(cfg) {
	const [maj, min] = process.versions.node.split(".").map(Number);
	if (maj < 22 || (maj === 22 && min < 9)) throw new Error(`node ${process.versions.node}: the service needs node >= 22.9 (--env-file-if-exists)`);
	if (!fs.existsSync(cfg.workerdJs)) throw new Error(`${cfg.workerdJs} not found; build the runtime checkout first (${cfg.runtime}: npm install && npx turbo run build)`);
	const extra = ["git", "claude"].map(which).filter(Boolean).map((p) => path.dirname(p));
	fs.mkdirSync(cfg.plistDir, { recursive: true });
	fs.mkdirSync(path.dirname(cfg.log), { recursive: true });
	fs.writeFileSync(cfg.plist, buildPlist(cfg, process.execPath, servicePath(process.execPath, extra, cfg.home)), { mode: 0o600 });
	fs.chmodSync(cfg.plist, 0o600);
	say(`wrote ${cfg.plist} (node ${process.execPath})`);
}

function start(cfg) {
	const warn = envFileWarning(cfg.envFile);
	if (warn) say(warn);
	if (!fs.existsSync(cfg.plist)) writePlist(cfg);
	const svc = printService(cfg);
	if (svc?.state === "running") return say(`already running (pid ${svc.pid})`);
	const foreign = listeners(cfg.port).filter((l) => l.pid !== svc?.pid);
	if (foreign.length) throw new Error(`port ${cfg.port} is in use by ${foreign.map((l) => `${l.command} (pid ${l.pid})`).join(", ")}; stop it first (its wolfd children exit with it)`);
	const r = svc ? sh("launchctl", ["kickstart", cfg.target]) : sh("launchctl", ["bootstrap", cfg.domain, cfg.plist]);
	if (r.status !== 0) throw new Error(`launchctl ${svc ? "kickstart" : "bootstrap"} failed: ${(r.stderr || r.stdout).trim()}`);
	say(`started ${cfg.label}`);
}

function stop(cfg) {
	if (!printService(cfg)) return say("not loaded");
	const r = sh("launchctl", ["bootout", cfg.target]);
	if (r.status !== 0) throw new Error(`launchctl bootout failed: ${(r.stderr || r.stdout).trim()}`);
	say(`stopped ${cfg.label} (plist stays; it starts again at next login or on \`start\`)`);
}

/**
 * Graceful restart. The caller may be a wolf turn inside the service's process tree, which dies with it, so the work is
 * handed to a helper in its own session (detached), logging to restart.log: SIGTERM the service, wait for the pid to exit
 * (SIGKILL after 40s), and launchd's KeepAlive relaunches it. This kills ALL in-flight turns, including the caller's.
 */
function restart(cfg) {
	const svc = printService(cfg);
	if (!svc?.pid) return start(cfg);
	const script = `exec >>"$1" 2>&1; t=$2; p=$3; echo "--- $(date) restart $t pid $p"; sleep 2; launchctl kill SIGTERM "$t"; i=0
while kill -0 "$p" 2>/dev/null && [ $i -lt 40 ]; do sleep 1; i=$((i+1)); done
echo "old pid exited after ~$i s"
kill -0 "$p" 2>/dev/null && { echo "pid $p still alive after 40s: SIGKILL"; launchctl kill SIGKILL "$t"; }
sleep 3; echo "after:"; launchctl print "$t" | grep -E "^[[:space:]]*(state|pid) ="`;
	const helperLog = path.join(path.dirname(cfg.log), "restart.log");
	fs.mkdirSync(path.dirname(helperLog), { recursive: true });
	spawn("/bin/sh", ["-c", script, "sh", helperLog, cfg.target, String(svc.pid)], { detached: true, stdio: "ignore" }).unref();
	say(`restart requested (SIGTERM; kills all in-flight turns, including this one). Helper output: ${helperLog}. Check: npm run stack -- status`);
}

function status(cfg) {
	const svc = printService(cfg);
	say(`label:     ${cfg.label}${fs.existsSync(cfg.plist) ? "" : "  (plist not installed)"}`);
	say(svc ? `service:   loaded, ${svc.state}${svc.pid ? `, pid ${svc.pid}` : ""}${svc.lastExit ? `, last exit ${svc.lastExit}` : ""}` : "service:   not loaded (npm run stack -- start)");
	const rows = psRows();
	const me = svc?.pid && rows.find((r) => r.pid === svc.pid);
	if (me) say(`uptime:    ${me.etime}`);
	let ls = [];
	let lsErr;
	try { ls = listeners(cfg.port); } catch (e) { lsErr = e; }
	say(`port ${cfg.port}:   ${lsErr ? `unknown (${lsErr.message})` : ls.length ? `listening (${ls.map((l) => `${l.command} ${l.pid}`).join(", ")})` : "NOT listening"}`);
	const mine = svc?.pid && descendants(rows, svc.pid).concat(me || []).some((r) => ls.some((l) => l.pid === r.pid));
	if (ls.length && svc?.pid && !mine) say(`WARNING:   port ${cfg.port} is held by a process that is not the service`);
	if (svc?.pid) {
		const kids = descendants(rows, svc.pid).filter((r) => /wolfd/.test(r.command));
		say(`wolfd:     ${kids.length ? kids.map((k) => `pid ${k.pid} (up ${k.etime})`).join(", ") : "none"}`);
	}
	if (lsErr || !(svc?.state === "running" && ls.length)) {
		say(`\nlast log lines (${cfg.log}):`);
		const t = sh("tail", ["-n", "15", cfg.log]);
		say(t.status === 0 ? t.stdout.trimEnd() : "(no log)");
		process.exitCode = 1;
	}
}

export function main(argv, env = process.env) {
	const { cmd, flags } = parseArgs(argv);
	if (process.platform !== "darwin") throw new Error("launchd is macOS-only");
	const cfg = resolveConfig(env);
	switch (cmd) {
		case "start": return start(cfg);
		case "stop": return stop(cfg);
		case "restart": return restart(cfg);
		case "status": return status(cfg);
		case "logs":
			if (!fs.existsSync(cfg.log)) throw new Error(`no log at ${cfg.log}`);
			return void spawnSync("tail", [...(flags.follow ? ["-f"] : []), "-n", String(flags.lines), cfg.log], { stdio: "inherit" });
		case "uninstall": stop(cfg); fs.rmSync(cfg.plist, { force: true }); return say(`removed ${cfg.plist}`);
	}
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	try { main(process.argv.slice(2)); } catch (e) { console.error(`stack: ${e.message}`); process.exit(1); }
}
