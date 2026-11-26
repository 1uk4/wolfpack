"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { AppUpdaterEvent } from "@wolfpack/protocol/update-state";
import { readSingleMac } from "@/components/shell/single-mac";

/**
 * The desktop app's `window.wolfpack.app` bridge (apps/desktop/electron/preload.cjs), present only when the app runs its own runtime
 * (work-wolfpack-B97I0Gv). Every call answers `{ ok }` or `{ ok:false, error }`; the API key goes in and never comes back.
 */
export interface Result {
	ok: boolean;
	error?: string;
	/** The owner said Cancel in the native confirm: not an error. */
	cancelled?: boolean;
	/** Shown with a success, e.g. when memory tidying waits for the next launch. */
	note?: string;
}
export interface UpdateChannelState {
	available: boolean;
	channel: "stable" | "main";
	/** Remote mode / dev build: why the switch is hidden. */
	note?: string;
	/** Shown after picking stable while running a main build. */
	returnNote?: string;
}
export interface AppBridge {
	/**
	 * True when the app's window shows another machine's console (remote mode): the bridge then carries only the update calls and
	 * updateChannel; folders, key, reset and the rest are absent and must not be called (work-wolfpack-byIU7oz).
	 */
	remote?: boolean;
	folders(): Promise<{ state: string; wolves: string; logs?: string }>;
	showFolder(name: "state" | "wolves" | "logs"): Promise<Result>;
	loginItem: {
		get(): Promise<{ openAtLogin: boolean; needsApproval: boolean }>;
		set(on: boolean): Promise<{ openAtLogin: boolean; needsApproval: boolean; error?: string }>;
	};
	changeKey(key: string): Promise<Result>;
	copyDiagnostics(): Promise<Result>;
	reset(): Promise<Result>;
	/** This device > App updates (work-wolfpack-JIIInfm): the stable/main switch for the app's own updater; older apps lack it. */
	updateChannel?: {
		get(): Promise<UpdateChannelState>;
		set(channel: "stable" | "main"): Promise<UpdateChannelState & Result>;
		checkMain(): Promise<{ ahead: string | null; upToDate: boolean; error?: string }>;
	};
	/** This device > Reset app: stops the wolves, moves Chromium cache folders to the Trash and relaunches (older apps lack it). */
	resetAppUi?(): Promise<Result>;
	/** Pack > Machines: ask the app's updater now (main shows its own up-to-date / couldn't-check dialog). Older apps lack it. */
	checkForUpdates?(): Promise<Result>;
	/** Pushes every updater step (raw AppUpdaterEvent JSON; the downloaded step also has status:"downloaded"); returns the unsubscribe. */
	onUpdateStatus?(cb: (s: AppUpdaterEvent & { status?: string }) => void): () => void;
	/** The last updater step, or null: seeds a window opened mid-download. */
	getUpdateState?(): Promise<(AppUpdaterEvent & { status?: string }) | null>;
	/** Quit and install the staged update. */
	installUpdate?(): void;
}

/** Tests provide a bridge (or null) here; undefined means "read window". */
export const AppBridgeContext = createContext<AppBridge | null | undefined>(undefined);

/** Dev only: a browser with `?singleMac=1` has no desktop bridge, so the tab runs on this in-memory stand-in. */
function devStub(): AppBridge {
	let login = false;
	return {
		folders: async () => ({ state: "~/Library/Application Support/Wolfpack", wolves: "~/Wolves", logs: "~/Library/Application Support/Wolfpack/logs" }),
		showFolder: async () => ({ ok: true }),
		loginItem: {
			get: async () => ({ openAtLogin: login, needsApproval: false }),
			set: async (on) => ((login = on), { openAtLogin: login, needsApproval: false }),
		},
		changeKey: async (key) => (key.trim() === "bad" ? { ok: false, error: "That key didn't work" } : { ok: true }),
		copyDiagnostics: async () => ({ ok: true }),
		reset: async () => ({ ok: false, error: "Reset does nothing in the browser preview." }),
		resetAppUi: async () => ({ ok: false, error: "Reset does nothing in the browser preview." }),
		updateChannel: {
			get: async () => ({ available: true, channel: "stable" }),
			set: async (channel) => ({ ok: true, available: true, channel }),
			checkMain: async () => ({ ahead: "0.4.1-main.1", upToDate: false }),
		},
		checkForUpdates: async () => ({ ok: true }),
		onUpdateStatus: () => () => {},
		getUpdateState: async () => devUpdateStep(),
		installUpdate: () => {},
	};
}

/** Dev only, with `?singleMac=1`: `&appUpdate=checking|progress|ready|installing|failed` seeds the stand-in's updater step so every stage can be seen in a browser (kept for the tab like singleMac; `appUpdate=none` clears it). */
function devUpdateStep(): (AppUpdaterEvent & { status?: string }) | null {
	const key = "wolfpack.dev.appUpdate";
	const q = new URLSearchParams(window.location.search).get("appUpdate");
	if (q === "none") window.sessionStorage.removeItem(key);
	else if (q) window.sessionStorage.setItem(key, q);
	switch (window.sessionStorage.getItem(key)) {
		case "checking":
			return { type: "checking" };
		case "progress":
			return { type: "progress", percent: 42 };
		case "ready":
			return { type: "downloaded", version: "0.4.2", status: "downloaded" };
		case "installing":
			return { type: "installing" };
		case "failed":
			return { type: "error", message: "net::ERR_INTERNET_DISCONNECTED" };
		default:
			return null;
	}
}

/** Dev only: `?appRemote=1` shows the desktop app's remote mode (kept for the tab; `?appRemote=0` clears), combined with `&appUpdate=<stage>`. */
function readDevAppRemote(): boolean {
	if (process.env.NODE_ENV !== "development") return false;
	const key = "wolfpack.dev.appRemote";
	const q = new URLSearchParams(window.location.search).get("appRemote");
	if (q === "1") window.sessionStorage.setItem(key, "1");
	else if (q === "0") window.sessionStorage.removeItem(key);
	return window.sessionStorage.getItem(key) === "1";
}

function readBridge(): AppBridge | null {
	const real = (window as unknown as { wolfpack?: { app?: AppBridge } }).wolfpack?.app;
	if (real) return real;
	if (process.env.NODE_ENV !== "development") return null;
	if (readDevAppRemote()) {
		const { checkForUpdates, onUpdateStatus, getUpdateState, installUpdate } = devStub();
		return { remote: true, checkForUpdates, onUpdateStatus, getUpdateState, installUpdate, updateChannel: { get: async () => ({ available: false, channel: "stable", note: "This console is served by another machine, so its app updates are set there." }), set: async (channel) => ({ ok: false, available: false, channel }), checkMain: async () => ({ ahead: null, upToDate: false }) } } as AppBridge;
	}
	return readSingleMac() ? devStub() : null;
}

export function useAppBridge(): AppBridge | null {
	const ctx = useContext(AppBridgeContext);
	const [found, setFound] = useState<AppBridge | null>(null);
	useEffect(() => setFound(readBridge()), []);
	return ctx === undefined ? found : ctx;
}
