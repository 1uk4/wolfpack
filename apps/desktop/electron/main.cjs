/**
 * Wolfpack Console — the Electron shell (wrapper milestone, 2026-09-17).
 *
 * What this process is and is not:
 *   IS:  a thin launcher + security guard around the app's real server —
 *        `next build`'s standalone server.js (Next 16), spawned as a child
 *        on 127.0.0.1 with the BYOK auth file and the WOLFPACK_DATA_DIR seam.
 *   NOT: a host for any app logic. Everything — teacher turns, extraction,
 *        the graph — runs in the Next server, unchanged.
 *
 * Pattern (fact-checked 2026-09-17 against current Electron 44 / Next 16
 * docs — see .memory release-strategy + electron-wrapper notes):
 *   - spawn via process.execPath + ELECTRON_RUN_AS_NODE=1 (Electron's
 *     bundled Node 24; the runAsNode fuse must stay enabled);
 *   - the server dir ships UNPACKED via extraResources (asar archives are
 *     read-only and native .node/dylib can't dlopen from one);
 *   - all mutable state under userData (never inside the .app bundle —
 *     translocated apps are read-only);
 *   - keys ride the child's ENV, never argv; auth.json (BYOK) is a flat
 *     {VAR: value} JSON map, plaintext, mode 0600 — server-managed since
 *     the auth-keys wave (2026-09-19): the child reads/writes it DIRECTLY
 *     (WOLFPACK_AUTH_FILE below) and reflects values into its own env. The old
 *     spawn-time env injection retired with that wave — a copy made here
 *     would shadow every settings-page key change until restart.
 */

const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, ipcMain, session, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { createNeedsYouNotifier } = require("./notify.cjs");
const { resolveConsoleTarget, errorPageHtml, pairUrl } = require("./remote.cjs");
const { createSupervisor } = require("./supervisor.cjs");
const { shouldCurate, parseBatteryPercent } = require("./curator-gate.cjs");
const { needsSetup, readSetup, readWolfId, storedKey, checkKey, runSetup, wolfIdFor } = require("./setup.cjs");
const { consoleEnv } = require("./console-env.cjs");
const { windowAllClosedAction, createTray } = require("./tray.cjs");

// Mirrors SIDEBAR_AUTOCLOSE in components/shell/sidebar.tsx — keep in sync (the
// renderer owns the number; this is the IPC widen target).
const SIDEBAR_AUTOCLOSE = 928;

const PRODUCT_NAME = "Wolfpack Console";

// APP NAME → userData (owner, 2026-10-10): the Application Support dir is
// exactly "Wolfpack Console" in dev AND packaged. Packaged Electron would
// otherwise derive it from package.json "name", and productName metadata
// alone doesn't reach app.name.
// Must run before the WOLFPACK_DEV_URL suffix below — dev becomes
// "Wolfpack Console-dev".
app.setName(PRODUCT_NAME);
const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.json");
const DATA_DIR = () => path.join(app.getPath("userData"), "data");

/** The packaged standalone server (extraResources → Resources/server).
 *  In dev WOLFPACK_DEV_URL short-circuits everything: no spawn, no packaging —
 *  the window points at the running `next dev` server (full HMR). */
function serverEntry() {
	// extraResources ships the whole .next payload under server/standalone/
	// (copied from .next with an explicit filter — see electron-builder.yml).
	return path.join(process.resourcesPath, "server", "standalone", "apps", "console", "server.js");
}

// ─── Single instance: two instances would fight over the data dir ─────────
// Dev shell (WOLFPACK_DEV_URL) runs BESIDE the packaged app, not instead of it:
// its own userData so (a) the single-instance lock — checked below — doesn't
// silently kill it, and (b) it never reads/writes the real app's
// localStorage, auth.json, or logs. Must run before the lock check.
if (process.env.WOLFPACK_DEV_URL || undefined) {
	app.setPath("userData", `${app.getPath("userData")}-dev`);
}
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		const win = BrowserWindow.getAllWindows()[0];
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
	main();
}

let serverProcess = null;
let supervisor = null; // hubd + workerd + wolfd, this Mac only (supervisor.cjs)
let appRuntime = false; // true once the app runs its own services (menu-bar app); remote/dev modes stay false
let tray = null;
let updateDialogOpen = false; // the failed-update dialog is showing: nothing is running, so a quit just exits
let systemShutdown = false; // set by powerMonitor "shutdown": before-quit must not hold the quit

let chatWolf = "wolf"; // the wolf whose chat the window opens on (chosen in the setup wizard)
let wizardWindow = null; // the first-run setup window, closed once the main window is up
let wizardFinishing = false; // finish has started: closing the wizard window must not quit the app (set until the chat window exists)

/** Build-time switch for the subscription sign-in option (ships off; its flow is work-wolfpack-66JSDus). */
const SUBSCRIPTION_SIGNIN = process.env.WOLFPACK_APP_SUBSCRIPTION === "1";

/** Suggested wolf name: the macOS user's first name + "'s wolf". */
function suggestedWolfName() {
	let first = "";
	try {
		first = String(require("node:child_process").execFileSync("id", ["-F"], { encoding: "utf8" })).trim().split(/\s+/)[0];
	} catch {
		/* fall back to the login name */
	}
	if (!first) first = require("node:os").userInfo().username;
	first = first.replace(/[^\p{L}\p{N}]/gu, "");
	return wolfIdFor(first) ? `${first.charAt(0).toUpperCase()}${first.slice(1)}'s wolf` : "My wolf";
}

/**
 * First launch (or a relaunch after an unfinished setup): show the setup wizard, prefilled with what was stored; resolve to the running
 * supervisor once the user finishes. No runtime service (hubd, workerd, wolfd) starts before the wizard finishes; only the console page host does. Once finish has begun, closing the window is fine: the chat
 * window opens when the runtime is ready (and a failure after that shows the start-error dialog).
 */
function runWizard(opts) {
	return new Promise((resolve, reject) => {
		const envKey = process.env.WOLFPACK_APP_API_KEY || ""; // dev/test override: skips the sign-in step
		const win = new BrowserWindow({
			width: 560,
			height: 680,
			title: PRODUCT_NAME,
			backgroundColor: "#0f141a",
			...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
			webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs"), additionalArguments: ["--wolfpack-setup"] },
		});
		wizardWindow = win;
		const wc = win.webContents;
		wc.on("will-navigate", (e) => e.preventDefault()); // the wizard page never goes anywhere else
		wc.setWindowOpenHandler(() => ({ action: "deny" }));
		let finishing = false;
		const ch = ["info", "name", "check-key", "open-external", "finish"].map((c) => `wolfpack:setup:${c}`);
		const cleanup = () => ch.forEach((c) => ipcMain.removeHandler(c));
		// Only the wizard window's own top frame, showing our setup page from disk, may call these.
		const fromWizard = (e) => {
			if (e.sender !== wc || e.senderFrame !== wc.mainFrame) return false;
			try {
				const u = new URL(e.senderFrame.url);
				return u.protocol === "file:" && u.pathname.endsWith("/setup/index.html");
			} catch {
				return false;
			}
		};
		ipcMain.handle("wolfpack:setup:info", (e) => {
			if (!fromWizard(e)) return null;
			const stored = readSetup(opts.stateDir);
			// The key never reaches the page: only whether one is saved.
			return {
				subscription: SUBSCRIPTION_SIGNIN,
				keyEnv: !!envKey,
				keySaved: !!storedKey(opts.stateDir),
				prefill: stored ? { wolfName: stored.wolfName, domains: stored.domains } : null,
			};
		});
		ipcMain.handle("wolfpack:setup:name", (e) => (fromWizard(e) ? suggestedWolfName() : ""));
		ipcMain.handle("wolfpack:setup:check-key", (e, key) => (fromWizard(e) ? checkKey(String(key ?? ""), { baseUrl: opts.modelBaseUrl }) : { ok: false, error: "Not allowed" }));
		ipcMain.handle("wolfpack:setup:open-external", (e, url) => {
			if (fromWizard(e) && url === "https://console.anthropic.com/settings/keys") void shell.openExternal(url);
		});
		ipcMain.handle("wolfpack:setup:finish", async (e, answers) => {
			if (!fromWizard(e) || finishing) return { ok: false, error: "Setup is already running." };
			finishing = true;
			wizardFinishing = true;
			const fail = (message) => {
				finishing = false;
				wizardFinishing = false;
				return { ok: false, error: message };
			};
			try {
				// A typed key was checked at the sign-in step; the dev override and a saved key are checked here.
				const typed = String(answers?.apiKey ?? "").trim();
				const key = envKey || typed || storedKey(opts.stateDir);
				if (!typed) {
					const r = await checkKey(key, { baseUrl: opts.modelBaseUrl });
					if (!r.ok) return fail(r.error);
				}
				const sup = await runSetup({ ...answers, apiKey: key }, { ...opts, onCreate: (s) => (supervisor = s) });
				chatWolf = readWolfId(opts.stateDir);
				cleanup();
				resolve(sup);
				return { ok: true };
			} catch (err) {
				const failed = supervisor;
				supervisor = null;
				if (err?.stopped) {
					// Quit while starting: normal, quiet. startRuntime sees the same rejection.
					cleanup();
					reject(err);
					return { ok: false, error: "Cancelled." };
				}
				log(`setup failed: ${err?.stack ?? err}`);
				const message = String(err?.message ?? err).split("\n")[0];
				if (win.isDestroyed()) {
					// The user closed the wizard while it was starting: nobody to show the error to, so the start-error dialog does.
					await failed?.stop?.().catch(() => {}); // runSetup already stopped it; make sure
					cleanup();
					reject(new Error(message));
					return { ok: false, error: message };
				}
				return fail(message);
			}
		});
		win.on("closed", () => {
			if (wizardWindow === win) wizardWindow = null;
			if (finishing) return; // the chat window opens when the runtime is ready
			cleanup();
			reject(Object.assign(new Error("setup closed"), { stopped: true }));
			app.quit(); // closing the wizard before finishing quits: nothing was started
		});
		void win.loadFile(path.join(__dirname, "setup", "index.html"));
	});
}

/** work-wolfpack-u6Z4dRY: back up, migrate, restore on failure (electron/migrate.cjs). On failure: plain-words dialog, then quit; throws {stopped} so no service starts. */
async function safeUpdate(stateDir, wolvesDir) {
	const { runUpdate } = require("./migrate.cjs");
	const r = await runUpdate({ stateDir, wolvesDir, version: app.getVersion(), migrations: require("./migrations/index.cjs"), trash: (p) => shell.trashItem(p), log: (l) => log(l) });
	if (r.ok) return;
	log(`update failed (${r.stage}): ${r.error}`);
	const short = String(r.error).slice(0, 300);
	const message = r.restored
		? "Wolfpack couldn't finish updating, so it put your data back the way it was."
		: r.stage === "backup"
			? "Wolfpack couldn't finish updating, and nothing was changed."
			: "Wolfpack couldn't finish updating, and putting your data back also failed.";
	const detail = `${r.restored || r.stage === "backup" ? "Your wolves are safe. " : "Your data is in the backup folder. "}Please send this to whoever gave you the app:\n\n${short}`;
	log(`update dialog: ${message} ${detail.replace(/\n+/g, " ")}`);
	updateDialogOpen = true;
	let response;
	try {
		({ response } = await dialog.showMessageBox({ type: "error", message, detail, buttons: ["Show backup folder", "Quit"], defaultId: 1, cancelId: 1 }));
	} finally {
		updateDialogOpen = false;
	}
	if (response === 0) await shell.openPath(r.backupDir);
	app.quit();
	const e = new Error("update failed");
	e.stopped = true;
	throw e;
}

/** Start the app's own runtime. State: WOLFPACK_APP_HOME (default userData); wolves: WOLFPACK_APP_WOLVES (default ~/Wolves). Until setup.json says complete, the setup wizard runs (prefilled with the stored answers); WOLFPACK_APP_API_KEY skips its sign-in step. */
async function startRuntime() {
	// A dev run from the repo must not touch the owner's real folders: on a case-insensitive Mac the packaged default ~/Wolves IS the live ~/wolves.
	if (!app.isPackaged && !(process.env.WOLFPACK_APP_HOME && process.env.WOLFPACK_APP_WOLVES)) {
		throw new Error("Dev run: set both WOLFPACK_APP_HOME and WOLFPACK_APP_WOLVES to scratch folders (the defaults are the real app's userData and ~/Wolves).");
	}
	const stateDir = process.env.WOLFPACK_APP_HOME || app.getPath("userData");
	const wolvesDir = process.env.WOLFPACK_APP_WOLVES || path.join(app.getPath("home"), "Wolves");
	await safeUpdate(stateDir, wolvesDir); // first launch after an update: back up, migrate, or put the data back and quit
	const runtimeDir = app.isPackaged ? path.join(process.resourcesPath, "runtime") : path.join(__dirname, "..", "runtime");
	const opts = {
		stateDir,
		wolvesDir,
		runtimeDir,
		nodeBin: process.execPath,
		// Same override the harness honours (https or loopback http only); tests point it at a fake server.
		modelBaseUrl: process.env.WOLFPACK_ANTHROPIC_BASE_URL || undefined,
		log: (l) => log(`runtime: ${l}`),
	};
	if (needsSetup(stateDir)) {
		await runWizard(opts); // sets `supervisor` and chatWolf; the runtime is already up when this returns
		log(`runtime up: workerd ${supervisor.urls.workerd} hubd ${supervisor.urls.hubd}`);
		startCurationGate(supervisor);
		return;
	}
	chatWolf = readWolfId(stateDir);
	supervisor = createSupervisor({ ...opts, wolfName: chatWolf, domains: readSetup(stateDir)?.domains });
	await supervisor.start();
	log(`runtime up: workerd ${supervisor.urls.workerd} hubd ${supervisor.urls.hubd}`);
	startCurationGate(supervisor);
}

/**
 * KB curation gate (work-wolfpack-F16FFQL): once a minute, ask curator-gate.cjs whether a window may run (10 min idle, 60 min since the
 * last, not on battery below 30%). Battery percent comes from `pmset -g batt`, read only while on battery. Stops with the supervisor.
 */
let curationGateTimer = null;
function startCurationGate(sup) {
	if (curationGateTimer) clearInterval(curationGateTimer); // never more than one gate
	const { powerMonitor } = require("electron");
	const { execFile } = require("node:child_process");
	let lastRunAt = null;
	let busy = false;
	const percent = () => new Promise((resolve) => execFile("/usr/bin/pmset", ["-g", "batt"], { timeout: 5000 }, (err, out) => resolve(err ? null : parseBatteryPercent(out))));
	const timer = (curationGateTimer = setInterval(async () => {
		if (busy || supervisor !== sup) return clearInterval(timer);
		busy = true;
		try {
			const onBattery = powerMonitor.isOnBatteryPower();
			const gate = { idleSeconds: powerMonitor.getSystemIdleTime(), onBattery, batteryPercent: onBattery ? await percent() : null, lastRunAt, now: Date.now() };
			if (!shouldCurate(gate)) return;
			lastRunAt = gate.now;
			const r = await sup.curate();
			log(`curation: ${r.line ?? `skipped (${r.skipped})`}`);
		} catch (e) {
			log(`curation: failed ${e?.message ?? e}`);
		} finally {
			busy = false;
		}
	}, 60_000));
	timer.unref();
}

// A GUI shell must never die to a stray exception (EPIPE dialogs, a race
// in an event handler): the window + child server are the product, and
// anything main-side is recoverable by logging it. Log-and-continue.
process.on("uncaughtException", (err) => {
	try {
		log(`uncaught: ${err?.stack ?? err}`);
	} catch {
		/* nothing left to write to */
	}
});

/** A free TCP port (listen(0) → the kernel assigns one). The close→spawn
 *  race is theoretical; localhost ports are rarely contended, and a failed
 *  spawn surfaces in the health check with the child's stderr in the log. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** BYOK keys: auth.json in userData, flat {VAR: value} map, 0600 —
 *  SERVER-MANAGED since the auth-keys wave (2026-09-19). This shell no
 *  longer reads or injects it: the child gets WOLFPACK_AUTH_FILE below and does
 *  its own read/reflect/write, so a key saved in the settings page takes
 *  effect on the next model call — no restart. Real environment variables
 *  still win over the file inside the child (its documented rule). */

function log(line) {
	const stamp = new Date().toISOString();
	// The stdout write is guarded (EPIPE hardening, 2026-10-10): a packaged
	// app launched with a consumer-owned pipe (a launcher that exits, a
	// piped run) must not die on its next log line when the pipe breaks.
	// The file below stays the durable channel.
	try {
		console.log(`[wolfpack ${stamp}] ${line}`);
	} catch {
		/* stdout gone — userData/logs/main.log still carries it */
	}
	// Belt and braces: also append to userData/logs so a misbehaving child
	// can be diagnosed after the window is gone. Best effort only.
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "main.log"), `[${stamp}] ${line}\n`);
	} catch {
		/* best effort */
	}
}

function startServer(port, extraEnv = {}, { appRuntime = false } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[serverEntry()],
			{
				cwd: path.dirname(serverEntry()),
				// App runtime: allowlisted env (console-env.cjs), so nothing from the owner's shell can point the console off this Mac.
				env: appRuntime ? consoleEnv(process.env, { PORT: String(port), WOLFPACK_DATA_DIR: DATA_DIR(), WOLFPACK_AUTH_FILE: AUTH_FILE(), ...extraEnv }) : {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					NODE_ENV: "production",
					PORT: String(port),
					HOSTNAME: "127.0.0.1", // the server defaults to 0.0.0.0 — never
					WOLFPACK_DATA_DIR: DATA_DIR(),
					// The auth/keys store — the child reads AND writes this file itself
					// (no env injection anymore: a spawn-time copy would shadow every
					// settings-page key change until restart; env wins over file).
					WOLFPACK_AUTH_FILE: AUTH_FILE(),
					...extraEnv,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		serverProcess = child;
		const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && log(`server: ${l}`));
		child.stdout.on("data", fwd);
		child.stderr.on("data", fwd);
		child.on("exit", (code, signal) => {
			log(`server exited (code=${code} signal=${signal})`);
			serverProcess = null;
		});
		resolve(child);
	});
}

/** No "ready" event exists — poll until the server answers (docs-confirmed). */
function waitUntilUp(url, tries = 150) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			const req = http.get(url, (res) => {
				res.resume();
				resolve(res.statusCode !== undefined);
			});
			req.on("error", () => {
				if (n <= 0) reject(new Error(`server never answered on ${url}`));
				else setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function killServer() {
	if (!serverProcess) return;
	const child = serverProcess;
	serverProcess = null;
	child.kill("SIGTERM");
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, 3000);
}

/** Security posture (all defaults asserted explicitly; the guards are the
 *  checklist's own recommendations for localhost-app shells):
 *  - deny-by-default permission handler allowing only our loopback origin
 *    (groundwork for the mic/STT milestone — Electron auto-approves by
 *    default, we do not);
 *  - will-navigate pinned to the app origin; window.open always denied —
 *    external links go to the real browser via shell.openExternal. */
let remoteUrl = ""; // remote console URL (remote mode)
let remoteTarget = false; // set in main(); remote mode adds the unreachable page
function createWindow(url, landing = url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: PRODUCT_NAME,
		// Merged chrome (owner, 2026-09-17): the system title bar is gone;
		// the app's own 60px header bands ARE the title bar. The traffic
		// lights float over the sidebar's wordmark band, vertically
		// Aligned to the PHASE PILL's drawn box, not the band's geometric
		// center (owner ask, 2026-09-17): macOS centers each 12px circle at
		// y+6.75, and the pill box center measures 29.25 in the running app
		// (band 0–59.5, pill box 19–39.5) — y 22.5 lands the circles at
		// 29.25, exactly on the pill. Wordmark gutter: components/shell/sidebar.tsx.
		// Dragging comes from the renderer's .wp-drag bands (app/globals.css).
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 22.5 } }
			: {
				titleBarStyle: "hidden",
				// Native min/max/close on the right, at the OS's compact default
				// height. Do not force the zoom-invariant native overlay to match
				// the renderer's 60 CSS px bar: zooming out would cover its border.
				// The renderer reserves the actual width via env(titlebar-area-*).
				titleBarOverlay: { color: "#141414", symbolColor: "#e5e5e5" },
				// Keep the custom bar alone; Alt reveals the native menu.
				autoHideMenuBar: true,
			}),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.cjs"),
			additionalArguments: supervisor ? ["--wolfpack-single-mac"] : [], // app runtime: preload exposes singleMac (work-wolfpack-TdmbaV4)
		},
		// Live-resize + first-paint flash (owner, 2026-09-17): during a resize
		// the native window surface changes size before Chromium's compositor
		// has a frame at the new size, and the gap shows the window's NATIVE
		// background — Electron's default is white, glaring on a dark app.
		// The app background (#141414) fills the lag instead. `show: false` +
		// ready-to-show is the same treatment for first paint: the window
		// appears only once the page has actually rendered.
		backgroundColor: "#141414",
		show: false,
		// Narrow-window behavior (owner, 2026-09-17): 640px is the floor —
		// below it even a wrapped chrome row gets cramped and the chat header
		// (lights gutter 92 + toggle + title) runs out of room. The sidebar
		// auto-closes below 928 = 640 + 288 (sidebar) in the renderer
		// (components/shell/sidebar.tsx, SIDEBAR_AUTOCLOSE); its "wolfpack:expand-window"
		// IPC widens the window back to that threshold.
		minWidth: 640,
		minHeight: 600,
	});

	const allowedOrigin = () => new URL(url).origin;
	// Deny-by-default; the ONLY grants are media (mic/STT groundwork) and
	// clipboard-sanitized-write — the copy affordances in the transcript
	// (md-blocks copy corners) call navigator.clipboard.writeText(), which
	// Chromium only honors with that permission (chrome-melt tweaks wave,
	// 2026-09-19; before this grant every copy silently rejected). Still
	// loopback-origin only — Electron's default is auto-approve-everything,
	// and we do not ship that.
	// "local-fonts": the appearance section's reading-font picker (2026-09-26).
	const allowedPermissions = new Set(["media", "clipboard-sanitized-write", "local-fonts"]);
	const fromOwnOrigin = (origin, permission) =>
		origin === allowedOrigin() && allowedPermissions.has(permission);
	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const requestOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : null;
		callback(fromOwnOrigin(requestOrigin, permission));
	});
	session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
		return fromOwnOrigin(origin, permission);
	});

	win.webContents.on("will-navigate", (event, target) => {
		if (remoteTarget && target.startsWith("wolfpack-retry:")) return;
		if (new URL(target).origin !== allowedOrigin()) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: "deny" };
	});

	// Menu-bar app: a visible window brings the Dock icon back (it is hidden while no window is open).
	if (appRuntime && process.platform === "darwin") void app.dock?.show();
	void win.loadURL(landing);
	if (remoteTarget) {
		// Remote unreachable (Tailscale off…): swap the blank window for a local
		// static page. did-fail-load fires for the main frame only when errorCode
		// != -3 (aborted); sub-frame failures are ignored.
		win.webContents.on("did-fail-load", (_e, code, _desc, failedUrl, isMainFrame) => {
			if (!isMainFrame || code === -3 || failedUrl.startsWith("data:")) return;
			log(`remote unreachable (${code}): ${failedUrl}`);
			void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorPageHtml(url))}`);
		});
		// The error page's Retry link (wolfpack-retry://) is intercepted: reload the remote.
		win.webContents.on("will-navigate", (event, target) => {
			if (target.startsWith("wolfpack-retry:")) {
				event.preventDefault();
				void win.loadURL(url);
			}
		});
	}
	// Zoom truth reaches the renderer for EVERY load (reload, nav): the
	// renderer's --wp-zoom must never go stale. The fallback catcher below
	// covers ⌘= / layout variants the menu's ⌘Plus may not claim — menu-
	// claimed keys never reach before-input-event, so exactly one of the
	// two applies any given zoom keypress.
	win.webContents.on("did-finish-load", () => {
		win.webContents.send("wolfpack:zoom", win.webContents.getZoomFactor());
	});
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || !(input.meta || input.control)) return;
		if (input.key === "=" || input.key === "+") zoomStep(win, +1);
		else if (input.key === "-") zoomStep(win, -1);
		else if (input.key === "0") applyZoom(win, 1);
		else return;
		event.preventDefault();
	});

	win.once("ready-to-show", () => win.show());
	return win;
}

/* ── Zoom (owner round 7, 2026-10-05): ⌘±/⌘0 as an OWNED ladder ──────────
 * The stock zoomIn/zoomOut roles change zoomLevel silently — the renderer
 * never learns the factor, and the native traffic lights (physical-fixed,
 * hiddenInset) drift out of relation to the scaled chrome: the graph
 * button rides away from them zoomed in, content slides under them
 * zoomed out. Here zoom is explicit: a factor ladder, applied through
 * setZoomFactor, and broadcast to the renderer ("wolfpack:zoom" — it publishes
 * --wp-zoom so gutter lengths can divide by it and stay PHYSICAL-
 * constant). The traffic lights themselves stay at their construction
 * position ({x:16, y:22.5} — Electron 44 has NO runtime setter, only
 * the BrowserWindow option), which is HIG-correct anyway: native lights
 * hug the window corner while the web chrome compensates around them.
 * Vertical note: at large factors the taller bands' content centers
 * drift below the fixed lights — accepted (the alternative, moving the
 * lights, is impossible without rebuilding the window). */
const ZOOM_LADDER = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/* ── Auto-update (Wave C, owner 2026-10-10: silent download + restart ─────
 * banner; checks at startup + every 24h) ─────────────────────────────────
 *
 * Feed: GitHub Releases (electron-builder.yml publish → app-update.yml,
 * baked + signed into the bundle). macOS needs the app signed (it is —
 * Developer ID) and updates ride the zip target (Squirrel.Mac); blockmaps
 * give differential downloads for free. Windows uses NSIS; Linux uses
 * AppImage or DebUpdater (6.8.9 supports deb; installation can request
 * administrator permission via the package manager — owner 2026-10-11).
 *
 * Hard rules:
 *  - DEV NEVER UPDATES: !app.isPackaged skips the updater entirely — the
 *    dev world runs `next dev` and has no signed bundle.
 *  - THE UPDATER CAN NEVER TAKE THE APP DOWN: every event and check is
 *    caught and logged (feed down, disk full, bad signature — all just
 *    log lines; the app keeps working, update or no update).
 *  - WOLFPACK_UPDATE_FEED (env): overrides the baked GitHub feed with a generic
 *    local server — the pre-release verification drill (serve
 *    latest-mac.yml + zip + blockmap from any localhost HTTP dir and
 *    watch a real installed copy find/download/restart). Test-only seam.
 *
 * Install path: the downloaded update applies on quit (autoInstallOnAppQuit
 * — Squirrel.Mac stages natively and swaps on relaunch). The renderer
 * banner asks for an immediate restart via "wolfpack:update-install"; we kill
 * the child server FIRST — deterministic ordering: the server lives
 * inside the .app bundle Squirrel is about to replace (extraResources),
 * and before-quit alone would race the swap. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let autoUpdater = null; // electron-updater's, packaged builds only

function broadcastUpdateStatus(status) {
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			win.webContents.send("wolfpack:update-status", status);
		} catch {
			/* window mid-teardown — the next push retries */
		}
	}
}

function checkForUpdates({ manual = false } = {}) {
	if (!autoUpdater) return;
	autoUpdater
		.checkForUpdates()
		.then((result) => {
			// The download itself is silent (autoDownload); the banner fires on
			// update-downloaded. Manual checks additionally answer directly.
			if (!manual) return;
			const version = result?.updateInfo?.version;
			if (!version) dialog.showMessageBox({ type: "info", message: "You're up to date.", detail: `${PRODUCT_NAME} ${app.getVersion()} is the latest version.` });
		})
		.catch((err) => {
			log(`update check failed: ${err?.message ?? err}`);
			if (manual) dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates.", detail: String(err?.message ?? err) });
		});
}

function installUpdateNow() {
	// Kill the server BEFORE the quit-and-install (see block comment).
	try {
		killServer();
	} catch {
		/* already dead */
	}
	autoUpdater?.quitAndInstall();
}

function setupAutoUpdater() {
	if (!app.isPackaged) {
		log("auto-update: dev build — updater disabled");
		return;
	}
	try {
		autoUpdater = require("electron-updater").autoUpdater;
	} catch (err) {
		log(`auto-update: electron-updater unavailable (${err?.message ?? err}) — updates disabled`);
		return;
	}
	const feed = process.env.WOLFPACK_UPDATE_FEED || undefined;
	if (feed) {
		autoUpdater.setFeedURL({ provider: "generic", url: feed });
		log(`auto-update: WOLFPACK_UPDATE_FEED override → ${feed}`);
	}
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	// Route every updater log line through the shell's own log (userData/
	// logs/main.log) — feed failures must be diagnosable after the fact.
	autoUpdater.logger = {
		info: (m) => log(`updater: ${m}`),
		warn: (m) => log(`updater warn: ${m}`),
		debug: (m) => {}, // too chatty for the persistent log
		error: (m) => log(`updater error: ${m}`),
	};
	autoUpdater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} — banner shown`);
		broadcastUpdateStatus({ status: "downloaded", version: info?.version ?? null });
	});
	autoUpdater.on("error", (err) => log(`updater error: ${err?.message ?? err}`));
}

function zoomStep(win, dir) {
	const current = win.webContents.getZoomFactor();
	const next =
		dir > 0
			? ZOOM_LADDER.find((f) => f > current + 0.001) ?? ZOOM_LADDER[ZOOM_LADDER.length - 1]
			: [...ZOOM_LADDER].reverse().find((f) => f < current - 0.001) ?? ZOOM_LADDER[0];
	applyZoom(win, next);
}

function applyZoom(win, factor) {
	factor = Math.min(2, Math.max(0.75, factor)); // ladder clamps; ⌘0 = 1
	win.webContents.setZoomFactor(factor);
	win.webContents.send("wolfpack:zoom", factor);
}

/** macOS needs an application menu with the Edit roles — without one,
 *  Cmd+C/V/A do nothing in the renderer. Everything else stays minimal. */
function installMenu() {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				// Manual check (Wave C): answers via native dialog — no renderer
				// round-trip. The 24h automatic checks stay silent.
				{ label: "Check for Updates…", click: () => checkForUpdates({ manual: true }) },
				// Remote mode only: open hubd's pairing page (code input) on the
				// console origin; it redirects to /pair#token=… (same origin).
				...(remoteTarget
					? [{
						label: "Pair this app…",
						click: () => {
							const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
							if (w) void w.loadURL(pairUrl(new URL(remoteUrl).origin));
						},
					}]
					: []),
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				// OWNED zoom (see applyZoom): the roles change zoomLevel
				// silently; these broadcast the factor and re-seat the
				// traffic lights. The renderer's --wp-zoom depends on
				// hearing every change.
				{
					label: "Actual Size",
					accelerator: "CommandOrControl+0",
					click: () => applyZoom(BrowserWindow.getAllWindows()[0], 1),
				},
				{
					label: "Zoom In",
					accelerator: "CommandOrControl+Plus",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], +1),
				},
				{
					label: "Zoom Out",
					accelerator: "CommandOrControl+-",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], -1),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
	app.on("window-all-closed", () => {
		// App runtime: closing the window never quits; the wolves keep running and the menu-bar item stays. The Dock icon goes.
		if (wizardFinishing) return; // the setup wizard closed while the wolf starts: the chat window is about to open
		const action = windowAllClosedAction({ appRuntime, platform: process.platform });
		if (action === "hide") {
			if (process.platform === "darwin") app.dock?.hide();
		} else if (action === "quit") app.quit();
		// "stay": macOS convention outside app runtime, reactivated from the Dock.
	});

	// The child must not outlive us — cover every quit path.
	app.on("before-quit", (e) => {
		if (updateDialogOpen) return app.exit(0); // quit while the dialog is open: nothing was started, nothing to stop
		killServer();
		try { tray?.destroy(); } catch { /* already gone */ }
		tray = null;
		if (!supervisor) return;
		if (systemShutdown) return; // logout/shutdown: never hold it; the children were already sent SIGTERM and exit with the parent
		// Quit stops every child: hold the quit until SIGTERM/SIGKILL are done.
		// `supervisor` is nulled first, so the app.quit() below re-enters this handler, finds no supervisor and lets the quit through (the second-quit case).
		e.preventDefault();
		const s = supervisor;
		supervisor = null;
		s.stop().finally(() => app.quit());
	});
	process.on("exit", killServer);
	process.on("SIGHUP", killServer);
	process.on("SIGTERM", () => (updateDialogOpen ? app.exit(0) : app.quit())); // quit cleanly: before-quit stops the children

	await app.whenReady();

	// Logout/restart/shutdown must never wait on us: SIGTERM the children synchronously and do not preventDefault (Electron: only needed to delay the shutdown). The bundles' parent-pid watcher is the backstop. powerMonitor is unusable before ready, so it is read here.
	require("electron").powerMonitor.on("shutdown", () => {
		systemShutdown = true;
		try { supervisor?.killAllSync(); } catch { /* best effort */ }
	});

	// Dev mode: point at a running `next dev` server (WOLFPACK_DEV_URL) — no
	// spawn, no packaging, full HMR. The rest of this shell still applies
	// (guards, menu, single instance).
	// Remote mode (WOLFPACK_CONSOLE_URL / console.json consoleUrl, see remote.cjs):
	// no server spawn, no DATA_DIR/auth.json. WOLFPACK_DEV_URL takes precedence.
	const devUrl = process.env.WOLFPACK_DEV_URL || undefined;
	const target = devUrl ? { mode: "local" } : resolveConsoleTarget({ env: process.env, userDataDir: app.getPath("userData"), log });
	remoteTarget = target.mode === "remote";
	if (remoteTarget) remoteUrl = target.url;
	const url = devUrl ?? (remoteTarget ? target.url : `http://127.0.0.1:${await freePort()}`);
	if (remoteTarget) {
		log(`remote mode: ${url} (from ${target.source})`);
	} else if (!devUrl) {
		log(`starting server: ${serverEntry()}`);
		log(`data dir: ${DATA_DIR()}${fs.existsSync(AUTH_FILE()) ? " · auth.json: present" : " · auth.json: ABSENT (no BYOK keys yet)"}`);
		try {
			await startRuntime();
		} catch (err) {
			// A quit while starting is a normal quit: no dialog.
			if (err?.stopped) {
				log("runtime start cancelled by quit");
				return;
			}
			// No blank window: say what failed, then quit (before-quit cleans up whatever did start).
			log(`runtime failed: ${err?.stack ?? err}`);
			dialog.showErrorBox("Wolfpack could not start", String(err?.message ?? err));
			app.quit();
			return;
		}
		// The console talks to the app's own workerd only (loopback); no hub URL/token yet (ticket: hub token for work reads).
		// A quit during startup nulls `supervisor` (before-quit): stop here instead of touching it.
		if (!supervisor) return;
		await startServer(new URL(url).port, { WOLFPACK_API_URL: supervisor.urls.workerd, WOLFPACK_WORKERD_DIRECT_URL: supervisor.urls.workerd }, { appRuntime: true });
		await waitUntilUp(url).catch((err) => {
			if (supervisor) throw err;
		});
		if (!supervisor) return;
		log(`server up: ${url}`);
		appRuntime = true;
	} else {
		log(`dev mode: ${devUrl}`);
	}

	// App runtime: open on the chosen wolf's chat; every other mode opens the root exactly as before.
	const landingUrl = appRuntime ? `${url}/wolf/${encodeURIComponent(chatWolf)}/thread/home` : url;
	installMenu();

	// Auto-update (Wave C): wire the updater before the window so the
	// banner channel is live from first paint; the first check and the 24h
	// interval fire after it below. setupAutoUpdater's contract: failures
	// are log lines — this can never block boot.
	setupAutoUpdater();
	ipcMain.on("wolfpack:update-install", () => installUpdateNow());
	// Needs-you notifications: validation + delivery live in notify.cjs (tested without Electron).
	const notifyNeedsYou = createNeedsYouNotifier({ Notification, appOrigin: new URL(url).origin, log });
	ipcMain.on("wolfpack:notify", (event, n) => notifyNeedsYou(event, BrowserWindow.fromWebContents(event.sender), n));

	// Sidebar-at-narrow-window (owner, 2026-09-17): the renderer auto-closes
	// the sidebar below SIDEBAR_AUTOCLOSE (928px); opening it again at that
	// width asks the window to widen instead — the layout never has to
	// accommodate a narrow window + open sidebar. Top-left stays fixed, the
	// window grows right. No-op when already wide.
	// The renderer's first paint can race did-finish-load — it asks for
	// the current factor itself (mirrors "wolfpack:zoom" pushes).
	ipcMain.handle("wolfpack:zoom:get", (event) => BrowserWindow.fromWebContents(event.sender)?.webContents.getZoomFactor() ?? 1);
	ipcMain.on("wolfpack:expand-window", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const { x, y, width, height } = win.getBounds();
		const target = SIDEBAR_AUTOCLOSE;
		if (width < target) win.setBounds({ x, y, width: target, height });
	});
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(url, landingUrl);
	});
	if (appRuntime && supervisor) {
		const sup = supervisor;
		tray = createTray({
			app, Tray, Menu, nativeImage, log,
			getStatus: () => (supervisor ? supervisor.status() : { running: false }),
			openWindow: () => {
				const w = BrowserWindow.getAllWindows()[0];
				if (!w) return createWindow(url, landingUrl);
				if (w.isMinimized()) w.restore();
				w.show();
				w.focus();
			},
			quit: () => app.quit(),
		});
		sup.onChange(() => tray?.refresh());
	}
	// Started at login: services run, no window (open it from the menu bar). macOS reports a login start through wasOpenedAtLogin; if it does not, the window simply opens (accepted limit).
	const startHidden = appRuntime && app.getLoginItemSettings().wasOpenedAtLogin;
	if (startHidden) {
		if (process.platform === "darwin") app.dock?.hide();
		log("started at login: no window");
	} else {
		createWindow(url, landingUrl);
		log(`window open: ${landingUrl}`);
	}
	wizardFinishing = false;
	// The setup wizard goes only after the chat window exists, so the last window never closes in between.
	if (wizardWindow) {
		const w = wizardWindow;
		wizardWindow = null;
		w.close();
	}
	// First update check AFTER the window exists (the downloaded-banner
	// push needs a listener); dev builds no-op (no autoUpdater).
	if (autoUpdater) {
		checkForUpdates();
		setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	}
}