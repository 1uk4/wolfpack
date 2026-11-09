#!/usr/bin/env node
/**
 * Live stack manager: `pnpm stack <cmd>` (`npm run stack -- <cmd>` on an npm checkout).
 * Runs the HEADLESS live stack (workerd, which supervises one wolfd per wolf in ~/wolves/local) as a per-user launchd
 * agent: starts at login, restarts after a crash, keeps the Mac awake (caffeinate), logs to a file.
 *
 *   install            (re)write the plist only; loads nothing (a loaded service keeps the old one until stop + start)
 *   start              write the plist if missing, bootstrap + start the service (kickstart if loaded but not running)
 *   stop               bootout: stops it now; stays installed and starts again at next login (or `start`). Idempotent.
 *   restart            fire-and-forget: a detached helper SIGTERMs, then SIGKILLs after 40s if the pid is still the service's;
 *                      launchd (KeepAlive) relaunches. Kills in-flight turns, including the caller's. Not running: same as start.
 *   status             loaded/running, PID, uptime, port, wolfd children, /healthz, a verdict, log tail on trouble
 *   logs [-f] [-n N]   tail the log
 *   uninstall          stop + remove the plist
 *
 * Status verdict (see `verdict`): healthy | degraded | unresponsive | unmanaged | down | unknown (launchctl print failed
 * for a reason other than "not loaded"). Exit 0 only for healthy; exit 1 covers every other verdict, so callers read
 * `status.verdict` from `main` rather than the exit code. Usage and launchctl errors throw (`stack: <msg>`, exit 1).
 *
 * The port check uses `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`. Exit 1 with no output means "nothing listening". These are
 * errors: lsof cannot be spawned (missing), it is killed by a signal, it exits > 1, or it exits 1 with output it cannot parse.
 * `start` throws on them; `status` reports the port as unknown with the reason and keeps going.
 *
 * Secrets: node loads $WOLFPACK_HOME/.env (default ~/.wolfpack/.env) at process start via --env-file-if-exists; nothing
 * secret is written to the plist. Env overrides (tests): STACK_LABEL, STACK_PORT, STACK_WOLVES, STACK_RUNTIME, STACK_LOG, STACK_PLIST_DIR.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ageText, STALE_AFTER_MS } from "./auto-update.mjs";
import { liveWolvesDir, packHome } from "./live-paths.mjs";

export const COMMANDS = ["install", "start", "stop", "restart", "status", "logs", "uninstall"];

export function parseArgs(argv) {
	const [cmd, ...rest] = argv;
	if (!cmd || !COMMANDS.includes(cmd)) throw new Error(`usage: pnpm stack <${COMMANDS.join("|")}> [-f] [-n N]${cmd ? ` (unknown command "${cmd}")` : ""}`);
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

/**
 * One line from the Mac auto-update status file (scripts/auto-update-mac.mjs); display only. A `lastCheck` older than
 * STALE_AFTER_MS (two timer intervals) leads with `stale (last check <age>)`: the job is not running or every run finds the lock
 * held (deploy/auto-update/RUNBOOK.md, troubleshooting). No file = never set up, not stale.
 */
export function autoUpdateLine(file, nowMs = Date.now()) {
	let s;
	try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return "auto-update not set up (node scripts/auto-update-mac.mjs install)"; }
	const at = Date.parse(s?.lastCheck ?? "");
	if (Number.isFinite(at) && nowMs - at > STALE_AFTER_MS) return `stale (last check ${ageText(s.lastCheck, nowMs)}); see deploy/auto-update/RUNBOOK.md`;
	const u = s?.units?.stack ?? {};
	const ver = u.current || u.target ? ` (running ${u.current ?? "?"}, stable ${u.target ?? "?"})` : "";
	const why = u.state === "disabled" ? s.disabledReason : u.state === "failed" ? `${u.code}: ${u.message ?? ""}` : u.message;
	return `${u.state ?? s.result ?? "unknown"}${ver}${why ? `; ${why}` : ""}; last check ${s.lastCheck ?? "never"}`;
}

/** Warning text about the env file (missing, or readable by others), or undefined. */
export function envFileWarning(file) {
	let st;
	try { st = fs.statSync(file); } catch { return `warning: ${file} not found; the service starts without API keys/tokens`; }
	return st.mode & 0o077 ? `warning: ${file} is mode ${(st.mode & 0o777).toString(8)}; run: chmod 600 ${file}` : undefined;
}


// ---- side-effecting layer: every OS call goes through `deps`, so tests run it against a fake launchctl/ps/lsof/fetch ----

/** The real Mac. `run` is a spawnSync with utf8 output; `spawnDetached` starts a helper in its own session; `fetch` is the global one. */
export function realDeps() {
	return {
		home: os.homedir(),
		uid: process.getuid?.(),
		platform: process.platform,
		nodePath: process.execPath,
		nodeVersion: process.versions.node,
		say: (m) => console.log(m),
		run: (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts }),
		spawnDetached: (cmd, args) => spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(),
		fetch: (url, init) => fetch(url, init),
	};
}

export const HEALTH_TIMEOUT_MS = 2000;

/**
 * GET http://127.0.0.1:<port>/healthz with a timeout. → {ok, wolves: [{name, state}], error?}. Never throws.
 * (A plain fetch for now; the shared probeHealth helper in @wolfpack/protocol replaces it once it lands on this branch.)
 */
export async function probeHealthz(port, fetchFn = fetch, timeoutMs = HEALTH_TIMEOUT_MS) {
	try {
		const res = await fetchFn(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return { ok: false, wolves: [], error: `HTTP ${res.status}` };
		const body = await res.json();
		const wolves = Array.isArray(body?.wolves) ? body.wolves.map((w) => ({ name: String(w.name), state: String(w.state) })) : [];
		return { ok: body?.ok === true, wolves };
	} catch (e) {
		return { ok: false, wolves: [], error: e?.name === "TimeoutError" ? `no answer in ${timeoutMs} ms` : String(e?.message ?? e) };
	}
}

/**
 * One verdict from the launchd state and the probe:
 *   healthy       service running, /healthz ok, every wolf online
 *   degraded      service running, /healthz answers, some wolf not online
 *   unresponsive  service running, /healthz does not answer
 *   unmanaged     /healthz answers but launchd does not run it (a hand-started workerd: no KeepAlive)
 *   down          nothing answers
 *   unknown       launchctl print failed (not "not loaded"): `serviceError` holds the reason
 * `svc` is the parsed `launchctl print`, undefined when the service is not loaded.
 */
export function verdict(svc, health, serviceError) {
	if (serviceError) return "unknown";
	const running = svc?.state === "running";
	if (!health.error && running) return health.ok && health.wolves.every((w) => w.state === "online") ? "healthy" : "degraded";
	if (!health.error) return "unmanaged";
	return running ? "unresponsive" : "down";
}

function makeOps(cfg, d) {
	const sh = (cmd, args) => d.run(cmd, args);
	const psRows = () => parsePs(sh("ps", ["-axo", "pid=,ppid=,etime=,command="]).stdout ?? "");
	/** Listeners on the port. lsof exits 1 with no output when there are none; anything else is a failure. */
	const listeners = () => {
		const r = sh("lsof", ["-nP", `-iTCP:${cfg.port}`, "-sTCP:LISTEN", "-Fpc"]);
		const parsed = r.error || r.status === null ? [] : parseLsof(r.stdout ?? "");
		if (r.error || r.status === null || r.status > 1 || (r.status === 1 && !parsed.length && (r.stdout ?? "").trim())) {
			throw new Error(`lsof failed: ${r.error?.message ?? (r.status === null ? `killed by ${r.signal}` : (r.stderr ?? "").trim() || `exit ${r.status}`)}`);
		}
		return parsed;
	};
	/** Parsed `launchctl print`, or undefined when not loaded (exit 113 / "not found"). Any other failure throws. */
	const printService = () => {
		const r = sh("launchctl", ["print", cfg.target]);
		if (r.status === 0) return parseLaunchctlPrint(r.stdout ?? "");
		const text = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
		if (!r.error && (r.status === 113 || /could not find|not found/i.test(text))) return undefined;
		throw new Error(`launchctl print failed: ${r.error?.message ?? (r.status === null ? `killed by ${r.signal}` : text || `exit ${r.status}`)}`);
	};
	const launchctl = (args) => {
		const r = sh("launchctl", args);
		if (r.status !== 0) throw new Error(`launchctl ${args[0]} failed: ${((r.stderr || r.stdout) ?? "").trim()}`);
	};
	const which = (bin) => { const r = sh("/usr/bin/which", [bin]); return r.status === 0 ? (r.stdout ?? "").trim() : undefined; };
	return { psRows, listeners, printService, launchctl, which };
}

/** Write (or rewrite) the plist from the current config. Loads nothing. */
function writePlist(cfg, d, ops) {
	const [maj, min] = d.nodeVersion.split(".").map(Number);
	if (maj < 22 || (maj === 22 && min < 9)) throw new Error(`node ${d.nodeVersion}: the service needs node >= 22.9 (--env-file-if-exists)`);
	if (!fs.existsSync(cfg.workerdJs)) throw new Error(`${cfg.workerdJs} not found; build the runtime checkout first (${cfg.runtime}: pnpm install --frozen-lockfile && node scripts/turbo.mjs run build)`);
	const extra = ["git", "claude"].map(ops.which).filter(Boolean).map((p) => path.dirname(p));
	fs.mkdirSync(cfg.plistDir, { recursive: true });
	fs.mkdirSync(path.dirname(cfg.log), { recursive: true });
	fs.writeFileSync(cfg.plist, buildPlist(cfg, d.nodePath, servicePath(d.nodePath, extra, cfg.home)), { mode: 0o600 });
	fs.chmodSync(cfg.plist, 0o600);
	d.say(`wrote ${cfg.plist} (node ${d.nodePath})`);
}

/** install: (re)write the plist and nothing else. A loaded service keeps running the old one until stop + start. */
function install(cfg, d, ops) {
	const warn = envFileWarning(cfg.envFile);
	if (warn) d.say(warn);
	writePlist(cfg, d, ops);
	d.say(ops.printService() ? "the loaded service still runs the old plist: `pnpm stack stop && pnpm stack start` loads the new one" : "not loaded: `pnpm stack start` loads it");
}

function start(cfg, d, ops) {
	const warn = envFileWarning(cfg.envFile);
	if (warn) d.say(warn);
	if (!fs.existsSync(cfg.plist)) writePlist(cfg, d, ops);
	const svc = ops.printService();
	if (svc?.state === "running") return d.say(`already running (pid ${svc.pid})`);
	const foreign = ops.listeners().filter((l) => l.pid !== svc?.pid);
	if (foreign.length) throw new Error(`port ${cfg.port} is in use by ${foreign.map((l) => `${l.command} (pid ${l.pid})`).join(", ")}; stop it first (its wolfd children exit with it)`);
	ops.launchctl(svc ? ["kickstart", cfg.target] : ["bootstrap", cfg.domain, cfg.plist]);
	d.say(`started ${cfg.label}`);
}

function stop(cfg, d, ops) {
	if (!ops.printService()) return d.say("not loaded");
	ops.launchctl(["bootout", cfg.target]);
	d.say(`stopped ${cfg.label} (plist stays; it starts again at next login or on \`start\`)`);
}

/**
 * Restart, fire-and-forget: it returns once the helper is spawned; callers poll `status` for the outcome.
 * The caller may be a wolf turn inside the service's process tree, which dies with it, so the work is handed to a helper in
 * its own session (detached), logging to restart.log: SIGTERM the service, wait up to 40s for the pid to exit, then SIGKILL
 * only if `launchctl print` still shows that pid as the service's (not a reused pid, not an already relaunched service).
 * launchd's KeepAlive relaunches it. This kills ALL in-flight turns, including the caller's.
 * Not loaded, or loaded but not running (no pid): falls back to `start` (bootstrap, or kickstart).
 */
function restart(cfg, d, ops) {
	const svc = ops.printService();
	if (!svc?.pid) return start(cfg, d, ops);
	const script = `exec >>"$1" 2>&1; t=$2; p=$3; echo "--- $(date) restart $t pid $p"; sleep 2; launchctl kill SIGTERM "$t"; i=0
while kill -0 "$p" 2>/dev/null && [ $i -lt 40 ]; do sleep 1; i=$((i+1)); done
echo "old pid exited after ~$i s"
if kill -0 "$p" 2>/dev/null; then
  if launchctl print "$t" 2>/dev/null | grep -qE "^[[:space:]]*pid = $p\$"; then echo "pid $p still the service after 40s: SIGKILL"; launchctl kill SIGKILL "$t";
  else echo "pid $p is alive but no longer the service's: no SIGKILL"; fi
fi
sleep 3; echo "after:"; launchctl print "$t" | grep -E "^[[:space:]]*(state|pid) ="`;
	const helperLog = path.join(path.dirname(cfg.log), "restart.log");
	fs.mkdirSync(path.dirname(helperLog), { recursive: true });
	d.spawnDetached("/bin/sh", ["-c", script, "sh", helperLog, cfg.target, String(svc.pid)]);
	d.say(`restart requested (SIGTERM; kills all in-flight turns, including this one). Helper output: ${helperLog}. Check: pnpm stack status`);
}

/**
 * → {code, status: {verdict, reason?, service, health, port}}. `service` is the parsed launchctl print, undefined when the
 * service is not loaded (or when print failed: verdict "unknown", `reason` says why). `port` is {listeners} or {error}.
 * `brief` skips the ps call (uptime, wolfd children) and the log tail, for cheap polling. All output goes through `d.say`.
 */
async function status(cfg, d, ops, { brief = false } = {}) {
	let svc;
	let svcErr;
	try { svc = ops.printService(); } catch (e) { svcErr = e.message; }
	const health = await probeHealthz(cfg.port, d.fetch);
	const v = verdict(svc, health, svcErr);
	d.say(`label:     ${cfg.label}${fs.existsSync(cfg.plist) ? "" : "  (plist not installed)"}`);
	d.say(svcErr ? `service:   unknown (${svcErr})` : svc ? `service:   loaded, ${svc.state}${svc.pid ? `, pid ${svc.pid}` : ""}${svc.lastExit ? `, last exit ${svc.lastExit}` : ""}` : "service:   not loaded (pnpm stack start)");
	const rows = brief ? [] : ops.psRows();
	const me = svc?.pid && rows.find((r) => r.pid === svc.pid);
	if (me) d.say(`uptime:    ${me.etime}`);
	let ls = [];
	let lsErr;
	try { ls = ops.listeners(); } catch (e) { lsErr = e; }
	d.say(`port ${cfg.port}:   ${lsErr ? `unknown (${lsErr.message})` : ls.length ? `listening (${ls.map((l) => `${l.command} ${l.pid}`).join(", ")})` : "NOT listening"}`);
	const mine = svc?.pid && descendants(rows, svc.pid).concat(me || []).some((r) => ls.some((l) => l.pid === r.pid));
	if (!brief && ls.length && svc?.pid && !mine) d.say(`WARNING:   port ${cfg.port} is held by a process that is not the service`);
	if (!brief && svc?.pid) {
		const kids = descendants(rows, svc.pid).filter((r) => /wolfd/.test(r.command));
		d.say(`wolfd:     ${kids.length ? kids.map((k) => `pid ${k.pid} (up ${k.etime})`).join(", ") : "none"}`);
	}
	d.say(`healthz:   ${health.error ? `no answer (${health.error})` : `${health.ok ? "ok" : "not ok"}; ${health.wolves.map((w) => `${w.name} ${w.state}`).join(", ") || "no wolves"}`}`);
	d.say(`verdict:   ${v}${v === "unmanaged" ? " (workerd answers but launchd does not run it: no restart on crash)" : ""}`);
	d.say(`updates:   ${autoUpdateLine(path.join(packHome(process.env, cfg.home), "auto-update/status.json"))}`);
	if (!brief && (v !== "healthy" || lsErr)) {
		d.say(`\nlast log lines (${cfg.log}):`);
		const t = d.run("tail", ["-n", "15", cfg.log]);
		d.say(t.status === 0 ? (t.stdout ?? "").trimEnd() : "(no log)");
	}
	const port = lsErr ? { error: lsErr.message } : { listeners: ls };
	return { code: v === "healthy" ? 0 : 1, status: { verdict: v, ...(svcErr ? { reason: svcErr } : {}), service: svc, health, port } };
}

/**
 * → {code, status?} (status only for `status`; code 1 for every non-healthy verdict, so read `status.verdict`).
 * Throws on a usage or launchctl error. A quiet caller passes `{...realDeps(), say: () => {}}`; `opts.brief` makes
 * status cheap to poll (no ps, no log tail).
 */
export async function main(argv, env = process.env, deps = realDeps(), opts = {}) {
	const { cmd, flags } = parseArgs(argv);
	if (deps.platform !== "darwin") throw new Error("launchd is macOS-only");
	const cfg = resolveConfig(env, deps.home, deps.uid);
	const ops = makeOps(cfg, deps);
	switch (cmd) {
		case "install": install(cfg, deps, ops); break;
		case "start": start(cfg, deps, ops); break;
		case "stop": stop(cfg, deps, ops); break;
		case "restart": restart(cfg, deps, ops); break;
		case "status": return status(cfg, deps, ops, opts);
		case "logs":
			if (!fs.existsSync(cfg.log)) throw new Error(`no log at ${cfg.log}`);
			deps.run("tail", [...(flags.follow ? ["-f"] : []), "-n", String(flags.lines), cfg.log], { stdio: "inherit" });
			break;
		case "uninstall": stop(cfg, deps, ops); fs.rmSync(cfg.plist, { force: true }); deps.say(`removed ${cfg.plist}`); break;
	}
	return { code: 0 };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).then((r) => { process.exitCode = r.code; }, (e) => { console.error(`stack: ${e.message}`); process.exit(1); });
}
