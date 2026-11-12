"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PAIR_PATH } from "@/src/core/ui/hub-auth";

/**
 * Single-Mac mode on the client (work-wolfpack-TdmbaV4). The desktop preload exposes `window.wolfpack.singleMac === true` when the
 * app runs its own runtime; the server-side gate (proxy.ts, env-driven) is the real one, this only hides the UI. The root layout
 * stays static: nothing here is read on the server, so the owner's console is built and served exactly as before.
 *
 * Dev only (a `next dev` slot has no desktop bridge): open any page with `?singleMac=1` to force it (remembered for the tab's
 * session), `?singleMac=0` to clear. The branch is dead code in a production build.
 */
export function readSingleMac(): boolean {
	if (typeof window === "undefined") return false;
	if (process.env.NODE_ENV === "development") {
		const q = new URLSearchParams(window.location.search).get("singleMac");
		if (q === "1") window.sessionStorage.setItem("wolfpack.dev.singleMac", "1");
		else if (q === "0") window.sessionStorage.removeItem("wolfpack.dev.singleMac");
		if (window.sessionStorage.getItem("wolfpack.dev.singleMac") === "1") return true;
	}
	return (window as unknown as { wolfpack?: { singleMac?: boolean } }).wolfpack?.singleMac === true;
}

/** null until the client has read the bridge; then the answer. */
const SingleMacContext = createContext<boolean | null>(null);

export function SingleMacProvider({ children }: { children: ReactNode }) {
	const [value, setValue] = useState<boolean | null>(null);
	useEffect(() => setValue(readSingleMac()), []);
	return <SingleMacContext.Provider value={value}>{children}</SingleMacContext.Provider>;
}

/** True only inside the single-Mac app. */
export const useSingleMac = (): boolean => useContext(SingleMacContext) === true;
/** True once the flag is known to be OFF: gate anything that fetches multi-machine routes on this, so nothing fetches before the answer. */
export const useMultiMachine = (): boolean => useContext(SingleMacContext) === false;

/** A 401 from the hub. A paired browser goes to /pair; the single-Mac app has no /pair (it redirects home, which would loop), so it says so. */
export function leaveOnUnauthorized(): void {
	if (readSingleMac()) {
		if (document.getElementById("single-mac-auth-error")) return;
		const el = document.createElement("div");
		el.id = "single-mac-auth-error";
		el.setAttribute("role", "alert");
		el.className = "fixed inset-x-0 top-0 z-[100] bg-destructive px-4 py-2 text-center text-sm text-white";
		el.textContent = "Wolfpack couldn't sign in to its own services. Quit and reopen the app.";
		document.body.appendChild(el);
		return;
	}
	if (!window.location.pathname.startsWith(PAIR_PATH)) window.location.assign(PAIR_PATH);
}
