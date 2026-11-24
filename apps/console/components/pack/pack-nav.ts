"use client";

/**
 * Opening the Pack page (work-wolfpack-oz3wvq3). The Pack is the page /pack/<section>; every opener (gear, shortcut, dictation's
 * "add a key", the health bar, a ?pack= link) calls openPackPage(section). The app shell registers the router here
 * (PackHealthHost), so plain functions like dictation's can navigate. The page you left is kept in sessionStorage
 * (`wp.pack.return`) and the page's close button goes back to it.
 */
import type { PackSectionId } from "@/src/core";

export const PACK_RETURN_KEY = "wp.pack.return";

let navigate: ((href: string) => void) | null = null;
export function setPackNavigator(fn: ((href: string) => void) | null): void {
	navigate = fn;
}

/** Remember where to go on close, unless we are already inside the Pack (moving between sections keeps the first page). */
export function rememberPackReturn(path: string): void {
	try {
		if (path === "/pack" || path.startsWith("/pack/")) return;
		window.sessionStorage.setItem(PACK_RETURN_KEY, path);
	} catch {
		// storage blocked: close falls back to "/"
	}
}

export function readPackReturn(): string {
	try {
		const p = window.sessionStorage.getItem(PACK_RETURN_KEY);
		return p && p.startsWith("/") && !p.startsWith("//") ? p : "/";
	} catch {
		return "/";
	}
}

export function openPackPage(section: PackSectionId = "machines"): void {
	if (typeof window === "undefined") return;
	rememberPackReturn(window.location.pathname + window.location.search);
	const href = `/pack/${section}`;
	if (navigate) navigate(href);
	else window.location.assign(href);
}
