/**
 * The Preview window (work-wolfpack-G3rhXV0). `wolfpack preview` serves a live console on loopback; this opens it in its OWN
 * BrowserWindow so the main window stays on the stable console and a broken edit can never take it away.
 *
 * Source of truth: ~/.wolfpack/preview/state.json, which every preview path already writes (the CLI, the detached helper, `off`
 * deletes it). Watching it needs no second file to keep in step and survives a crashed CLI; a preview already running at launch is
 * found by the first read. fs.watch on the directory gives the latency, a poll covers missed events.
 *
 * Electron is injected, so this is unit-tested without it (preview-window.test.ts). The main window is never touched: nothing here
 * enumerates windows, and `isPreviewWindow` lets main.cjs skip this one when it looks for "the" window.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseConsoleUrl } = require("./remote.cjs");

const PARTITION = "persist:wolfpack-preview"; // its own cookies, pairing and storage
const defaultStateFile = () => path.join(os.homedir(), ".wolfpack", "preview", "state.json");
/** Phases in which the preview console answers: after the helper's deep check, or a dev console. */
const LIVE_PHASES = new Set(["running", "dev"]);

/** `feat/` dropped, a long slug cut to the id and two words, a worker's copy by its worker name. Mirrors `wolfpack preview`'s picker. */
function shortName(raw) {
	const worker = /--(.+)-[0-9a-f]{8}$/.exec(raw);
	if (worker) return `${worker[1]} (worker)`;
	const b = raw.replace(/^feat[/-]/, "");
	const parts = b.split("-");
	return parts.length > 3 ? `${parts.slice(0, 3).join("-")}…` : b;
}

/** → { running: false } | { running: true, url, name }. The url goes through remote.cjs' validation (loopback http only here). */
function readPreview(stateFile = defaultStateFile()) {
	let s;
	try {
		s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	} catch {
		return { running: false };
	}
	if (!s || !s.console || !LIVE_PHASES.has(s.phase)) return { running: false };
	const parsed = parseConsoleUrl(`http://127.0.0.1:${s.consolePort ?? 3230}`);
	if (!parsed.ok) return { running: false };
	const raw = s.previewRef || s.worktree || s.console.dir;
	return { running: true, url: parsed.url, name: shortName(typeof raw !== "string" ? "preview" : raw.startsWith("/") ? path.basename(raw) : raw) };
}

const noPreviewHtml = () =>
	`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Preview</title>
<style>body{background:#141414;color:#e5e5e5;font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
body::before{content:"";position:fixed;top:0;left:0;right:0;height:4px;background:#6b7280}</style>
<div style="text-align:center"><p><b>No preview running</b></p><p style="color:#9ca3af">Start one with <code>wolfpack preview</code>. This window opens it by itself.</p></div>`)}`;

const STRIP_CSS = 'html::before{content:"";position:fixed;top:0;left:0;right:0;height:4px;background:#f59e0b;z-index:2147483647;pointer-events:none}';

function createPreviewController({
	electron,
	stateFile = defaultStateFile(),
	pollMs = 2000,
	watch = (dir, fn) => fs.watch(dir, fn),
	setInterval: setIv = setInterval,
	clearInterval: clearIv = clearInterval,
	onChange = () => {},
	log = () => {},
}) {
	const { BrowserWindow } = electron;
	let win = null;
	let last = null; // the last state read
	let failed = false; // the window shows the fallback because the url could not load
	let watcher = null;
	let timer = null;
	const alive = () => win && !win.isDestroyed();

	const titleFor = (p) => `Preview · ${p.running ? p.name : "none"}`;

	function ensureWindow(p) {
		if (alive()) return false;
		win = new BrowserWindow({
			width: 1280,
			height: 860,
			title: titleFor(p),
			backgroundColor: "#141414",
			webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
		});
		win.on("page-title-updated", (e) => e.preventDefault()); // keep "Preview · …" whatever the page says
		win.on("closed", () => {
			win = null;
		});
		win.webContents.on("did-finish-load", () => {
			if (!failed && last?.running) win.webContents.insertCSS(STRIP_CSS);
		});
		win.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
			if (code === -3 || isMainFrame === false) return; // aborted navigation / a sub-frame
			failed = true;
			if (alive()) void win.loadURL(noPreviewHtml());
		});
		return true;
	}

	function show(p) {
		const created = ensureWindow(p);
		win.setTitle(titleFor(p));
		failed = false;
		void win.loadURL(p.url);
		return created;
	}

	function refresh() {
		const p = readPreview(stateFile);
		const prev = last;
		last = p;
		if (!prev || prev.running !== p.running) onChange(p.running);
		if (p.running) {
			const started = !prev?.running;
			if (started || prev.url !== p.url) {
				const created = show(p);
				if (!created && started) win.focus();
			} else if (prev.name !== p.name) {
				if (alive()) win.setTitle(titleFor(p));
			} else if (failed && alive()) {
				failed = false;
				void win.loadURL(p.url); // the server is back (or the state still says running): try again
			}
		} else if (prev?.running && alive()) {
			failed = false;
			win.setTitle(titleFor(p));
			void win.loadURL(noPreviewHtml());
		}
		return p;
	}

	/** Window → Open Preview: focus the window, or open it again after it was closed. No-op when nothing runs. */
	function open() {
		const p = last?.running ? last : refresh();
		if (!p.running) return false;
		if (alive()) {
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		} else show(p);
		return true;
	}

	function start() {
		refresh();
		try {
			watcher = watch(path.dirname(stateFile), () => refresh());
			watcher?.on?.("error", () => {}); // the poll still runs
		} catch (e) {
			log(`preview watch unavailable (${e.message}); polling every ${pollMs} ms`);
		}
		timer = setIv(() => refresh(), pollMs);
		timer?.unref?.();
	}

	function stop() {
		try {
			watcher?.close();
		} catch {}
		if (timer) clearIv(timer);
		watcher = null;
		timer = null;
	}

	/** An Electron menu item, rebuilt each time the application menu is installed. */
	const menuItem = () => ({ label: "Open Preview", accelerator: "Alt+CommandOrControl+P", enabled: !!last?.running, click: () => open() });

	return { start, stop, refresh, open, menuItem, isRunning: () => !!last?.running, isPreviewWindow: (w) => !!w && w === win };
}

module.exports = { createPreviewController, readPreview, noPreviewHtml, PARTITION };
