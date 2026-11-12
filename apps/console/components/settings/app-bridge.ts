"use client";
import { createContext, useContext, useEffect, useState } from "react";
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
}
export interface AppBridge {
	folders(): Promise<{ state: string; wolves: string }>;
	showFolder(name: "state" | "wolves"): Promise<Result>;
	loginItem: {
		get(): Promise<{ openAtLogin: boolean; needsApproval: boolean }>;
		set(on: boolean): Promise<{ openAtLogin: boolean; needsApproval: boolean; error?: string }>;
	};
	changeKey(key: string): Promise<Result>;
	copyDiagnostics(): Promise<Result>;
	reset(): Promise<Result>;
}

/** Tests provide a bridge (or null) here; undefined means "read window". */
export const AppBridgeContext = createContext<AppBridge | null | undefined>(undefined);

/** Dev only: a browser with `?singleMac=1` has no desktop bridge, so the tab runs on this in-memory stand-in. */
function devStub(): AppBridge {
	let login = false;
	return {
		folders: async () => ({ state: "~/Library/Application Support/Wolfpack", wolves: "~/Wolves" }),
		showFolder: async () => ({ ok: true }),
		loginItem: {
			get: async () => ({ openAtLogin: login, needsApproval: false }),
			set: async (on) => ((login = on), { openAtLogin: login, needsApproval: false }),
		},
		changeKey: async (key) => (key.trim() === "bad" ? { ok: false, error: "That key didn't work" } : { ok: true }),
		copyDiagnostics: async () => ({ ok: true }),
		reset: async () => ({ ok: false, error: "Reset does nothing in the browser preview." }),
	};
}

function readBridge(): AppBridge | null {
	const real = (window as unknown as { wolfpack?: { app?: AppBridge } }).wolfpack?.app;
	if (real) return real;
	return process.env.NODE_ENV === "development" && readSingleMac() ? devStub() : null;
}

export function useAppBridge(): AppBridge | null {
	const ctx = useContext(AppBridgeContext);
	const [found, setFound] = useState<AppBridge | null>(null);
	useEffect(() => setFound(readBridge()), []);
	return ctx === undefined ? found : ctx;
}
