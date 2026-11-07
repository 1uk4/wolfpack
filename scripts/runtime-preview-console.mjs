/**
 * Local console for `wolfpack preview`: serve the preview build's standalone console on 127.0.0.1 under its own launchd agent
 * (com.wolfpack.preview-console, so it outlives the wolf session and the CLI, and survives a reboot), and point the desktop app's
 * console.json at it. Node builtins only: copied next to the switch helper under ~/.wolfpack/preview/bin/.
 */
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

/** Write the agent's plist and (re)load it. `args` is the full program (node + script); never a shell wrapper. */
function loadAgent({ home, args, workingDir, port, stackPort, uid, launchctl }) {
	const logFile = path.join(home, ".wolfpack", "preview", "console.log");
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	const env = { PORT: port, HOSTNAME: "127.0.0.1", WOLFPACK_API_URL: `http://127.0.0.1:${stackPort}`, HOME: home, WOLFPACK_AUTH_FILE: path.join(home, ".wolfpack", "preview", "auth.json"), PATH: process.env.PATH ?? "/usr/bin:/bin" };
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

export function startConsole({ home, runtimeDir, port, stackPort, node, uid, launchctl }) {
	const dir = prepareConsole(runtimeDir);
	loadAgent({ home, args: [node, path.join(dir, "server.js")], workingDir: dir, port, stackPort, uid, launchctl });
}

/** `next dev` from a worktree's apps/console (hot reload), under the same agent. Returns the app dir; throws with a hint when it can't run. */
export function devConsoleApp(dir) {
	const app = path.join(dir, "apps", "console");
	const next = path.join(app, "node_modules", "next", "dist", "bin", "next");
	if (!fs.existsSync(app)) throw new Error(`${app} does not exist: not a wolfpack worktree`);
	if (!fs.existsSync(next)) throw new Error(`${path.join(app, "node_modules")} has no next: run \`pnpm install\` in ${dir} first`);
	return { app, next };
}

export function startDevConsole({ home, dir, port, stackPort, node, uid, launchctl }) {
	const { app, next } = devConsoleApp(dir);
	loadAgent({ home, args: [node, next, "dev", "--hostname", "127.0.0.1", "--port", port], workingDir: app, port, stackPort, uid, launchctl });
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
