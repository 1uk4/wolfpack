import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { createPreviewController, readPreview } = createRequire(import.meta.url)("./preview-window.cjs");

let dir: string;
let stateFile: string;
const setState = (s: unknown) => fs.writeFileSync(stateFile, JSON.stringify(s));
const live = (over: Record<string, unknown> = {}) => ({ phase: "running", previewRef: "feat/yu741qH-floating-chat-bar-talk", consolePort: 3230, console: { mode: "dev", dir: "/w/x" }, ...over });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "prevwin-"));
	stateFile = path.join(dir, "state.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Electron stand-in: records windows, never opens anything. */
class FakeWindow {
	static all: FakeWindow[] = [];
	opts: Record<string, any>;
	loaded: string[] = [];
	title = "";
	focused = 0;
	destroyed = false;
	css: string[] = [];
	handlers: Record<string, (...a: any[]) => void> = {};
	webContents = {
		handlers: {} as Record<string, (...a: any[]) => void>,
		on: (ev: string, fn: (...a: any[]) => void) => void (this.webContents.handlers[ev] = fn),
		insertCSS: (c: string) => void this.css.push(c),
	};
	constructor(opts: Record<string, any>) {
		this.opts = opts;
		this.title = opts.title ?? "";
		FakeWindow.all.push(this);
	}
	loadURL(u: string) {
		this.loaded.push(u);
		return Promise.resolve();
	}
	setTitle(t: string) {
		this.title = t;
	}
	on(ev: string, fn: (...a: any[]) => void) {
		this.handlers[ev] = fn;
	}
	isDestroyed() {
		return this.destroyed;
	}
	isMinimized() {
		return false;
	}
	show() {}
	focus() {
		this.focused++;
	}
}

const make = () => {
	FakeWindow.all = [];
	const changes: boolean[] = [];
	const watchers: (() => void)[] = [];
	const ticks: (() => void)[] = [];
	const c = createPreviewController({
		electron: { BrowserWindow: FakeWindow },
		stateFile,
		watch: (_d: string, fn: () => void) => (watchers.push(fn), { close() {} }),
		setInterval: (fn: () => void) => (ticks.push(fn), 1),
		clearInterval: () => {},
		onChange: (running: boolean) => changes.push(running),
		log: () => {},
	});
	return { c, changes, watchers, ticks };
};

describe("readPreview", () => {
	it("is running only for a started preview with a console, and names it shortly", () => {
		expect(readPreview(stateFile)).toEqual({ running: false }); // no state file
		setState(live());
		expect(readPreview(stateFile)).toEqual({ running: true, url: "http://127.0.0.1:3230/", name: "yu741qH-floating-chat…" });
		setState(live({ previewRef: undefined, console: { mode: "dev", dir: "/w/feat-yu741qH-x--detach-chat-30b2c6aa" } }));
		expect(readPreview(stateFile)).toMatchObject({ running: true, name: "detach-chat (worker)" });
		for (const bad of [{ phase: "switching" }, { phase: "rolled-back" }, { phase: "unhealthy" }, { console: undefined }]) {
			setState(live(bad));
			expect(readPreview(stateFile).running).toBe(false);
		}
		setState(live({ consolePort: "80@evil.example" })); // the url goes through remote.cjs' validation
		expect(readPreview(stateFile).running).toBe(false);
	});
});

describe("preview window", () => {
	it("opens at launch for a preview that is already running, in its own session with a labelled title and strip", () => {
		setState(live());
		const { c } = make();
		c.start();
		expect(FakeWindow.all.length).toBe(1);
		const w = FakeWindow.all[0];
		expect(w.opts.webPreferences.partition).toBe("persist:wolfpack-preview");
		expect(w.title).toBe("Preview · yu741qH-floating-chat…");
		expect(w.loaded).toEqual(["http://127.0.0.1:3230/"]);
		w.webContents.handlers["did-finish-load"]();
		expect(w.css.join("")).toContain("position:fixed"); // the coloured strip, so it cannot be mistaken for the main window
		const prevented: boolean[] = [];
		w.handlers["page-title-updated"]({ preventDefault: () => prevented.push(true) });
		expect(prevented).toEqual([true]); // the page cannot rename it
	});

	it("opens when a preview starts later, then reuses and retitles the one window when the worktree changes", () => {
		const { c, changes } = make();
		c.start();
		expect(FakeWindow.all.length).toBe(0);
		setState(live());
		c.refresh();
		expect(FakeWindow.all.length).toBe(1);
		expect(changes).toEqual([false, true]);
		setState(live({ previewRef: "feat/a" }));
		c.refresh();
		expect(FakeWindow.all.length).toBe(1);
		expect(FakeWindow.all[0].title).toBe("Preview · a");
		c.open();
		expect(FakeWindow.all[0].focused).toBe(1);
	});

	it("shows 'No preview running' on off and when the server is down, then comes back when it answers again", () => {
		setState(live());
		const { c } = make();
		c.start();
		const w = FakeWindow.all[0];
		fs.rmSync(stateFile);
		c.refresh();
		expect(decodeURIComponent(w.loaded.at(-1)!)).toContain("No preview running");
		expect(w.title).toBe("Preview · none");
		setState(live());
		c.refresh();
		expect(w.loaded.at(-1)).toBe("http://127.0.0.1:3230/");
		w.webContents.handlers["did-fail-load"]({}, -102, "refused", "http://127.0.0.1:3230/", true);
		expect(decodeURIComponent(w.loaded.at(-1)!)).toContain("No preview running");
		c.refresh(); // the poll finds the state still running: try the url again
		expect(w.loaded.at(-1)).toBe("http://127.0.0.1:3230/");
	});

	it("follows the state file through the watcher and the poll, and the menu item is enabled only while a preview runs", () => {
		const { c, watchers, ticks } = make();
		c.start();
		const item = () => c.menuItem();
		expect(item()).toMatchObject({ label: "Open Preview", accelerator: "Alt+CommandOrControl+P", enabled: false });
		setState(live());
		watchers[0]();
		expect(FakeWindow.all.length).toBe(1);
		expect(item().enabled).toBe(true);
		fs.rmSync(stateFile);
		ticks[0]();
		expect(item().enabled).toBe(false);
		setState(live());
		ticks[0]();
		FakeWindow.all[0].destroyed = true; // the owner closed the window
		item().click();
		expect(FakeWindow.all.length).toBe(2);
		expect(c.isPreviewWindow(FakeWindow.all[1])).toBe(true);
		expect(c.isPreviewWindow({})).toBe(false);
	});
});
