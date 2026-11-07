/**
 * Local console for `wolfpack preview`: serve the preview build's standalone console on 127.0.0.1 under its own launchd agent
 * (com.wolfpack.preview-console, so it outlives the wolf session and the CLI, and survives a reboot), and point the desktop app's
 * console.json at it. Node builtins only: copied next to the switch helper under ~/.wolfpack/preview/bin/.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const CONSOLE_LABEL = "com.wolfpack.preview-console";
const APP_FOLDERS = ["LearnHarness", "Wolfpack Console"];
const xml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The directory holding Next's standalone server.js (monorepo trace first), with .next/static and public copied in as Next requires. */
export function prepareConsole(runtimeDir) {
	const app = path.join(runtimeDir, "apps", "console");
	const standalone = path.join(app, ".next", "standalone");
	const dir = [path.join(standalone, "apps", "console"), standalone].find((d) => fs.existsSync(path.join(d, "server.js")));
	if (!dir) throw new Error(`no standalone console build under ${standalone}`);
	if (fs.existsSync(path.join(app, ".next", "static"))) fs.cpSync(path.join(app, ".next", "static"), path.join(dir, ".next", "static"), { recursive: true });
	if (fs.existsSync(path.join(app, "public"))) fs.cpSync(path.join(app, "public"), path.join(dir, "public"), { recursive: true });
	return dir;
}

const plistPath = (home) => path.join(home, "Library", "LaunchAgents", `${CONSOLE_LABEL}.plist`);

/**
 * The hub this Mac's stack is paired with: `hubUrl` from workerd's hub.json (`$WORKERD_CONFIG_DIR` or ~/.wolfpack/workerd), the same
 * file workerd links with. Only the url is read (the file also holds a token, which is never returned, logged or written to a plist).
 * → {url} or undefined when unpaired. `HUBD_PUBLIC_URL` in `env` overrides the public url used for the console's pairing link.
 */
export function resolveHub({ home, env = {} }) {
	const dir = env.WORKERD_CONFIG_DIR || path.join(home, ".wolfpack", "workerd");
	try {
		const url = JSON.parse(fs.readFileSync(path.join(dir, "hub.json"), "utf8")).hubUrl;
		if (typeof url !== "string" || !/^https?:\/\//.test(url)) return undefined;
		const clean = url.trim().replace(/\/+$/, "");
		const pub = env.HUBD_PUBLIC_URL?.trim().replace(/\/+$/, "");
		return { url: clean, publicUrl: pub || clean };
	} catch {
		return undefined;
	}
}

/**
 * The real launchctl: output is shown, except that unloading an agent that is not loaded (`bootout` exit 3, "No such process")
 * is a normal case here and prints nothing. The exit status is returned either way. `spawn` and `write` are injectable for tests.
 */
export function runLaunchctl(args, { spawn = spawnSync, write = (t) => process.stderr.write(t) } = {}) {
	const r = spawn("launchctl", args, { stdio: ["inherit", "inherit", "pipe"] });
	const err = r.stderr ? r.stderr.toString() : "";
	if (!(args[0] === "bootout" && r.status === 3 && /No such process/i.test(err)) && err) write(err);
	return r.status;
}

/** Write the agent's plist and (re)load it. `args` is the full program (node + script); never a shell wrapper. */
function loadAgent({ home, env: hostEnv = {}, args, workingDir, port, stackPort, uid, launchctl }) {
	const logFile = path.join(home, ".wolfpack", "preview", "console.log");
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	// With a hub the console runs in RELAY mode like stable (the browser pairs once, then every call goes through the hub, so every wolf is
	// listed, Hal included). The origin is the loopback address: http, so the cookie mirror uses the plain (non-Secure) name. Without a
	// hub: today's local-only env, which lists only the wolves on this stack.
	const hub = resolveHub({ home, env: hostEnv });
	const access = hub
		? { WOLFPACK_HUB_URL: hub.url, HUBD_PUBLIC_URL: hub.publicUrl, WOLFPACK_CONSOLE_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` }
		: { WOLFPACK_API_URL: `http://127.0.0.1:${stackPort}` };
	const env = { PORT: port, HOSTNAME: "127.0.0.1", ...access, HOME: home, WOLFPACK_AUTH_FILE: path.join(home, ".wolfpack", "preview", "auth.json"), PATH: process.env.PATH ?? "/usr/bin:/bin" };
	const file = plistPath(home);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${CONSOLE_LABEL}</string>
	<key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
	<key>WorkingDirectory</key><string>${xml(workingDir)}</string>
	<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
	<key>StandardOutPath</key><string>${xml(logFile)}</string>
	<key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`,
	);
	launchctl("bootout", `gui/${uid}/${CONSOLE_LABEL}`); // a leftover from an earlier preview
	if (launchctl("bootstrap", `gui/${uid}`, file) !== 0) throw new Error(`launchctl bootstrap of ${file} failed`);
}

export function startConsole({ home, env, runtimeDir, port, stackPort, node, uid, launchctl }) {
	const dir = prepareConsole(runtimeDir);
	loadAgent({ home, env, args: [node, path.join(dir, "server.js")], workingDir: dir, port, stackPort, uid, launchctl });
}

/** `next dev` from a worktree's apps/console (hot reload), under the same agent. Returns the app dir; throws with a hint when it can't run. */
export function devConsoleApp(dir) {
	const app = path.join(dir, "apps", "console");
	const next = path.join(app, "node_modules", "next", "dist", "bin", "next");
	if (!fs.existsSync(app)) throw new Error(`${app} does not exist: not a wolfpack worktree`);
	if (!fs.existsSync(next)) throw new Error(`${path.join(app, "node_modules")} has no next: run \`pnpm install\` in ${dir} first`);
	return { app, next };
}

export function startDevConsole({ home, env, dir, port, stackPort, node, uid, launchctl }) {
	const { app, next } = devConsoleApp(dir);
	loadAgent({ home, env, args: [node, next, "dev", "--hostname", "127.0.0.1", "--port", port], workingDir: app, port, stackPort, uid, launchctl });
}

export function stopConsole({ home, uid, launchctl }) {
	launchctl("bootout", `gui/${uid}/${CONSOLE_LABEL}`);
	fs.rmSync(plistPath(home), { force: true });
}

const BACKUP = ".preview-backup";
const readJson = (f) => {
	try {
		return JSON.parse(fs.readFileSync(f, "utf8"));
	} catch {
		return undefined;
	}
};

/** Records for folders that still have a backup next to a console.json holding `url`: the state lost its apps (crash). */
export function recoverApps({ root, url }) {
	const apps = [];
	for (const d of APP_FOLDERS.map((f) => path.join(root, f))) {
		const file = path.join(d, "console.json");
		const b = readJson(`${file}${BACKUP}`);
		if (b && readJson(file)?.consoleUrl === url) apps.push({ file, fileExisted: true, previous: typeof b.consoleUrl === "string" ? b.consoleUrl : null });
	}
	return apps;
}

export function restoreApps(apps = []) {
	for (const a of apps) {
		try {
			const cfg = fs.existsSync(a.file) ? JSON.parse(fs.readFileSync(a.file, "utf8")) : {};
			if (a.previous === null) delete cfg.consoleUrl;
			else cfg.consoleUrl = a.previous;
			if (!a.fileExisted && Object.keys(cfg).length === 0) fs.rmSync(a.file, { force: true });
			else fs.writeFileSync(a.file, `${JSON.stringify(cfg, null, 2)}\n`);
			fs.rmSync(`${a.file}${BACKUP}`, { force: true }); // a stale backup would mislead the next run
		} catch {}
	}
}
